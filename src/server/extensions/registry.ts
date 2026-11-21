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
	ACTION_COMMANDS,
	ACTION_DESCRIPTION,
	normalizeShortcut,
	shortcutPlatform,
	suggestedShortcut,
} from '../../extensions/commands';
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
	CONTENT_SCRIPT_ROUTE,
	ExtensionError,
	type ExtensionCommand,
	type ExtensionErrorEntry,
	type ExtensionInfo,
	type ExtensionsChange,
	type ExtensionShortcut,
	type Manifest,
	type ReportedError,
	type RunAt,
	type ShippedExtension,
	type SiteAccess,
	type ThemePayload,
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
import { verifyStorePackage } from './storeProof';
import { isTheme, themeManifest, themeSections } from './themes';
import { managementInfo, STORE_HOST, warningsOf } from './webstore';

declare const self: ServiceWorkerGlobalScope;

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
	/** a theme: loaded from what themes.ts leaves of its manifest, so nothing of it runs */
	theme: boolean;
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
	/** what Chrome warns of its manifest (unknown keys and permissions), as manifest errors */
	installWarnings: {
		message: string;
		manifestKey: string;
		manifestSpecific?: string;
	}[];
	/** the error console's entries (runtime and manifest errors) */
	errors: ExtensionErrorEntry[];
	/** its place among the pinned buttons (lower first), null when unpinned */
	pinned: number | null;
	/** its site access (the user's choice in its menu) */
	siteAccess: SiteAccess;
	/** the sites it asks for: host permissions and content scripts' matches */
	requestedHosts: string[];
	/** its button's icon at 16 and 32 pixels (the action's, else the extension's) */
	toolbarIcons: Record<string, string>;
}

/** the keys Chrome's manifest handlers know (_manifest_features.json); any other is an install warning */
const MANIFEST_KEYS = new Set([
	'action',
	'author',
	'automation',
	'background',
	'browser_action',
	'chrome_settings_overrides',
	'chrome_url_overrides',
	'commands',
	'content_capabilities',
	'content_scripts',
	'content_security_policy',
	'converted_from_user_script',
	'cross_origin_embedder_policy',
	'cross_origin_opener_policy',
	'current_locale',
	'declarative_net_request',
	'default_locale',
	'description',
	'devtools_page',
	'differential_fingerprint',
	'event_rules',
	'export',
	'externally_connectable',
	'file_browser_handlers',
	'file_handlers',
	'file_system_provider_capabilities',
	'homepage_url',
	'host_permissions',
	'icons',
	'import',
	'incognito',
	'input_components',
	'key',
	'manifest_version',
	'minimum_chrome_version',
	'nacl_modules',
	'name',
	'oauth2',
	'offline_enabled',
	'omnibox',
	'optional_host_permissions',
	'optional_permissions',
	'options_page',
	'options_ui',
	'page_action',
	'permissions',
	'replacement_web_app',
	'requirements',
	'sandbox',
	'short_name',
	'side_panel',
	'storage',
	'system_indicator',
	'theme',
	'trial_tokens',
	'tts_engine',
	'update_url',
	'version',
	'version_name',
	'web_accessible_resources',
	'webview',
]);

/** the API permissions Chrome knows (permissions_info); any other name is an install warning */
const KNOWN_PERMISSIONS = new Set([
	'accessibilityFeatures.modify',
	'accessibilityFeatures.read',
	'activeTab',
	'alarms',
	'audio',
	'background',
	'bookmarks',
	'browsingData',
	'certificateProvider',
	'clipboardRead',
	'clipboardWrite',
	'contentSettings',
	'contextMenus',
	'cookies',
	'debugger',
	'declarativeContent',
	'declarativeNetRequest',
	'declarativeNetRequestFeedback',
	'declarativeNetRequestWithHostAccess',
	'declarativeWebRequest',
	'desktopCapture',
	'documentScan',
	'dns',
	'downloads',
	'downloads.open',
	'downloads.ui',
	'enterprise.deviceAttributes',
	'enterprise.hardwarePlatform',
	'enterprise.networkingAttributes',
	'enterprise.platformKeys',
	'experimental',
	'favicon',
	'fileBrowserHandler',
	'fileSystemProvider',
	'fontSettings',
	'gcm',
	'geolocation',
	'history',
	'identity',
	'identity.email',
	'idle',
	'input',
	'loginState',
	'management',
	'nativeMessaging',
	'notifications',
	'offscreen',
	'pageCapture',
	'platformKeys',
	'power',
	'printerProvider',
	'printing',
	'printingMetrics',
	'privacy',
	'processes',
	'proxy',
	'readingList',
	'scripting',
	'search',
	'sessions',
	'sidePanel',
	'storage',
	'system.cpu',
	'system.display',
	'system.memory',
	'system.storage',
	'systemLog',
	'tabCapture',
	'tabGroups',
	'tabs',
	'topSites',
	'tts',
	'ttsEngine',
	'unlimitedStorage',
	'userScripts',
	'vpnProvider',
	'wallpaper',
	'webAuthenticationProxy',
	'webNavigation',
	'webRequest',
	'webRequestAuthProvider',
	'webRequestBlocking',
]);

/** the most errors Chrome's ErrorMap keeps per extension (kMaxErrorsPerExtension) */
const MAX_ERRORS = 100;

const isHostPattern = (permission: string) =>
	permission === '<all_urls>' || permission.includes('://');

