// The service worker's extension backend (docs/extensions.md): one per
// scope, shared by every controller of it as the cookie jar is. It keeps
// the installed extensions (store.ts), reads their manifests and locales
// once per worker start, answers what the controllers ask of them
// (install, list, enable, remove, update) and what their contexts ask
// (chrome.storage, dynamic rules, registered content scripts, cookies,
// management), and tells the request path which content scripts a document
// gets (contentScripts.ts), what an extension origin answers (serve.ts),
// which webRequest listeners want a request (webRequest.ts) and what the
// declarativeNetRequest rules make of it (each server's DnrHost, src/server/dnr.ts,
// which it installs the rulesets into and whose state it keeps).
import { utf8Bytes } from '../../byteString';
import {
	getMessage,
	localeChain,
	localize,
	normalizeMessages,
	parseLooseJson,
	pickIcon,
	specialMessages,
	type Messages,
} from '../../extensions/manifest';
import { hostPermitted, matchesAny } from '../../extensions/match';
import {
	cleanPath,
	displayExtensionURL,
	extensionOrigin,
	extensionURL,
} from '../../extensions/origin';
import {
	ExtensionError,
	type ExtensionCommand,
	type ExtensionInfo,
	type ExtensionsChange,
	type Manifest,
	type RunAt,
	type ShippedExtension,
	type World,
} from '../../extensions/types';
import { EXTENSION_BUS_PREFIX } from '../../transport/messages';
import type Cookies from '../Cookies';
import type { DnrExtension, DnrHost } from '../dnr';
import {
	readPackage,
	readUnpacked,
	webStoreDownload,
	webStoreId,
	type ReadPackage,
} from './packages';
import {
	extensionState,
	files,
	mimeOf,
	records,
	storageAreas,
	type StoredExtension,
} from './store';

/** a content_scripts entry, or a scripting registration, as the worker matches it */
export interface ScriptEntry {
	key: string;
	matches: string[];
	excludeMatches: string[];
	includeGlobs: string[];
	excludeGlobs: string[];
	js: string[];
	css: string[];
	runAt: RunAt;
	allFrames: boolean;
	world: World;
	/** a scripting registration's id */
	id?: string;
	persistAcrossSessions?: boolean;
}

/** an extension as the worker holds it while it runs */
export interface Loaded {
	record: StoredExtension;
	/** the manifest, localized */
	manifest: Manifest;
	catalogs: Messages[];
	uiLocale: string;
	granted: Set<string>;
	/** may block in webRequest */
	blocking: boolean;
	entries: ScriptEntry[];
	/** scripting.registerContentScripts' entries (persisted ones are in the state store) */
	registered: ScriptEntry[];
	/** userScripts.register's entries, and configureWorld's worlds (both persisted) */
	userScripts: ScriptEntry[];
	worlds: Record<string, unknown>[];
	/** web_accessible_resources: path patterns and the pages they are for (none: any) */
	accessible: { paths: RegExp[]; matches: string[] | null }[];
	/** chrome.storage's areas, read once */
	areas: Map<string, Record<string, unknown>>;
	/** the icon as a data: URL (or its URL when it is large) */
	iconUrl: string | null;
	warnings: string[];
	/** the entries' source text, read once */
	sources: Map<string, string>;
	/** storage.session.setAccessLevel let content scripts in */
	sessionOpen: boolean;
}

/** the reply of a call into the backend */
export type BackendAnswer = unknown;

const STORAGE_AREAS = ['local', 'sync', 'session', 'managed'];
const ICON_INLINE_MAX = 64 * 1024;
/** permissions that let an extension's code into pages it has host access to */
const INJECTING = ['scripting', 'tabs', 'activeTab'];
/** how long a navigation the host announced waits for its request */
const EXPECTED_MS = 5000;

/** a navigation's URL as the worker sees it, without its fragment */
function navigationKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		return parsed.href;
	} catch (error) {
		return url.split('#')[0];
	}
}

const copy = <T>(value: T): T =>
	value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

/** a web_accessible_resources path glob as a RegExp over a clean path */
function resourceGlob(glob: string): RegExp {
	return new RegExp(
		`^${cleanPath(glob)
			.split('*')
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*')}$`,
	);
}

function manifestEntries(manifest: Manifest): ScriptEntry[] {
	return (manifest.content_scripts ?? []).map((entry, index) => ({
		key: `m${index}`,
		matches: entry.matches ?? [],
		excludeMatches: entry.exclude_matches ?? [],
		includeGlobs: entry.include_globs ?? [],
		excludeGlobs: entry.exclude_globs ?? [],
		js: (entry.js ?? []).map(cleanPath),
		css: (entry.css ?? []).map(cleanPath),
		runAt: entry.run_at ?? 'document_idle',
		allFrames: !!entry.all_frames,
		world: entry.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
	}));
}

/** a scripting registration (RegisteredContentScript) as an entry */
export function registrationEntry(
	script: Record<string, unknown>,
): ScriptEntry {
	const id = String(script.id ?? '');
	if (!id || id.startsWith('_'))
		throw new ExtensionError(
			'bad-source',
			`Invalid content script id ${JSON.stringify(id)}.`,
		);
	return {
		key: `r${[...utf8Bytes(id)].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`,
		id,
		matches: (script.matches as string[]) ?? [],
		excludeMatches: (script.excludeMatches as string[]) ?? [],
		includeGlobs: [],
		excludeGlobs: [],
		js: ((script.js as string[]) ?? []).map(cleanPath),
		css: ((script.css as string[]) ?? []).map(cleanPath),
		runAt: (script.runAt as RunAt) ?? 'document_idle',
		allFrames: !!script.allFrames,
		world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
		persistAcrossSessions: script.persistAcrossSessions !== false,
	};
}

/** a user script's code as an entry's js item carries it (registry.source) */
const CODE_SOURCE = '\0code:';