/** a site as a match pattern (`https://example.org/*`), as developerPrivate.addHostPermission takes it ("Invalid host." for anything else) */
export function sitePattern(site: string): string {
	const text = String(site).trim();
	if (/^(\*|https?):\/\/(\*|(\*\.)?[^/*:]+)(:\d+)?\/.*$/.test(text))
		return text;
	throw new ExtensionError('bad-source', 'Invalid host.');
}

/** a kept site is a match pattern (setSiteHosts'), not an origin (the menu's "On <site>") */
const isSitePattern = (site: string) => /^[^:]+:\/\/[^/]*\//.test(site);

/** a kept site as a match pattern: an origin's every page */
const siteAsPattern = (site: string) =>
	isSitePattern(site) ? site : `${site}/*`;

/** a pattern of every host (PermissionSet::HasEffectiveAccessToAllHosts) */
const allHosts = (pattern: string) =>
	pattern === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(pattern);

/** a manifest without what it asks of sites (the details' permission warnings, when site access lists the sites) */
function withoutHosts(manifest: Manifest): Record<string, unknown> {
	const rest: Record<string, unknown> = { ...manifest };
	delete rest.host_permissions;
	delete rest.content_scripts;
	if (Array.isArray(manifest.permissions))
		rest.permissions = manifest.permissions.filter(
			(permission) => !isHostPattern(permission),
		);
	return rest;
}

/** whether pattern `inner` asks for no more than `outer` gives (both match patterns) */
function patternWithin(inner: string, outer: string): boolean {
	if (outer === '<all_urls>') return true;
	if (inner === '<all_urls>') return false;
	const split = (pattern: string) =>
		/^([^:]+):\/\/([^/]*)(\/.*)$/.exec(pattern)?.slice(1) ?? null;
	const a = split(inner);
	const b = split(outer);
	if (!a || !b) return false;
	const schemeOk =
		b[0] === '*' ? /^(\*|https?)$/.test(a[0]) : a[0] === b[0] || false;
	const host = a[1].replace(/:\d+$/, '');
	const outerHost = b[1].replace(/:\d+$/, '');
	const hostOk =
		outerHost === '*' ||
		host === outerHost ||
		(outerHost.startsWith('*.') &&
			(host === outerHost.slice(2) ||
				host.endsWith(`.${outerHost.slice(2)}`) ||
				(host.startsWith('*.') && host.endsWith(outerHost.slice(1)))));
	return schemeOk && hostOk;
}

/**
 * What Chrome warns of a manifest as it loads it (install warnings, which
 * the error console shows as manifest errors): a key no handler knows
 * ("Unrecognized manifest key 'x'."), a permission no API has
 * ("Permission 'x' is unknown."), measured on Chrome 157
 */
function installWarnings(manifest: Manifest): Loaded['installWarnings'] {
	const warnings: Loaded['installWarnings'] = [];
	for (const key of Object.keys(manifest))
		if (!MANIFEST_KEYS.has(key) && !key.startsWith('_'))
			warnings.push({
				message: `Unrecognized manifest key '${key}'.`,
				manifestKey: key,
			});
	for (const permission of manifest.permissions ?? [])
		if (
			typeof permission === 'string' &&
			!isHostPattern(permission) &&
			!KNOWN_PERMISSIONS.has(permission)
		)
			warnings.push({
				message: `Permission '${permission}' is unknown.`,
				manifestKey: 'permissions',
				manifestSpecific: permission,
			});
	return warnings;
}

/** the reply of a call into the backend */
export type BackendAnswer = unknown;

/** a kept site access, or Chrome's default: every site it asks for */
function siteAccessOf(kept: unknown): SiteAccess {
	const value = kept as Partial<SiteAccess> | undefined;
	return value && typeof value.withheld === 'boolean'
		? {
				withheld: value.withheld,
				sites: Array.isArray(value.sites) ? value.sites.map(String) : [],
			}
		: { withheld: false, sites: [] };
}

/** the sites a manifest asks for: its host permissions and its content scripts' matches */
function requestedHosts(manifest: Manifest): string[] {
	const isHost = (pattern: unknown): pattern is string =>
		typeof pattern === 'string' &&
		(pattern === '<all_urls>' || pattern.includes('://'));
	return [
		...new Set([
			...(manifest.host_permissions ?? []).filter(isHost),
			...(manifest.permissions ?? []).filter(isHost),
			...(manifest.content_scripts ?? []).flatMap((script) =>
				(script.matches ?? []).filter(isHost),
			),
		]),
	];
}

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
	/** developer mode: the error console collects only while it is on (Chrome's ErrorConsole) */
	#developerMode = false;
	/** the error console's next id (ErrorMap's g_next_error_id) */
	#nextErrorId = 1;
	#errorWrites = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * events for a background that is starting (installed, turned on,
	 * reloaded) and has not run its scripts yet: Chrome queues them for a
	 * lazy background, so they go once it asks ranVersion (or in 10 s)
	 */
	#held = new Map<
		string,
		{ messages: unknown[]; timer: ReturnType<typeof setTimeout> }
	>();
	/** the scope's cookie jar (createServer hands it over) */
	cookies?: Cookies;
	/** the controllers' addresses: every extension context talks on one (the worker sets it) */
	channels: () => string[] = () => [];

	/** read the installed extensions, once per worker start */
	ready(): Promise<void> {
		this.#ready ??= (async () => {
			this.#developerMode =
				(await extensionState.get('_', 'developerMode')) === true;
			for (const record of await records.all())
				try {
					await this.#load(record);
				} catch (error) {
					console.warn(`Stomp: extension ${record.id} could not load:`, error);
				}
			for (const host of this.#dnrHosts)
				for (const loaded of this.enabled())
					await this.#dnrInstall(loaded, host);
			// (a theme a store install replaced before the worker stopped)
			for (const loaded of this.#loaded.values())
				if (loaded.theme && !loaded.record.enabled) this.#watchReplaced();
		})();
		return this.#ready;
	}

	/** whether any extension is installed at all (the request path's first, synchronous question); a theme is none */
	get any(): boolean {
		for (const loaded of this.#loaded.values()) if (!loaded.theme) return true;
		return false;
	}

	/** the enabled extensions (never a theme) */
	*enabled(): Iterable<Loaded> {
		for (const loaded of this.#loaded.values())
			if (loaded.record.enabled && !loaded.theme) yield loaded;
	}

	get(id: string): Loaded | undefined {
		return this.#loaded.get(id);
	}

	onChange(listener: (change: ExtensionsChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(change: ExtensionsChange, before?: Loaded) {
		for (const listener of [...this.#listeners])
			try {
				listener(change);
			} catch (error) {
				// a controller that went away
			}
		this.#holdWhileStarting(change);
		this.#tellManagement(change, before);
	}

	/** an extension whose background starts now holds its events (#held) */
	#holdWhileStarting(change: ExtensionsChange) {
		const id = change.id;
		if (!id) return;
		if (
			change.type !== 'installed' &&
			change.type !== 'updated' &&
			change.type !== 'enabled'
		) {
			if (change.type === 'disabled' || change.type === 'removed')
				this.#release(id, false);
			return;
		}
		const loaded = this.#loaded.get(id);
		const background = loaded?.record.manifest.background;
		if (
			!loaded?.record.enabled ||
			!(
				background?.service_worker ||
				background?.page ||
				background?.scripts?.length
			)
		)
			return;
		this.#release(id, false);
		this.#held.set(id, {
			messages: [],
			timer: setTimeout(() => this.#release(id, true), 10_000),
		});
	}

	/** the held events go to the background now (or are dropped with it) */
	#release(id: string, send: boolean) {
		const held = this.#held.get(id);
		if (!held) return;
		clearTimeout(held.timer);
		this.#held.delete(id);
		if (send) for (const message of held.messages) this.#post(id, message);
	}

	/** an event for an extension's background, held while it starts */
	#postEvent(id: string, message: unknown) {
		const held = this.#held.get(id);
		if (held) held.messages.push(message);
		else this.#post(id, message);
	}

	/**
	 * chrome.management's events in the other extensions that hold
	 * "management", as Chrome's ManagementEventRouter fires them: a load is
	 * onEnabled, an unload onDisabled (an update and an uninstall unload
	 * first), then onInstalled or onUninstalled
	 */
	#tellManagement(change: ExtensionsChange, before?: Loaded) {
		const id = change.id;
		if (!id) return;
		const now = this.#loaded.get(id);
		const off = (loaded: Loaded) =>
			managementInfo({
				...loaded,
				record: { ...loaded.record, enabled: false },
			});
		const events: [string, unknown[]][] = [];
		switch (change.type) {
			case 'installed':
			case 'updated':
				if (change.type === 'updated' && before?.record.enabled)
					events.push(['onDisabled', [off(before)]]);
				if (now?.record.enabled)
					events.push(['onEnabled', [managementInfo(now)]]);
				if (now) events.push(['onInstalled', [managementInfo(now)]]);
				break;
			case 'enabled':
				if (now) events.push(['onEnabled', [managementInfo(now)]]);
				break;
			case 'disabled':
				if (now) events.push(['onDisabled', [managementInfo(now)]]);
				break;
			case 'removed':
				if (before?.record.enabled) events.push(['onDisabled', [off(before)]]);
				events.push(['onUninstalled', [id]]);
				break;
			default:
				return;
		}
		for (const other of this.enabled())
			if (other.record.id !== id && other.granted.has('management'))
				for (const [name, args] of events)
					this.#postEvent(other.record.id, {
						t: 'event',
						name: `management.${name}`,
						args,
					});
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
		const loaded = this.#loaded.get(id);
		// (an extension whose sites are withheld runs on a click too: Chrome's
		// ActiveTabPermissionGranter grants what it withheld for the tab)
		if (!loaded?.granted.has('activeTab') && !loaded?.siteAccess.withheld)
			return;
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
			// (site access withholds its hosts but the sites it keeps: their
			// rules wait for a click, the activeTabGranted hook)
			...(loaded.siteAccess.withheld
				? {
						hostPermissions: loaded.siteAccess.sites
							.map(siteAsPattern)
							.filter((site) =>
								[...granted].some(
									(pattern) =>
										isHostPattern(pattern) && patternWithin(site, pattern),
								),
							),
						withheldHostPermissions: [...granted].filter(isHostPattern),
					}
				: { hostPermissions: [...granted].filter(isHostPattern) }),
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

	/**
	 * A file of the extension's as a data: URL of its bytes, whatever its
	 * size, or null when the package has no such file: what setIcon's path
	 * loads (Chrome's bindings fetch it from the extension and decode it,
	 * and the toolbar keeps the picture, never the path)
	 */
	async fileData(id: string, path: string): Promise<string | null> {
		const clean = cleanPath(path);
		if (!clean) return null;
		const response = await files.read(id, clean);
		if (!response) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		return `data:${mimeOf(clean)};base64,${bytesToBase64(bytes)}`;
	}

	async #load(stored: StoredExtension): Promise<Loaded> {
		// a theme is what themes.ts leaves of it, whatever an older record kept
		const theme = isTheme(stored.manifest);
		const themed = theme ? themeManifest(stored.manifest) : null;
		const record = themed ? { ...stored, manifest: themed.manifest } : stored;
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
		const granted = new Set(
			theme
				? []
				: [
						...(raw.permissions ?? []),
						...(raw.host_permissions ?? []),
						...(((await extensionState.get(record.id, 'granted')) as
							string[] | undefined) ?? []),
					],
		);
		// MV2's host permissions sit in `permissions`
		const mv3 = Number(raw.manifest_version) >= 3;
		const blocking =
			granted.has('webRequest') &&
			(mv3 ? record.policy : granted.has('webRequestBlocking'));
		const warnings: string[] = themed ? [...themed.warnings] : [];
		const accessible: Loaded['accessible'] = [];
		for (const item of raw.web_accessible_resources ?? [])
			if (typeof item === 'string')
				accessible.push({ paths: [resourceGlob(item)], matches: null });
			else if (item && Array.isArray(item.resources))
				accessible.push({
					paths: item.resources.map(resourceGlob),
					matches: item.matches ?? null,
				});
		const kept = async (key: string) =>
			theme ? undefined : extensionState.get(record.id, key);
		const registered = (
			((await kept('scripts')) as Record<string, unknown>[] | undefined) ?? []
		).flatMap((script) => {
			try {
				return [registrationEntry(script)];
			} catch (error) {
				return [];
			}
		});
		const loaded: Loaded = {
			theme,
			record,
			manifest,
			catalogs,
			uiLocale,
			granted,
			blocking,
			entries: manifestEntries(raw),
			registered,
			userScripts: (
				((await kept('userScripts')) as
					Record<string, unknown>[] | undefined) ?? []
			).flatMap((script) => {
				try {
					return [userScriptEntry(script)];
				} catch (error) {
					return [];
				}
			}),
			worlds:
				((await kept('userScriptWorlds')) as
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
			installWarnings: theme ? [] : installWarnings(raw),
			errors:
				this.#loaded.get(record.id)?.errors ??
				((await extensionState.get(record.id, 'errors')) as
					ExtensionErrorEntry[] | undefined) ??
				[],
			pinned:
				((await extensionState.get(record.id, 'pinned')) as
					number | undefined) ?? null,
			siteAccess: siteAccessOf(
				await extensionState.get(record.id, 'siteAccess'),
			),
			requestedHosts: requestedHosts(raw),
			toolbarIcons: {},
		};
		for (const error of loaded.errors)
			this.#nextErrorId = Math.max(this.#nextErrorId, error.id + 1);
		// the toolbar's sizes: 16 pixels at 1x, 32 at 2x (Chrome's 16 dip
		// action icon), the action's own icons first; pictures whatever their
		// size, as the host cannot load an extension's file
		for (const size of [16, 32]) {
			const path =
				pickIcon(action?.default_icon, size) ?? pickIcon(raw.icons, size);
			const icon = path ? await this.fileData(record.id, path) : null;
			if (icon) loaded.toolbarIcons[size] = icon;
		}
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
		const raw = record.manifest;
		const store = record.source === 'webstore';
		const storePage = `https://${STORE_HOST}/detail/${record.webStoreId ?? record.id}`;
		return {
			id: record.id,
			type: loaded.theme ? 'theme' : 'extension',
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
				(permission) => !isHostPattern(permission),
			),
			hostPermissions: [...loaded.granted].filter(isHostPattern),
			contentScripts: loaded.entries.length,
			background: background?.service_worker
				? 'service_worker'
				: background?.page || background?.scripts?.length
					? 'page'
					: 'none',
			manifest: copy(manifest),
			warnings: [...loaded.warnings],
			size: Object.values(record.index ?? {}).reduce(
				(sum, file) => sum + (file[2] ?? 0),
				0,
			),
			path:
				record.source === 'webstore'
					? null
					: (record.path ??
						(record.source === 'package' || record.filename !== 'unpacked'
							? record.filename
							: null)),
			collectErrors: this.#collecting(loaded),
			errorCount: loaded.errors.length,
			// (with site access shown, the hosts are its rows, not warnings:
			// developerPrivate's simplePermissions)
			permissionWarnings: loaded.theme
				? []
				: warningsOf(
						loaded.requestedHosts.length
							? withoutHosts(raw)
							: (raw as Record<string, unknown>),
					),
			pinned: loaded.pinned !== null,
			pinOrder: loaded.pinned,
			actionIcons: { ...loaded.toolbarIcons },
			siteAccess: {
				withheld: loaded.siteAccess.withheld,
				sites: [...loaded.siteAccess.sites],
			},
			requestedHosts: [...loaded.requestedHosts],
			allHostsRequested: loaded.requestedHosts.some(allHosts),
			homepageUrl:
				typeof manifest.homepage_url === 'string' && manifest.homepage_url
					? manifest.homepage_url
					: store
						? storePage
						: null,
			webStoreUrl: store ? storePage : null,
		};
	}

	/** the pinned extensions in their order, then the others (the toolbar's) */
	pinOrder(): string[] {
		return [...this.#loaded.values()]
			.filter((loaded) => loaded.pinned !== null)
			.sort((a, b) => a.pinned! - b.pinned!)
			.map((loaded) => loaded.record.id);
	}

	/** pin its button to the toolbar (after the pinned ones), or unpin it */
	async setPinned(id: string, pinned: boolean): Promise<ExtensionInfo> {
		await this.ready();
		const loaded = this.#found(id);
		if ((loaded.pinned !== null) !== pinned) {
			loaded.pinned = pinned ? this.#nextPin() : null;
			await extensionState.put(id, 'pinned', loaded.pinned ?? undefined);
			this.#emit({ type: 'settings', id });
		}
		return this.info(loaded);
	}

	#nextPin(): number {
		let last = 0;
		for (const loaded of this.#loaded.values())
			if (loaded.pinned !== null) last = Math.max(last, loaded.pinned);
		return last + 1;
	}

	/**
	 * Its site access, as its menu sets it (Chrome's UpdateSiteAccess): on a
	 * click withholds every site (or takes the site of `url` off the granted
	 * ones), on the site of `url` withholds every other, on all sites grants
	 * every site it asks for
	 */
	async setSiteAccess(
		id: string,
		access: 'click' | 'site' | 'all',
		url?: string,
	): Promise<ExtensionInfo> {
		await this.ready();
		const loaded = this.#found(id);
		let origin: string | null = null;
		try {
			origin = url ? new URL(url).origin : null;
		} catch (error) {
			origin = null;
		}
		const current = loaded.siteAccess;
		let next: SiteAccess;
		if (access === 'all') next = { withheld: false, sites: [] };
		else if (access === 'site') {
			if (!origin)
				throw new ExtensionError('unsupported', 'No site was given.');
			next = {
				withheld: true,
				sites: current.withheld
					? [...new Set([...current.sites, origin])]
					: [origin],
			};
		} else
			next = {
				withheld: true,
				sites: current.withheld
					? current.sites.filter((site) => site !== origin)
					: [],
			};
		loaded.siteAccess = next;
		await extensionState.put(id, 'siteAccess', next);
		await this.#dnrSync(id);
		this.#emit({ type: 'settings', id });
		return this.info(loaded);
	}

	/**
	 * Whether the extension may read and change `url` (a page of tab
	 * `tabId`): a site it asks for that its site access grants, or the tab a
	 * click on its button granted
	 */
	siteGranted(loaded: Loaded, url: string, tabId = -1): boolean {
		if (tabId >= 0 && this.#activeTabs.get(loaded.record.id)?.has(tabId))
			return true;
		if (!loaded.siteAccess.withheld) return true;
		let origin: string;
		try {
			origin = new URL(url).origin;
		} catch (error) {
			return false;
		}
		return loaded.siteAccess.sites.some((site) =>
			isSitePattern(site) ? hostPermitted([site], url) : site === origin,
		);
	}

	/** its declarativeContent rules (kept across restarts, as Chrome keeps them); `rules` replaces them */
	async contentRules(
		id: string,
		rules?: Record<string, unknown>[],
	): Promise<Record<string, unknown>[]> {
		await this.ready();
		this.#found(id);
		if (rules) {
			await extensionState.put(id, 'contentRules', rules);
			return rules;
		}
		const kept = await extensionState.get(id, 'contentRules');
		return Array.isArray(kept) ? (kept as Record<string, unknown>[]) : [];
	}

	/** the tab a service worker client's document is in, -1 when unknown */
	tabOfClient(client: string | undefined): number {
		return client ? (this.#clientTabs.get(client) ?? -1) : -1;
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
			shortcuts: Object.fromEntries(
				Object.entries(loaded.record.shortcuts ?? {}).map(([name, kept]) => [
					name,
					kept.shortcut,
				]),
			),
			...(this.#developerMode && this.#collecting(loaded)
				? { collect: true }
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
	 * through the controller's transport (the Web Store). `expect` may refuse
	 * the package read before anything is stored (the store's approval:
	 * webstore.ts).
	 */
	async install(
		command: Extract<ExtensionCommand, { op: 'install' }>,
		download: (url: string) => Promise<Uint8Array>,
		expect?: (read: ReadPackage) => void,
		/** the store's document that installs it: a theme it replaces stays, off, while that document does */
		installer?: string,
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
				await verifyStorePackage(bytes, storeId);
			} catch (error) {
				throw Object.assign(
					new ExtensionError(
						'webstore',
						`The Chrome Web Store download of ${storeId} failed: ${error instanceof Error ? error.message : String(error)}`,
					),
					{ cause: error },
				);
			}
			filename = `${storeId}.crx`;
			source = 'webstore';
			read = await readPackage(bytes, filename);
			if (read.id !== storeId)
				throw new ExtensionError(
					'bad-package',
					'The package id does not match the store listing.',
				);
		} else if (command.files) {
			source = 'unpacked';
			read = await readUnpacked(command.files, command.filename || 'unpacked');
		} else if (command.bytes) {
			read = await readPackage(new Uint8Array(command.bytes), filename);
		} else
			throw new ExtensionError('bad-source', 'Nothing to install was given.');
		expect?.(read);
		return this.#store(read, {
			source,
			webStoreId:
				storeId ?? this.#loaded.get(read.id)?.record.webStoreId ?? null,
			filename,
			path:
				command.path ??
				(source === 'unpacked' ? command.filename : undefined) ??
				(source === 'package' ? filename : undefined),
			enabled: command.enabled,
			policy: command.policy,
			installer,
		});
	}

	async #store(
		read: ReadPackage,
		options: {
			source: StoredExtension['source'];
			webStoreId: string | null;
			filename: string;
			path?: string;
			enabled?: boolean;
			policy?: boolean;
			installer?: string;
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
			...(options.path ? { path: options.path } : {}),
			...(previous?.collectErrors !== undefined
				? { collectErrors: previous.collectErrors }
				: {}),
		};
		record.shortcuts = this.#assignShortcuts(record, previous?.shortcuts);
		const shown = this.currentTheme()?.record.id;
		const before = this.#loaded.get(read.id);
		await records.put(record);
		// Chrome 157 pins a new extension's button (kExtensionsPinnedByDefault,
		// on by default, and its user setting's default): on its install,
		// never on an update
		const manifest = read.manifest;
		if (
			!previous &&
			(manifest.action ?? manifest.browser_action ?? manifest.page_action)
		)
			await extensionState.put(read.id, 'pinned', this.#nextPin());
		const loaded = await this.#load(record);
		await this.#dnrSync(record.id);
		if (loaded.theme && record.enabled)
			await this.#replaceThemes(record.id, options.installer ?? null);
		// (Chrome's ErrorConsole drops the last install's manifest errors and adds this one's)
		this.#manifestErrors(loaded);
		this.#emit(
			{ type: previous ? 'updated' : 'installed', id: read.id },
			before,
		);
		if (loaded.theme && record.enabled) this.#emitTheme();
		else if (shown === read.id) this.#emitTheme();
		return this.info(loaded);
	}

	// ---- themes (themes.ts) ----------------------------------------------------

	/** the theme shown now: the enabled one (the newest, should there be two) */
	currentTheme(): Loaded | undefined {
		let found: Loaded | undefined;
		for (const loaded of this.#loaded.values())
			if (
				loaded.theme &&
				loaded.record.enabled &&
				(!found || loaded.record.updatedAt > found.record.updatedAt)
			)
				found = loaded;
		return found;
	}

	#emitTheme() {
		const id = this.currentTheme()?.record.id;
		this.#emit(id ? { type: 'theme', id } : { type: 'theme' });
	}

	/**
	 * `id` is the theme now (ThemeService::SetTheme): every other theme is
	 * turned off. Chrome keeps the one it replaced, for the undo of its
	 * install bubble, until the tab that installed the new one navigates;
	 * so a theme the store's page `installer` replaced stays, off, while that
	 * document lives (sweepThemes), and one any other install replaced goes
	 */
	async #replaceThemes(id: string, installer: string | null) {
		await extensionState.put(id, 'replacedBy', null);
		for (const loaded of [...this.#loaded.values()]) {
			const other = loaded.record.id;
			if (!loaded.theme || other === id) continue;
			if (installer) {
				if (loaded.record.enabled) {
					loaded.record = { ...loaded.record, enabled: false };
					await records.put(loaded.record);
					this.#emit({ type: 'disabled', id: other });
				}
				await extensionState.put(other, 'replacedBy', installer);
				this.#watchReplaced();
			} else await this.#drop(other);
		}
	}

	#sweeping: Promise<number> = Promise.resolve(0);
	#sweepTimer: ReturnType<typeof setTimeout> | null = null;

	/** look for the installing document's going while the worker runs, as Chrome drops the theme at that navigation */
	#watchReplaced() {
		if (this.#sweepTimer) return;
		this.#sweepTimer = setTimeout(async () => {
			const waiting = await this.sweepThemes().catch(() => 0);
			this.#sweepTimer = null;
			if (waiting) this.#watchReplaced();
		}, 400);
	}

	/**
	 * drop the themes a store install replaced once the document that
	 * installed it is gone; answers how many still wait (one sweep at a time)
	 */
	sweepThemes(): Promise<number> {
		const run = async () => {
			await this.ready();
			let waiting = 0;
			for (const loaded of [...this.#loaded.values()]) {
				if (!loaded.theme || loaded.record.enabled) continue;
				const installer = await extensionState.get(
					loaded.record.id,
					'replacedBy',
				);
				if (typeof installer !== 'string') continue;
				if (await self.clients.get(installer)) waiting++;
				else if (this.#loaded.get(loaded.record.id) === loaded)
					await this.#drop(loaded.record.id);
			}
			return waiting;
		};
		this.#sweeping = this.#sweeping.then(run, run);
		return this.#sweeping;
	}

	/** a theme as the host is given it: its sections, and its images' bytes */
	async themePayload(loaded: Loaded): Promise<ThemePayload> {
		const { record, manifest } = loaded;
		return {
			id: `chrome-theme:${record.id}`,
			extensionId: record.id,
			name: manifest.name,
			description: manifest.description ?? '',
			version: manifest.version ?? '',
			source: record.source,
			enabled: record.enabled,
			updatedAt: record.updatedAt,
			theme: await themeSections(manifest, (path) =>
				files.bytes(record.id, path),
			),
		};
	}

	/** every installed theme, the one shown first */
	async themes(): Promise<ThemePayload[]> {
		await this.sweepThemes();
		const current = this.currentTheme();
		const all = [...this.#loaded.values()]
			.filter((loaded) => loaded.theme)
			.sort(
				(a, b) =>
					Number(b === current) - Number(a === current) ||
					a.record.installedAt - b.record.installedAt,
			);
		return Promise.all(all.map((loaded) => this.themePayload(loaded)));
	}

	/** Chrome's Reset to default (ThemeService::UseDefaultTheme): every theme is uninstalled */
	async resetTheme(): Promise<void> {
		await this.ready();
		const themes = [...this.#loaded.values()].filter((loaded) => loaded.theme);
		for (const loaded of themes) await this.#drop(loaded.record.id);
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
			const shown = this.currentTheme();
			loaded.record = { ...loaded.record, enabled };
			await records.put(loaded.record);
			if (!enabled) {
				this.#activeTabs.delete(id);
				// (its content scripts already in pages lose their extension)
				this.#post(id, { t: 'contextGone' });
			}
			// (turned on again: its background starts with no onInstalled)
			else await extensionState.put(id, 'started', 'enabled');
			await this.#dnrSync(id);
			// (turning a theme on shows it, as Chrome's undo does)
			if (loaded.theme && enabled) await this.#replaceThemes(id, null);
			this.#emit({ type: enabled ? 'enabled' : 'disabled', id });
			if (this.currentTheme() !== shown) this.#emitTheme();
		}
		return this.info(loaded);
	}

	async remove(id: string): Promise<void> {
		await this.ready();
		this.#found(id);
		await this.#drop(id);
	}

	/** uninstall one that is loaded (the registry is ready) */
	async #drop(id: string): Promise<void> {
		const shown = this.currentTheme()?.record.id === id;
		const before = this.#loaded.get(id);
		this.#loaded.delete(id);
		clearTimeout(this.#errorWrites.get(id));
		this.#errorWrites.delete(id);
		await records.delete(id);
		await files.remove(id);
		await storageAreas.forget(id);
		await extensionState.forget(id);
		this.#activeTabs.delete(id);
		await this.#dnrSync(id);
		this.#post(id, { t: 'contextGone' });
		this.#emit({ type: 'removed', id }, before);
		if (shown) this.#emitTheme();
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

	/** the version the background last ran, and note this one (runtime.onInstalled); `reloaded` after Reload */
	async ranVersion(id: string): Promise<{
		previous: string | null;
		now: string;
		/** why it starts: Reload (onInstalled `update`), turned on again (no event) */
		started?: 'reloaded' | 'enabled';
	}> {
		const loaded = this.#found(id);
		// (its scripts ran, its listeners are on: what it missed goes now)
		this.#release(id, true);
		const now = loaded.record.manifest.version ?? '';
		const previous = loaded.record.lastRunVersion ?? null;
		const started = await extensionState.get(id, 'started');
		if (started) await extensionState.put(id, 'started', null);
		if (previous !== now) {
			loaded.record = { ...loaded.record, lastRunVersion: now };
			await records.put(loaded.record);
		}
		return {
			previous,
			now,
			...(started === 'reloaded' || started === 'enabled' ? { started } : {}),
		};
	}

	/**
	 * Chrome's Reload: the extension starts again from its files, as an
	 * update to the same version (its background restarts, its content
	 * scripts' routes are new, runtime.onInstalled says `update`)
	 */
	async reload(id: string): Promise<ExtensionInfo> {
		await this.ready();
		const before = this.#found(id);
		const record: StoredExtension = {
			...before.record,
			updatedAt: Date.now(),
			generation: before.record.generation + 1,
		};
		await records.put(record);
		await extensionState.put(id, 'started', 'reloaded');
		this.#post(id, { t: 'contextGone' });
		const loaded = await this.#load(record);
		await this.#dnrSync(id);
		this.#manifestErrors(loaded);
		this.#emit({ type: 'updated', id }, before);
		return this.info(loaded);
	}

	/** an installed extension's files, as bytes by path (pack) */
	async filesOf(id: string): Promise<Record<string, ArrayBuffer>> {
		await this.ready();
		const loaded = this.#found(id);
		const out: Record<string, ArrayBuffer> = {};
		for (const path of loaded.record.files) {
			const bytes = await files.bytes(id, path);
			if (bytes)
				out[path] = bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer;
		}
		return out;
	}

	// ---- site access (runtime host permissions) --------------------------------

	/**
	 * Site access on exactly these sites, as the extensions page's list sets
	 * it (developerPrivate.addHostPermission, removeHostPermission): its
	 * sites withheld but these, each a match pattern ("Invalid host." for
	 * anything else, as Chrome's); none is on a click
	 */
	async setSiteHosts(id: string, hosts: string[]): Promise<ExtensionInfo> {
		await this.ready();
		const loaded = this.#found(id);
		if (!loaded.requestedHosts.length)
			throw new ExtensionError(
				'unsupported',
				`${loaded.manifest.name} asks for no site access.`,
			);
		const next: SiteAccess = {
			withheld: true,
			sites: [...new Set(hosts.map(sitePattern))],
		};
		loaded.siteAccess = next;
		await extensionState.put(id, 'siteAccess', next);
		await this.#dnrSync(id);
		this.#emit({ type: 'settings', id });
		return this.info(loaded);
	}

	// ---- the error console (Chrome's ErrorConsole) -----------------------------

	/** Chrome's default: an unpacked extension's errors are collected, any other's not (GetMaskForExtension) */
	#collecting(loaded: Loaded): boolean {
		if (loaded.theme) return false;
		return loaded.record.collectErrors ?? loaded.record.source === 'unpacked';
	}

	get developerMode(): boolean {
		return this.#developerMode;
	}

	/** developer mode on or off: the console collects only while it is on, and forgets everything as it goes off */
	async setDeveloperMode(on: boolean): Promise<boolean> {
		await this.ready();
		if (on === this.#developerMode) return on;
		this.#developerMode = on;
		await extensionState.put('_', 'developerMode', on);
		for (const loaded of this.#loaded.values()) {
			if (on) {
				if (loaded.record.enabled) this.#manifestErrors(loaded);
			} else if (loaded.errors.length) {
				loaded.errors = [];
				this.#errorsChanged(loaded);
			}
			this.#post(loaded.record.id, {
				t: 'collect',
				on: on && this.#collecting(loaded),
			});
		}
		return on;
	}

	/** Collect errors for one extension (SetReportingAllForExtension) */
	async setCollectErrors(id: string, on: boolean): Promise<ExtensionInfo> {
		await this.ready();
		const loaded = this.#found(id);
		loaded.record = { ...loaded.record, collectErrors: on };
		await records.put(loaded.record);
		this.#post(id, { t: 'collect', on: on && this.#developerMode });
		this.#emit({ type: 'errors', id });
		return this.info(loaded);
	}

	async errors(id: string): Promise<ExtensionErrorEntry[]> {
		await this.ready();
		return copy(this.#found(id).errors);
	}

	/** delete some errors (by id), or all of them (developerPrivate.deleteExtensionErrors) */
	async clearErrors(id: string, ids?: number[]): Promise<void> {
		await this.ready();
		const loaded = this.#found(id);
		const before = loaded.errors.length;
		loaded.errors = ids
			? loaded.errors.filter((error) => !ids.includes(error.id))
			: [];
		if (loaded.errors.length !== before) this.#errorsChanged(loaded);
	}

	/** an install's manifest errors replace the last one's (ErrorConsole::OnExtensionInstalled) */
	#manifestErrors(loaded: Loaded) {
		if (!this.#developerMode || !this.#collecting(loaded)) return;
		const kept = loaded.errors.filter((error) => error.type === 'runtime');
		const warnings: Loaded['installWarnings'] = [
			...loaded.installWarnings,
			...loaded.warnings.map((message) => ({ message, manifestKey: '' })),
		];
		const made = warnings.map((warning): ExtensionErrorEntry => ({
			id: this.#nextErrorId++,
			type: 'manifest',
			message: warning.message,
			severity: 'warn',
			source: 'manifest.json',
			contextUrl: '',
			stackTrace: [],
			occurrences: 1,
			timestamp: Date.now(),
			manifestKey: warning.manifestKey,
			...(warning.manifestSpecific
				? { manifestSpecific: warning.manifestSpecific }
				: {}),
		}));
		const before = loaded.errors.length;
		loaded.errors = [...made, ...kept].slice(-MAX_ERRORS);
		if (made.length || before !== loaded.errors.length)
			this.#errorsChanged(loaded);
	}

	/**
	 * A context's error (an uncaught exception, a rejection nobody handled,
	 * console.error or console.warn), kept as Chrome's ErrorMap keeps it:
	 * only while developer mode is on and the extension's errors are
	 * collected, the same error again counts as an occurrence of the one
	 * kept (and moves to the end), at most 100 per extension
	 */
	/** a content script entry's route as its file, `chrome-extension://<id>/content.js` (its first script's) */
	#contentScriptFile(loaded: Loaded, url: string): string {
		const key = new RegExp(
			`/${CONTENT_SCRIPT_ROUTE}/${loaded.record.id}/[^/]+/([^/?#]+)\\.js(?:[?#].*)?$`,
		).exec(url)?.[1];
		if (!key) return url;
		const entry = this.entriesOf(loaded).find(
			(candidate) => candidate.key === decodeURIComponent(key),
		);
		return entry?.js[0] && !/^[a-z]+:/i.test(entry.js[0])
			? extensionURL(loaded.record.id, cleanPath(entry.js[0]))
			: url;
	}

	reportError(id: string, reported: ReportedError) {
		const loaded = this.#loaded.get(id);
		if (!loaded || !this.#developerMode || !this.#collecting(loaded)) return;
		const message = String(reported?.message ?? '').slice(0, 10_000);
		const severity = reported?.severity === 'warn' ? 'warn' : 'error';
		const stackTrace = (
			Array.isArray(reported?.stackTrace) ? reported.stackTrace : []
		)
			.slice(0, 64)
			.map((frame) => ({
				url: displayExtensionURL(
					this.#contentScriptFile(loaded, String(frame?.url ?? '')),
				),
				lineNumber: Number(frame?.lineNumber) || 0,
				columnNumber: Number(frame?.columnNumber) || 0,
				functionName: String(frame?.functionName || '(anonymous function)'),
			}));
		const contextUrl = displayExtensionURL(String(reported?.contextUrl ?? ''));
		// (RuntimeError::CleanUpInit: the source is the stack's top frame)
		const source = stackTrace[0]?.url || contextUrl;
		const entry: ExtensionErrorEntry = {
			id: 0,
			type: 'runtime',
			message,
			severity,
			source,
			contextUrl,
			stackTrace,
			occurrences: 1,
			timestamp: Date.now(),
			...(reported?.isServiceWorker ? { isServiceWorker: true } : {}),
		};
		const same = loaded.errors.findIndex(
			(error) =>
				error.type === 'runtime' &&
				error.message === entry.message &&
				error.severity === entry.severity &&
				error.source === entry.source &&
				error.contextUrl === entry.contextUrl &&
				error.stackTrace.length === entry.stackTrace.length &&
				JSON.stringify(error.stackTrace[0] ?? null) ===
					JSON.stringify(entry.stackTrace[0] ?? null),
		);
		if (same >= 0) {
			entry.id = loaded.errors[same].id;
			entry.occurrences = loaded.errors[same].occurrences + 1;
			loaded.errors.splice(same, 1);
		} else entry.id = this.#nextErrorId++;
		if (loaded.errors.length >= MAX_ERRORS) loaded.errors.shift();
		loaded.errors.push(entry);
		this.#errorsChanged(loaded);
	}

	/** store the console's entries a moment later (a burst is one write), and tell the hosts */
	#errorsChanged(loaded: Loaded) {
		const id = loaded.record.id;
		clearTimeout(this.#errorWrites.get(id));
		this.#errorWrites.set(
			id,
			setTimeout(() => {
				this.#errorWrites.delete(id);
				if (this.#loaded.get(id) === loaded)
					extensionState.put(id, 'errors', loaded.errors).catch(() => {});
				this.#emit({ type: 'errors', id });
			}, 50),
		);
	}

	// ---- commands (Chrome's CommandService) ------------------------------------

	/** the commands of a manifest, the action's first (CommandsInfo, with the action's that Chrome adds for a button) */
	#commandNames(manifest: Manifest): string[] {
		const declared = Object.keys(manifest.commands ?? {});
		const actionKey = manifest.action
			? '_execute_action'
			: manifest.browser_action
				? '_execute_browser_action'
				: manifest.page_action
					? '_execute_page_action'
					: null;
		return [
			...(actionKey ? [actionKey] : []),
			...declared.filter((name) => !ACTION_COMMANDS.includes(name)).sort(),
		];
	}

	/**
	 * the shortcuts of a new install: what it had before, and for each new
	 * command its suggested key when no other extension's command holds it
	 * (AssignKeybindings, which never overrides)
	 */
	#assignShortcuts(
		record: StoredExtension,
		previous: StoredExtension['shortcuts'] | undefined,
	): NonNullable<StoredExtension['shortcuts']> {
		const out: NonNullable<StoredExtension['shortcuts']> = {};
		if (isTheme(record.manifest)) return out;
		const platform = shortcutPlatform(
			typeof navigator === 'undefined' ? '' : navigator.userAgent,
		);
		const taken = new Set<string>();
		for (const loaded of this.#loaded.values())
			if (loaded.record.id !== record.id)
				for (const kept of Object.values(loaded.record.shortcuts ?? {}))
					if (kept.shortcut) taken.add(kept.shortcut);
		const commands = record.manifest.commands ?? {};
		for (const name of this.#commandNames(record.manifest)) {
			if (previous?.[name]) {
				out[name] = previous[name];
				continue;
			}
			const declared =
				commands[name] ??
				(ACTION_COMMANDS.includes(name)
					? ACTION_COMMANDS.map((action) => commands[action]).find(Boolean)
					: undefined);
			const suggested = suggestedShortcut(declared?.suggested_key, platform);
			const free = !!suggested && !taken.has(suggested);
			if (free) taken.add(suggested);
			out[name] = { shortcut: free ? suggested : '', scope: 'chrome' };
		}
		return out;
	}

	/** every enabled extension's commands, as the Keyboard shortcuts page lists them */
	async commands(): Promise<ExtensionShortcut[]> {
		await this.ready();
		const rows: ExtensionShortcut[] = [];
		for (const loaded of this.enabled()) {
			const kept = loaded.record.shortcuts ?? {};
			for (const name of this.#commandNames(loaded.record.manifest)) {
				const action = ACTION_COMMANDS.includes(name);
				const shortcut = kept[name]?.shortcut ?? '';
				rows.push({
					id: loaded.record.id,
					name,
					description: action
						? ACTION_DESCRIPTION
						: (loaded.manifest.commands?.[name]?.description ?? ''),
					shortcut,
					scope: kept[name]?.scope ?? 'chrome',
				});
			}
		}
		return rows;
	}

	/**
	 * A command's shortcut, as the shortcuts page sets it
	 * (developerPrivate.updateExtensionCommand): another command that held
	 * it loses it (AddKeybindingPref with allow_overrides); '' clears it
	 */
	async setShortcut(
		id: string,
		name: string,
		given: string,
	): Promise<ExtensionShortcut[]> {
		await this.ready();
		const loaded = this.#found(id);
		if (!this.#commandNames(loaded.record.manifest).includes(name))
			throw new ExtensionError(
				'not-found',
				`${loaded.manifest.name} has no command ${name}.`,
			);
		// (a key Chrome's input would refuse clears the command's, as
		// updateExtensionCommand does: measured on 157)
		let shortcut: string;
		try {
			shortcut = normalizeShortcut(String(given ?? ''));
		} catch (error) {
			shortcut = '';
		}
		if (shortcut)
			for (const other of this.#loaded.values())
				for (const [command, kept] of Object.entries(
					other.record.shortcuts ?? {},
				))
					if (
						kept.shortcut === shortcut &&
						!(other.record.id === id && command === name)
					) {
						other.record = {
							...other.record,
							shortcuts: {
								...other.record.shortcuts,
								[command]: { ...kept, shortcut: '' },
							},
						};
						await records.put(other.record);
						if (other.record.id !== id)
							this.#emit({ type: 'commands', id: other.record.id });
					}
		const current = this.#found(id);
		current.record = {
			...current.record,
			shortcuts: {
				...current.record.shortcuts,
				[name]: {
					scope: current.record.shortcuts?.[name]?.scope ?? 'chrome',
					shortcut,
				},
			},
		};
		await records.put(current.record);
		this.#emit({ type: 'commands', id });
		return this.commands();
	}

	/** a command's scope: In Chrome, or Global (Chrome keeps it; no key reaches STomp from outside the browser) */
	async setCommandScope(
		id: string,
		name: string,
		scope: string,
	): Promise<ExtensionShortcut[]> {
		await this.ready();
		const loaded = this.#found(id);
		if (scope !== 'chrome' && scope !== 'global')
			throw new ExtensionError(
				'bad-source',
				`${scope} is not a command scope.`,
			);
		const kept = loaded.record.shortcuts?.[name];
		if (!kept)
			throw new ExtensionError(
				'not-found',
				`${loaded.manifest.name} has no command ${name}.`,
			);
		loaded.record = {
			...loaded.record,
			shortcuts: {
				...loaded.record.shortcuts,
				[name]: { ...kept, scope },
			},
		};
		await records.put(loaded.record);
		this.#emit({ type: 'commands', id });
		return this.commands();
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
		return (
			!!loaded?.record.enabled &&
			hostPermitted(loaded.granted, url.href) &&
			this.siteGranted(loaded, url.href)
		);
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
		// (Chrome's ExtensionInfo, as the store's pages read it)
		const describe = managementInfo;
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