/** a userScripts.register script as an entry */
export function userScriptEntry(script: Record<string, unknown>): ScriptEntry {
	const id = String(script.id ?? '');
	if (!id || id.startsWith('_'))
		throw new ExtensionError(
			'bad-source',
			`Invalid user script id ${JSON.stringify(id)}.`,
		);
	const js = ((script.js as { file?: string; code?: string }[]) ?? []).map(
		(source) =>
			typeof source?.code === 'string'
				? `${CODE_SOURCE}${source.code}`
				: cleanPath(String(source?.file ?? '')),
	);
	return {
		key: `u${[...utf8Bytes(id)].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`,
		id,
		matches: (script.matches as string[]) ?? [],
		excludeMatches: (script.excludeMatches as string[]) ?? [],
		includeGlobs: (script.includeGlobs as string[]) ?? [],
		excludeGlobs: (script.excludeGlobs as string[]) ?? [],
		js,
		css: [],
		runAt: (script.runAt as RunAt) ?? 'document_idle',
		allFrames: !!script.allFrames,
		world: script.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
	};
}

/** a user script as userScripts.getScripts answers it */
function userScriptOf(entry: ScriptEntry) {
	return {
		id: entry.id,
		matches: entry.matches,
		excludeMatches: entry.excludeMatches,
		includeGlobs: entry.includeGlobs,
		excludeGlobs: entry.excludeGlobs,
		js: entry.js.map((path) =>
			path.startsWith(CODE_SOURCE)
				? { code: path.slice(CODE_SOURCE.length) }
				: { file: path },
		),
		runAt: entry.runAt,
		allFrames: entry.allFrames,
		world: entry.world,
	};
}

/** a registration as scripting.getRegisteredContentScripts answers it */
function registrationOf(entry: ScriptEntry) {
	return {
		id: entry.id,
		matches: entry.matches,
		excludeMatches: entry.excludeMatches,
		js: entry.js,
		css: entry.css,
		runAt: entry.runAt,
		allFrames: entry.allFrames,
		world: entry.world,
		persistAcrossSessions: entry.persistAcrossSessions !== false,
	};
}

export class ExtensionRegistry {
	#loaded = new Map<string, Loaded>();
	#ready: Promise<void> | null = null;
	#listeners = new Set<(change: ExtensionsChange) => void>();
	/** every server's declarativeNetRequest engine (one per controller of the scope) */
	#dnrHosts = new Set<DnrHost>();
	/** the tab of each client, as the controllers' hubs told it */
	#clientTabs = new Map<string, number>();
	/** each tab's top document, as last placed */
	#tabDocuments = new Map<number, string>();
	/** the navigations the host sent a tab on, by URL (without its fragment) */
	#expected = new Map<string, { tabId: number; at: number }>();
	/** the tabs each extension holds activeTab for (a click on its button) */
	#activeTabs = new Map<string, Set<number>>();
	/** each nested document's frame id (a tab's top document is 0) */
	#frameIds = new Map<string, number>();
	/** the next frame id: from a random start, so a worker that restarted gives no id a page still holds */
	#nextFrameId = 1 + Math.floor(Math.random() * 0x100000) * 0x400;
	/** the scope's cookie jar (createServer hands it over) */
	cookies?: Cookies;
	/** the controllers' addresses: every extension context talks on one (the worker sets it) */
	channels: () => string[] = () => [];

	/** read the installed extensions, once per worker start */
	ready(): Promise<void> {
		this.#ready ??= (async () => {
			for (const record of await records.all())
				try {
					await this.#load(record);
				} catch (error) {
					console.warn(`Stomp: extension ${record.id} could not load:`, error);
				}
			for (const host of this.#dnrHosts)
				for (const loaded of this.enabled())
					await this.#dnrInstall(loaded, host);
		})();
		return this.#ready;
	}

	/** whether any extension is installed at all (the request path's first, synchronous question) */
	get any(): boolean {
		return this.#loaded.size > 0;
	}

	/** the enabled extensions */
	*enabled(): Iterable<Loaded> {
		for (const loaded of this.#loaded.values())
			if (loaded.record.enabled) yield loaded;
	}

	get(id: string): Loaded | undefined {
		return this.#loaded.get(id);
	}

	onChange(listener: (change: ExtensionsChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(change: ExtensionsChange) {
		for (const listener of [...this.#listeners])
			try {
				listener(change);
			} catch (error) {
				// a controller that went away
			}
	}

	/**
	 * A server's declarativeNetRequest engine: every enabled extension's
	 * rulesets go in now and with every change, and what it keeps of an
	 * extension (dynamic rules, enabled rulesets) is stored with its state
	 */
	attachDnr(host: DnrHost) {
		if (this.#dnrHosts.has(host)) return;
		this.#dnrHosts.add(host);
		host.onPersist = (id, state) => {
			if (this.#loaded.has(id))
				extensionState.put(id, 'dnr', state).catch(() => {});
		};
		host.tabOf = (client) => this.#clientTabs.get(client) ?? -1;
		host.hostNavigationTab = (url) => this.#navigationTab(url);
		host.frameIdOf = (client) => this.frameIdOf(client);
		host.sameFrame = (next, previous) => {
			const id = this.#frameIds.get(previous);
			if (id !== undefined && !this.#frameIds.has(next))
				this.#keepFrameId(next, id);
		};
		host.hooks = {
			activeTabGranted: (id, tabId) =>
				this.#activeTabs.get(id)?.has(tabId) ?? false,
			badge: (id, tabId, count) =>
				this.#post(id, {
					t: 'dnr-badge',
					tabId,
					text: count > 0 ? String(count) : '',
				}),
			debug: (id, info) =>
				this.#post(id, {
					t: 'event',
					name: 'declarativeNetRequest.onRuleMatchedDebug',
					args: [info],
				}),
			validTab: (tabId) => tabId >= 0,
		};
		if (this.#ready)
			this.#ready.then(async () => {
				for (const loaded of this.enabled())
					await this.#dnrInstall(loaded, host);
			});
	}

	/** a hub told which tab a client's document is in */
	placeClient(client: string, tabId: number) {
		this.#clientTabs.set(client, tabId);
		if (this.#clientTabs.size > 4096)
			this.#clientTabs.delete(this.#clientTabs.keys().next().value!);
		// a new document in the tab ends the activeTab grants made on it
		if (this.#tabDocuments.get(tabId) !== client) {
			if (this.#tabDocuments.has(tabId))
				for (const tabs of this.#activeTabs.values()) tabs.delete(tabId);
			this.#tabDocuments.set(tabId, client);
		}
		for (const host of this.#dnrHosts) host.placed(client, tabId);
	}

	/** a document's frame id: 0 for a tab's top document, else its own, assigned on first ask */
	frameIdOf(client: string): number {
		if (this.#clientTabs.has(client)) return 0;
		let id = this.#frameIds.get(client);
		if (id === undefined) this.#keepFrameId(client, (id = this.#nextFrameId++));
		return id;
	}

	/** a frame's next document (its window said so) keeps the frame id of its last */
	linkFrame(next: string, previous: string) {
		if (this.#clientTabs.has(previous) || this.#clientTabs.has(next)) return;
		this.#keepFrameId(next, this.frameIdOf(previous));
		for (const host of this.#dnrHosts) host.linked(next, previous);
	}

	#keepFrameId(client: string, id: number) {
		this.#frameIds.set(client, id);
		if (this.#frameIds.size > 4096)
			this.#frameIds.delete(this.#frameIds.keys().next().value!);
	}

	/** the host is sending a tab to `url`: its main frame's request is that tab's */
	expectNavigation(url: string, tabId: number) {
		const key = navigationKey(url);
		this.#expected.delete(key);
		this.#expected.set(key, { tabId, at: Date.now() });
		if (this.#expected.size > 256)
			this.#expected.delete(this.#expected.keys().next().value!);
	}

	/** the tab the host sent to `url` lately (taken), -1 for none */
	#navigationTab(url: string): number {
		const key = navigationKey(url);
		const expected = this.#expected.get(key);
		if (!expected) return -1;
		this.#expected.delete(key);
		return Date.now() - expected.at <= EXPECTED_MS ? expected.tabId : -1;
	}

	/** a click on its button granted the extension activeTab for the tab */
	grantActiveTab(id: string, tabId: number) {
		if (!this.#loaded.get(id)?.granted.has('activeTab')) return;
		if (!this.#activeTabs.has(id)) this.#activeTabs.set(id, new Set());
		this.#activeTabs.get(id)!.add(tabId);
	}

	#post(id: string, message: unknown) {
		for (const channel of this.channels()) {
			const bus = new BroadcastChannel(
				`${EXTENSION_BUS_PREFIX}${channel}|${id}`,
			);
			bus.postMessage(message);
			bus.close();
		}
	}

	/** what the engine is given of an extension: its rulesets' text as the package holds it, its permissions and kept state */
	async #dnrOf(loaded: Loaded): Promise<DnrExtension | null> {
		const { granted, record } = loaded;
		const resources =
			record.manifest.declarative_net_request?.rule_resources ?? [];
		const permitted =
			granted.has('declarativeNetRequest') ||
			granted.has('declarativeNetRequestWithHostAccess');
		if (!permitted) return null;
		const rulesets: NonNullable<DnrExtension['rulesets']> = [];
		for (const resource of resources) {
			const path = cleanPath(String(resource.path ?? ''));
			rulesets.push({
				id: String(resource.id),
				enabled: !!resource.enabled,
				path,
				rules: (await files.text(record.id, path)) ?? '',
			});
		}
		return {
			id: record.id,
			installTime: record.installedAt,
			extensionBase: `${extensionOrigin(record.id)}/`,
			rulesets,
			permissions: {
				declarativeNetRequest: granted.has('declarativeNetRequest'),
				declarativeNetRequestFeedback: granted.has(
					'declarativeNetRequestFeedback',
				),
				activeTab: granted.has('activeTab'),
			},
			hostPermissions: [...granted].filter(
				(permission) =>
					permission === '<all_urls>' || permission.includes('://'),
			),
			state: (await extensionState.get(record.id, 'dnr')) as
				DnrExtension['state'] | undefined,
		};
	}

	async #dnrInstall(loaded: Loaded, host: DnrHost) {
		const extension = await this.#dnrOf(loaded);
		if (!extension) return;
		const warnings = host.install(extension);
		for (const warning of warnings)
			if (!loaded.warnings.includes(warning)) loaded.warnings.push(warning);
	}

	/** bring an extension's rules in every engine up to date: installed while it is enabled, gone otherwise */
	async #dnrSync(id: string) {
		const loaded = this.#loaded.get(id);
		for (const host of this.#dnrHosts)
			if (loaded?.record.enabled) await this.#dnrInstall(loaded, host);
			else host.uninstall(id);
	}

	// ---- loading ---------------------------------------------------------------

	async #catalogs(record: StoredExtension, uiLocale: string) {
		const catalogs: Messages[] = [];
		for (const locale of localeChain(
			record.manifest.default_locale,
			uiLocale,
		)) {
			const text = await files.text(
				record.id,
				`_locales/${locale}/messages.json`,
			);
			if (text)
				try {
					catalogs.push(normalizeMessages(parseLooseJson(text)));
				} catch (error) {
					// an unreadable catalog is no catalog
				}
		}
		return catalogs;
	}

	async #icon(id: string, path: string | null): Promise<string | null> {
		if (!path) return null;
		const response = await files.read(id, cleanPath(path));
		if (!response) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > ICON_INLINE_MAX) return extensionURL(id, path);
		return `data:${mimeOf(path)};base64,${bytesToBase64(bytes)}`;
	}

	async #load(record: StoredExtension): Promise<Loaded> {
		files.attach(record.id, record.index ?? {});
		const uiLocale = (
			(typeof navigator !== 'undefined' && navigator.language) ||
			'en-US'
		).replace('-', '_');
		const catalogs = await this.#catalogs(record, uiLocale);
		const special = specialMessages(record.id, uiLocale);
		const text = (value: string | undefined) =>
			value === undefined ? undefined : localize(value, catalogs, special);
		const raw = record.manifest;
		const action = raw.action ?? raw.browser_action ?? raw.page_action;
		// the keys Chrome localizes, and the locale it read them in (what
		// getManifest answers, measured on Chrome 157: version_name and the
		// rest stay as written)
		const commands = raw.commands;
		const omnibox = raw.omnibox as { keyword?: string } | undefined;
		const manifest: Manifest = {
			...raw,
			name: text(raw.name) ?? raw.name,
			...(raw.short_name ? { short_name: text(raw.short_name) } : {}),
			...(raw.description ? { description: text(raw.description) } : {}),
			...(raw.default_locale ? { current_locale: uiLocale } : {}),
			...(commands
				? {
						commands: Object.fromEntries(
							Object.entries(commands).map(([name, command]) => [
								name,
								typeof command?.description === 'string'
									? { ...command, description: text(command.description) }
									: command,
							]),
						),
					}
				: {}),
			...(typeof omnibox?.keyword === 'string'
				? { omnibox: { ...omnibox, keyword: text(omnibox.keyword) } }
				: {}),
			...(action?.default_title
				? {
						[raw.action
							? 'action'
							: raw.browser_action
								? 'browser_action'
								: 'page_action']: {
							...action,
							default_title: text(action.default_title),
						},
					}
				: {}),
		};
		const granted = new Set([
			...(raw.permissions ?? []),
			...(raw.host_permissions ?? []),
			...(((await extensionState.get(record.id, 'granted')) as
				string[] | undefined) ?? []),
		]);
		// MV2's host permissions sit in `permissions`
		const mv3 = Number(raw.manifest_version) >= 3;
		const blocking =
			granted.has('webRequest') &&
			(mv3 ? record.policy : granted.has('webRequestBlocking'));
		const warnings: string[] = [];
		const accessible: Loaded['accessible'] = [];
		for (const item of raw.web_accessible_resources ?? [])
			if (typeof item === 'string')
				accessible.push({ paths: [resourceGlob(item)], matches: null });
			else if (item && Array.isArray(item.resources))
				accessible.push({
					paths: item.resources.map(resourceGlob),
					matches: item.matches ?? null,
				});
		const registered = (
			((await extensionState.get(record.id, 'scripts')) as
				Record<string, unknown>[] | undefined) ?? []
		).flatMap((script) => {
			try {
				return [registrationEntry(script)];
			} catch (error) {
				return [];
			}
		});
		const loaded: Loaded = {
			record,
			manifest,
			catalogs,
			uiLocale,
			granted,
			blocking,
			entries: manifestEntries(raw),
			registered,
			userScripts: (
				((await extensionState.get(record.id, 'userScripts')) as
					Record<string, unknown>[] | undefined) ?? []
			).flatMap((script) => {
				try {
					return [userScriptEntry(script)];
				} catch (error) {
					return [];
				}
			}),
			worlds:
				((await extensionState.get(record.id, 'userScriptWorlds')) as
					Record<string, unknown>[] | undefined) ?? [],
			accessible,
			areas: this.#loaded.get(record.id)?.areas ?? new Map(),
			iconUrl: await this.#icon(
				record.id,
				pickIcon(action?.default_icon) ?? pickIcon(raw.icons),
			),
			warnings,
			sources: new Map(),
			sessionOpen: this.#loaded.get(record.id)?.sessionOpen ?? false,
		};
		for (const entry of loaded.entries)
			for (const path of [...entry.js, ...entry.css])
				if (!record.files.includes(path))
					warnings.push(`content script file ${path} is not in the package`);
		this.#loaded.set(record.id, loaded);
		return loaded;
	}

	// ---- what the controllers ask ----------------------------------------------

	info(loaded: Loaded): ExtensionInfo {
		const { record, manifest } = loaded;
		const options = manifest.options_ui?.page ?? manifest.options_page;
		const background = manifest.background;
		return {
			id: record.id,
			name: manifest.name,
			shortName: manifest.short_name ?? manifest.name,
			version: manifest.version ?? '',
			description: manifest.description ?? '',
			manifestVersion: Number(manifest.manifest_version) || 2,
			enabled: record.enabled,
			policy: record.policy,
			installedAt: record.installedAt,
			updatedAt: record.updatedAt,
			source: record.source,
			webStoreId: record.webStoreId,
			iconUrl: loaded.iconUrl,
			optionsUrl: options ? extensionURL(record.id, cleanPath(options)) : null,
			hasAction: !!(
				manifest.action ??
				manifest.browser_action ??
				manifest.page_action
			),
			permissions: [...loaded.granted].filter(
				(permission) =>
					permission !== '<all_urls>' && !permission.includes('://'),
			),
			hostPermissions: [...loaded.granted].filter(
				(permission) =>
					permission === '<all_urls>' || permission.includes('://'),
			),
			contentScripts: loaded.entries.length,
			background: background?.service_worker
				? 'service_worker'
				: background?.page || background?.scripts?.length
					? 'page'
					: 'none',
			manifest: copy(manifest),
			warnings: [...loaded.warnings],
		};
	}

	/** what a context is told of its extension */
	shipped(loaded: Loaded): ShippedExtension {
		return {
			id: loaded.record.id,
			name: loaded.manifest.name,
			version: loaded.manifest.version ?? '',
			manifestVersion: Number(loaded.manifest.manifest_version) || 2,
			origin: extensionOrigin(loaded.record.id),
			manifest: loaded.manifest,
			messages: loaded.catalogs,
			uiLocale: loaded.uiLocale,
			permissions: [...loaded.granted],
			blocking: loaded.blocking,
			generation: loaded.record.generation,
			...(loaded.worlds.some((world) => !world.worldId && world.messaging)
				? { userScriptMessaging: true }
				: {}),
		};
	}

	#found(id: string): Loaded {
		const loaded = this.#loaded.get(id);
		if (!loaded)
			throw new ExtensionError(
				'not-found',
				`No extension with id ${id} is installed.`,
			);
		return loaded;
	}

	/**
	 * Install (or update in place) from a command. `download` fetches a URL
	 * through the controller's transport (the Web Store).
	 */
	async install(
		command: Extract<ExtensionCommand, { op: 'install' }>,
		download: (url: string) => Promise<Uint8Array>,
	): Promise<ExtensionInfo> {
		await this.ready();
		let read: ReadPackage;
		let source: StoredExtension['source'] = 'package';
		let storeId: string | null = null;
		let filename = command.filename || 'extension.crx';
		if (command.webStore !== undefined) {
			storeId = webStoreId(command.webStore);
			if (!storeId)
				throw new ExtensionError(
					'bad-source',
					`${JSON.stringify(command.webStore)} is neither an extension id nor a Chrome Web Store URL.`,
				);
			const chrome =
				/Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '157.0.0.0';
			let bytes: Uint8Array;
			try {
				bytes = await download(webStoreDownload(storeId, chrome));
			} catch (error) {
				throw new ExtensionError(
					'webstore',
					`The Chrome Web Store download of ${storeId} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			filename = `${storeId}.crx`;
			source = 'webstore';
			read = await readPackage(bytes, filename);
		} else if (command.files) {
			source = 'unpacked';
			read = await readUnpacked(command.files, command.filename || 'unpacked');
		} else if (command.bytes) {
			read = await readPackage(new Uint8Array(command.bytes), filename);
		} else
			throw new ExtensionError('bad-source', 'Nothing to install was given.');
		return this.#store(read, {
			source,
			webStoreId:
				storeId ?? this.#loaded.get(read.id)?.record.webStoreId ?? null,
			filename,
			enabled: command.enabled,
			policy: command.policy,
		});
	}

	async #store(
		read: ReadPackage,
		options: {
			source: StoredExtension['source'];
			webStoreId: string | null;
			filename: string;
			enabled?: boolean;
			policy?: boolean;
		},
	): Promise<ExtensionInfo> {
		const previous =
			this.#loaded.get(read.id)?.record ?? (await records.get(read.id));
		await files.remove(read.id);
		await files.write(read.id, read.pack, read.index);
		const now = Date.now();
		const record: StoredExtension = {
			id: read.id,
			manifest: read.manifest,
			enabled: options.enabled ?? previous?.enabled ?? true,
			policy: options.policy ?? previous?.policy ?? false,
			installedAt: previous?.installedAt ?? now,
			updatedAt: now,
			source: options.source,
			webStoreId: options.webStoreId,
			filename: options.filename,
			files: Object.keys(read.index),
			index: read.index,
			...(previous?.lastRunVersion !== undefined
				? { lastRunVersion: previous.lastRunVersion }
				: {}),
			generation: (previous?.generation ?? 0) + 1,
		};
		await records.put(record);
		const loaded = await this.#load(record);
		await this.#dnrSync(record.id);
		this.#emit({ type: previous ? 'updated' : 'installed', id: read.id });
		return this.info(loaded);
	}

	async list(): Promise<ExtensionInfo[]> {
		await this.ready();
		return [...this.#loaded.values()]
			.sort((a, b) => a.record.installedAt - b.record.installedAt)
			.map((loaded) => this.info(loaded));
	}

	async infoOf(id: string): Promise<ExtensionInfo | null> {
		await this.ready();
		const loaded = this.#loaded.get(id);
		return loaded ? this.info(loaded) : null;
	}

	async setEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
		await this.ready();
		const loaded = this.#found(id);
		if (loaded.record.enabled !== enabled) {
			loaded.record = { ...loaded.record, enabled };
			await records.put(loaded.record);
			if (!enabled) this.#activeTabs.delete(id);
			await this.#dnrSync(id);
			this.#emit({ type: enabled ? 'enabled' : 'disabled', id });
		}
		return this.info(loaded);
	}

	async remove(id: string): Promise<void> {
		await this.ready();
		this.#found(id);
		this.#loaded.delete(id);
		await records.delete(id);
		await files.remove(id);
		await storageAreas.forget(id);
		await extensionState.forget(id);
		this.#activeTabs.delete(id);
		await this.#dnrSync(id);
		this.#emit({ type: 'removed', id });
	}

	/** download again from where it came: the Web Store, for one installed from there */
	async update(
		id: string,
		download: (url: string) => Promise<Uint8Array>,
	): Promise<ExtensionInfo> {
		await this.ready();
		const loaded = this.#found(id);
		const storeId = loaded.record.webStoreId;
		if (!storeId)
			throw new ExtensionError(
				'no-update',
				`${loaded.manifest.name} was not installed from the Chrome Web Store, so STomp has nowhere to update it from: install the new package over it instead.`,
			);
		return this.install({ op: 'install', webStore: storeId }, download);
	}

	/** the version the background last ran, and note this one (runtime.onInstalled) */
	async ranVersion(
		id: string,
	): Promise<{ previous: string | null; now: string }> {
		const loaded = this.#found(id);
		const now = loaded.record.manifest.version ?? '';
		const previous = loaded.record.lastRunVersion ?? null;
		if (previous !== now) {
			loaded.record = { ...loaded.record, lastRunVersion: now };
			await records.put(loaded.record);
		}
		return { previous, now };
	}

	// ---- what the request path asks ------------------------------------------

	/**
	 * Whether a document of `origin` (an extension's own) may read `url`
	 * across origins: Chrome lets an extension with host permissions read any
	 * response there, no CORS asked
	 */
	crossOriginAllowed(origin: string | null, url: URL): boolean {
		if (!origin || !this.#loaded.size) return false;
		const id = /^https:\/\/([a-p]{32})\.invalid$/.exec(origin)?.[1];
		if (!id) return false;
		const loaded = this.#loaded.get(id);
		return !!loaded?.record.enabled && hostPermitted(loaded.granted, url.href);
	}

	/** whether a page of `initiator` may load the extension's `path` (web_accessible_resources) */
	accessible(loaded: Loaded, path: string, initiator: string | null): boolean {
		return loaded.accessible.some(
			(item) =>
				item.paths.some((re) => re.test(path)) &&
				(item.matches === null ||
					// (a pattern's path is `/*` there, which the origin's `/` matches)
					(initiator !== null && matchesAny(item.matches, `${initiator}/`))),
		);
	}

	/** whether the extension's code may run in a document of `url` (content scripts or injection) */
	reaches(loaded: Loaded, url: string): boolean {
		return (
			INJECTING.some((permission) => loaded.granted.has(permission)) &&
			(loaded.granted.has('activeTab') || hostPermitted(loaded.granted, url))
		);
	}

	/** the entries (manifest's and registered) of an enabled extension */
	entriesOf(loaded: Loaded): ScriptEntry[] {
		return loaded.registered.length || loaded.userScripts.length
			? [...loaded.entries, ...loaded.registered, ...loaded.userScripts]
			: loaded.entries;
	}

	/** the text of one of an extension's files, read once per worker start (content scripts) */
	async source(loaded: Loaded, path: string): Promise<string> {
		// a user script's code, which it carries itself (userScriptEntry)
		if (path.startsWith(CODE_SOURCE)) return path.slice(CODE_SOURCE.length);
		let text = loaded.sources.get(path);
		if (text === undefined) {
			text = (await files.text(loaded.record.id, path)) ?? '';
			loaded.sources.set(path, text);
		}
		return text;
	}

	/** localize `__MSG_*__` in an extension's CSS */
	localizeCSS(loaded: Loaded, css: string): string {
		return localize(
			css,
			loaded.catalogs,
			specialMessages(loaded.record.id, loaded.uiLocale),
		).replace(
			/chrome-extension:\/\/([a-p]{32})\//g,
			(_, id: string) => `${extensionOrigin(id)}/`,
		);
	}

	message(loaded: Loaded, name: string): string {
		return getMessage(
			loaded.catalogs,
			name,
			undefined,
			specialMessages(loaded.record.id, loaded.uiLocale),
		);
	}

	// ---- what the extensions' contexts ask -------------------------------------

	/** tell every context of the extension, under every controller */
	#broadcast(id: string, message: unknown) {
		for (const channel of this.channels()) {
			try {
				const bus = new BroadcastChannel(
					`${EXTENSION_BUS_PREFIX}${channel}|${id}`,
				);
				bus.postMessage(message);
				bus.close();
			} catch (error) {
				// no BroadcastChannel here
			}
		}
	}

	async #area(loaded: Loaded, area: string): Promise<Record<string, unknown>> {
		let data = loaded.areas.get(area);
		if (!data) {
			data =
				area === 'session'
					? {}
					: await storageAreas.get(loaded.record.id, area);
			loaded.areas.set(area, data);
		}
		return data;
	}

	/** chrome.storage.<area>.<call>(...args) */
	async storage(
		id: string,
		area: string,
		call: string,
		args: unknown[],
	): Promise<unknown> {
		await this.ready();
		const loaded = this.#found(id);
		if (!STORAGE_AREAS.includes(area))
			throw new ExtensionError(
				'bad-source',
				`There is no storage area ${area}.`,
			);
		const data = await this.#area(loaded, area);
		const select = (keys: unknown) => {
			if (keys === null || keys === undefined) return copy(data);
			const out: Record<string, unknown> = {};
			if (typeof keys === 'string') {
				if (keys in data) out[keys] = copy(data[keys]);
			} else if (Array.isArray(keys)) {
				for (const key of keys)
					if (String(key) in data) out[String(key)] = copy(data[String(key)]);
			} else if (typeof keys === 'object')
				for (const [key, fallback] of Object.entries(
					keys as Record<string, unknown>,
				))
					out[key] = key in data ? copy(data[key]) : copy(fallback);
			return out;
		};
		const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> =
			{};
		// what the area's records get: the keys set, the keys removed
		const written: Record<string, unknown> = {};
		const removed: string[] = [];
		let cleared = false;
		const write = () => {
			if (area === 'managed')
				throw new ExtensionError('unsupported', 'This is a read-only store.');
		};
		switch (call) {
			case 'get':
				return select(args[0]);
			case 'getKeys':
				return Object.keys(data);
			case 'getBytesInUse': {
				const chosen = select(args[0] ?? null) as Record<string, unknown>;
				let bytes = 0;
				for (const [key, value] of Object.entries(chosen))
					bytes += key.length + JSON.stringify(value).length;
				return bytes;
			}
			case 'set': {
				write();
				const items = args[0];
				if (!items || typeof items !== 'object')
					throw new ExtensionError(
						'bad-source',
						'Error in invocation of storage.set: items must be an object.',
					);
				for (const [key, value] of Object.entries(
					items as Record<string, unknown>,
				)) {
					if (value === undefined) continue;
					const next = copy(value);
					const previous = data[key];
					if (JSON.stringify(previous) === JSON.stringify(next)) continue;
					changes[key] =
						previous === undefined
							? { newValue: next }
							: { oldValue: previous, newValue: next };
					data[key] = next;
					written[key] = next;
				}
				break;
			}
			case 'remove':
				write();
				for (const key of Array.isArray(args[0]) ? args[0] : [args[0]]) {
					const name = String(key);
					if (!(name in data)) continue;
					changes[name] = { oldValue: data[name] };
					delete data[name];
					removed.push(name);
				}
				break;
			case 'clear':
				write();
				for (const key of Object.keys(data)) {
					changes[key] = { oldValue: data[key] };
					delete data[key];
				}
				cleared = true;
				break;
			case 'setAccessLevel':
				if (area === 'session')
					loaded.sessionOpen =
						(args[0] as { accessLevel?: string } | undefined)?.accessLevel ===
						'TRUSTED_AND_UNTRUSTED_CONTEXTS';
				return undefined;
			default:
				throw new ExtensionError(
					'unsupported',
					`storage.${call} is not a call.`,
				);
		}
		if (Object.keys(changes).length) {
			// the promise the extension awaits resolves once this committed,
			// and onChanged is told after it
			if (area !== 'session')
				await storageAreas.apply(id, area, written, removed, cleared);
			this.#broadcast(id, { t: 'storage', area, changes });
		}
		return undefined;
	}

	/** whether content scripts may use storage.session */
	async sessionOpen(id: string): Promise<boolean> {
		await this.ready();
		return !!this.#loaded.get(id)?.sessionOpen;
	}

	/**
	 * A chrome.declarativeNetRequest call: every server's engine makes it, so
	 * they keep the same rules; the first one's answer (or Chrome's error) is
	 * the call's
	 */
	async dnrCall(
		id: string,
		call: string,
		args: unknown[],
		userGesture = false,
	): Promise<unknown> {
		await this.ready();
		this.#found(id);
		const [first, ...others] = [...this.#dnrHosts];
		if (!first)
			throw new ExtensionError(
				'unsupported',
				'declarativeNetRequest is not available yet.',
			);
		// (command, not call: it indexes the changed rules at once)
		const command = {
			op: 'call',
			id,
			method: call,
			args,
			userGesture,
		} as const;
		const answer = await first.command(command);
		for (const host of others) await host.command(command).catch(() => {});
		return answer;
	}

	/** chrome.scripting's registered content scripts */
	async scripting(id: string, call: string, args: unknown[]): Promise<unknown> {
		await this.ready();
		const loaded = this.#found(id);
		const pick = (filter?: { ids?: string[] }) => (entry: ScriptEntry) =>
			!filter?.ids || filter.ids.includes(String(entry.id));
		const changed = async () => {
			await extensionState.put(
				id,
				'scripts',
				loaded.registered
					.filter((entry) => entry.persistAcrossSessions !== false)
					.map(registrationOf),
			);
			// the shells name each entry's route by the generation
			loaded.record = {
				...loaded.record,
				generation: loaded.record.generation + 1,
			};
			await records.put(loaded.record);
		};
		switch (call) {
			case 'registerContentScripts': {
				const added = ((args[0] as Record<string, unknown>[]) ?? []).map(
					registrationEntry,
				);
				for (const entry of added)
					if (loaded.registered.some((existing) => existing.id === entry.id))
						throw new ExtensionError(
							'bad-source',
							`Duplicate script ID '${entry.id}'`,
						);
				loaded.registered.push(...added);
				await changed();
				return undefined;
			}
			case 'getRegisteredContentScripts':
				return loaded.registered
					.filter(pick(args[0] as never))
					.map(registrationOf);
			case 'unregisterContentScripts':
				loaded.registered = loaded.registered.filter(
					(entry) => !pick(args[0] as never)(entry),
				);
				await changed();
				return undefined;
			case 'updateContentScripts':
				for (const script of (args[0] as Record<string, unknown>[]) ?? []) {
					const index = loaded.registered.findIndex(
						(entry) => entry.id === String(script.id),
					);
					if (index < 0)
						throw new ExtensionError(
							'bad-source',
							`Script with ID '${String(script.id)}' does not exist.`,
						);
					loaded.registered[index] = registrationEntry({
						...registrationOf(loaded.registered[index]),
						...script,
					});
				}
				await changed();
				return undefined;
			default:
				throw new ExtensionError(
					'unsupported',
					`scripting.${call} is not a call.`,
				);
		}
	}

	/** chrome.userScripts (Tampermonkey, Violentmonkey): registrations run as content scripts do */
	async userScripts(
		id: string,
		call: string,
		args: unknown[],
	): Promise<unknown> {
		await this.ready();
		const loaded = this.#found(id);
		const pick = (filter?: { ids?: string[] }) => (entry: ScriptEntry) =>
			!filter?.ids || filter.ids.includes(String(entry.id));
		const changed = async () => {
			await extensionState.put(
				id,
				'userScripts',
				loaded.userScripts.map(userScriptOf),
			);
			loaded.record = {
				...loaded.record,
				generation: loaded.record.generation + 1,
			};
			await records.put(loaded.record);
		};
		switch (call) {
			case 'register': {
				const added = ((args[0] as Record<string, unknown>[]) ?? []).map(
					userScriptEntry,
				);
				for (const entry of added)
					if (loaded.userScripts.some((existing) => existing.id === entry.id))
						throw new ExtensionError(
							'bad-source',
							`Duplicate script ID '${entry.id}'`,
						);
				loaded.userScripts.push(...added);
				await changed();
				return undefined;
			}
			case 'getScripts':
				return loaded.userScripts
					.filter(pick(args[0] as never))
					.map(userScriptOf);
			case 'unregister':
				loaded.userScripts = loaded.userScripts.filter(
					(entry) => !pick(args[0] as never)(entry),
				);
				await changed();
				return undefined;
			case 'update':
				for (const script of (args[0] as Record<string, unknown>[]) ?? []) {
					const index = loaded.userScripts.findIndex(
						(entry) => entry.id === String(script.id),
					);
					if (index < 0)
						throw new ExtensionError(
							'bad-source',
							`Script with ID '${String(script.id)}' does not exist.`,
						);
					loaded.userScripts[index] = userScriptEntry({
						...userScriptOf(loaded.userScripts[index]),
						...script,
					});
				}
				await changed();
				return undefined;
			case 'configureWorld': {
				const world = (args[0] ?? {}) as Record<string, unknown>;
				loaded.worlds = [
					...loaded.worlds.filter((other) => other.worldId !== world.worldId),
					world,
				];
				await extensionState.put(id, 'userScriptWorlds', loaded.worlds);
				return undefined;
			}
			case 'getWorldConfigurations':
				return loaded.worlds;
			case 'resetWorldConfiguration':
				loaded.worlds = loaded.worlds.filter(
					(world) => world.worldId !== (args[0] ?? undefined),
				);
				await extensionState.put(id, 'userScriptWorlds', loaded.worlds);
				return undefined;
			default:
				throw new ExtensionError(
					'unsupported',
					`userScripts.${call} is not a call.`,
				);
		}
	}

	/** chrome.permissions, against what the extension was granted */
	async permissions(
		id: string,
		call: string,
		args: unknown[],
	): Promise<unknown> {
		await this.ready();
		const loaded = this.#found(id);
		const request = (args[0] ?? {}) as {
			permissions?: string[];
			origins?: string[];
		};
		const asked = [...(request.permissions ?? []), ...(request.origins ?? [])];
		switch (call) {
			case 'contains':
				return asked.every(
					(permission) =>
						loaded.granted.has(permission) ||
						(permission.includes('://') &&
							hostPermitted(loaded.granted, permission.replace(/\*$/, ''))),
				);
			case 'getAll':
				return {
					permissions: [...loaded.granted].filter(
						(permission) =>
							!permission.includes('://') && permission !== '<all_urls>',
					),
					origins: [...loaded.granted].filter(
						(permission) =>
							permission.includes('://') || permission === '<all_urls>',
					),
				};
			case 'request':
			case 'remove': {
				const optional = new Set(
					loaded.record.manifest.optional_permissions ?? [],
				);
				const extra = new Set(
					((await extensionState.get(id, 'granted')) as string[] | undefined) ??
						[],
				);
				for (const permission of asked)
					if (call === 'request') {
						extra.add(permission);
						loaded.granted.add(permission);
					} else if (optional.has(permission) || extra.has(permission)) {
						extra.delete(permission);
						loaded.granted.delete(permission);
					}
				await extensionState.put(id, 'granted', [...extra]);
				return true;
			}
			default:
				throw new ExtensionError(
					'unsupported',
					`permissions.${call} is not a call.`,
				);
		}
	}

	/** chrome.cookies, through the scope's jar */
	async cookieCall(
		id: string,
		call: string,
		args: unknown[],
	): Promise<unknown> {
		await this.ready();
		const loaded = this.#found(id);
		const jar = this.cookies;
		if (!jar)
			throw new ExtensionError('no-controller', 'No cookie jar is open yet.');
		const permitted = (url: string) => {
			if (!hostPermitted(loaded.granted, url))
				throw new ExtensionError(
					'bad-source',
					`No host permissions for cookies at url: "${url}".`,
				);
		};
		const toChrome = (
			cookie: Awaited<ReturnType<Cookies['list']>>[number],
		) => ({
			name: cookie.name,
			value: cookie.value,
			domain: cookie.hostOnly
				? cookie.domain
				: `.${cookie.domain.replace(/^\./, '')}`,
			path: cookie.path,
			secure: cookie.secure,
			httpOnly: cookie.httpOnly,
			sameSite:
				cookie.sameSite === 'none'
					? 'no_restriction'
					: (cookie.sameSite ?? 'unspecified'),
			hostOnly: cookie.hostOnly,
			session: cookie.expires === null,
			...(cookie.expires
				? { expirationDate: Date.parse(String(cookie.expires)) / 1000 }
				: {}),
			storeId: '0',
		});
		const list = async (url?: string) => {
			const all = (await jar.list(url ? new URL(url).origin : undefined)).map(
				toChrome,
			);
			if (!url) return all;
			const { pathname, protocol } = new URL(url);
			return all.filter(
				(cookie) =>
					pathname.startsWith(cookie.path) &&
					(!cookie.secure || protocol === 'https:'),
			);
		};
		const details = (args[0] ?? {}) as Record<string, unknown>;
		const url = typeof details.url === 'string' ? details.url : undefined;
		switch (call) {
			case 'get': {
				permitted(String(url));
				return (
					(await list(url)).find((cookie) => cookie.name === details.name) ??
					null
				);
			}
			case 'getAll': {
				if (url) permitted(url);
				const all = (await list(url)).filter((cookie) =>
					url
						? true
						: hostPermitted(
								loaded.granted,
								`https://${cookie.domain.replace(/^\./, '')}/`,
							),
				);
				return all.filter(
					(cookie) =>
						(details.name === undefined || cookie.name === details.name) &&
						(details.domain === undefined ||
							cookie.domain
								.replace(/^\./, '')
								.endsWith(String(details.domain).replace(/^\./, ''))) &&
						(details.path === undefined || cookie.path === details.path) &&
						(details.secure === undefined ||
							cookie.secure === details.secure) &&
						(details.session === undefined ||
							cookie.session === details.session),
				);
			}
			case 'set': {
				permitted(String(url));
				const parts = [`${details.name ?? ''}=${details.value ?? ''}`];
				if (details.domain) parts.push(`Domain=${details.domain}`);
				parts.push(`Path=${details.path ?? '/'}`);
				if (details.secure) parts.push('Secure');
				if (details.httpOnly) parts.push('HttpOnly');
				if (typeof details.expirationDate === 'number')
					parts.push(
						`Expires=${new Date(details.expirationDate * 1000).toUTCString()}`,
					);
				if (details.sameSite && details.sameSite !== 'unspecified')
					parts.push(
						`SameSite=${details.sameSite === 'no_restriction' ? 'None' : details.sameSite}`,
					);
				await jar.set(utf8Bytes(parts.join('; ')), String(url));
				return (
					(await list(url)).find(
						(cookie) => cookie.name === (details.name ?? ''),
					) ?? null
				);
			}
			case 'remove': {
				permitted(String(url));
				const found = (await list(url)).find(
					(cookie) => cookie.name === details.name,
				);
				if (!found) return null;
				await jar.set(
					utf8Bytes(
						`${details.name}=; Path=${found.path}; Max-Age=0${found.hostOnly ? '' : `; Domain=${found.domain}`}`,
					),
					String(url),
				);
				return { url, name: details.name, storeId: '0' };
			}
			case 'getAllCookieStores':
				return [{ id: '0', tabIds: [] }];
			default:
				throw new ExtensionError(
					'unsupported',
					`cookies.${call} is not a call.`,
				);
		}
	}

	/** management.getAll/get/getSelf, as Chrome's ExtensionInfo */
	async management(
		id: string,
		call: string,
		args: unknown[],
	): Promise<unknown> {
		await this.ready();
		const self = this.#found(id);
		const describe = (loaded: Loaded) => {
			const info = this.info(loaded);
			return {
				id: info.id,
				name: info.name,
				shortName: info.shortName,
				description: info.description,
				version: info.version,
				enabled: info.enabled,
				type: 'extension',
				installType: loaded.record.policy
					? 'admin'
					: loaded.record.source === 'unpacked'
						? 'development'
						: 'normal',
				mayDisable: !loaded.record.policy,
				isApp: false,
				offlineEnabled: false,
				optionsUrl: info.optionsUrl ? displayExtensionURL(info.optionsUrl) : '',
				homepageUrl: '',
				updateUrl: '',
				permissions: info.permissions,
				hostPermissions: info.hostPermissions,
				icons: Object.entries(loaded.record.manifest.icons ?? {}).map(
					([size, path]) => ({
						size: Number(size),
						url: extensionURL(loaded.record.id, cleanPath(path)),
					}),
				),
			};
		};
		switch (call) {
			case 'getSelf':
				return describe(self);
			case 'get': {
				const other = this.#loaded.get(String(args[0]));
				if (!other)
					throw new ExtensionError(
						'not-found',
						`Failed to find extension with id ${String(args[0])}.`,
					);
				return describe(other);
			}
			case 'getAll':
				if (!self.granted.has('management')) return [describe(self)];
				return [...this.#loaded.values()].map(describe);
			case 'setEnabled':
				if (!self.granted.has('management') && args[0] !== id)
					throw new ExtensionError(
						'bad-source',
						'The "management" permission is required.',
					);
				await this.setEnabled(String(args[0]), !!args[1]);
				return undefined;
			case 'uninstallSelf':
				await this.remove(id);
				return undefined;
			default:
				throw new ExtensionError(
					'unsupported',
					`management.${call} is not a call.`,
				);
		}
	}
}

/** the scope's one extension backend */
export const extensionRegistry = new ExtensionRegistry();
