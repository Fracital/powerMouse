// The Chrome Web Store's page (docs/extensions.md "The Chrome Web Store"):
// Chrome gives chromewebstore.google.com, and no other origin,
// chrome.webstorePrivate and chrome.management, which its "Add to Chrome"
// and "Remove from Chrome" buttons call. The runtime defines them in the
// store's documents (src/extensions/runtime/webstore.ts) and every call
// comes here, on `<directory>extapi`: the worker reads the calling
// document's real URL from its own client, so a page of another origin
// that calls gets a refusal, whatever it sends. The calls answer as
// Chromium's (webstore_private_api.cc, management_api.cc,
// extension_install_status.cc, crx_installer.cc): their results, their
// error strings and the status the store shows. The install dialog and the
// uninstall dialog are the host's (Controllerbound.extensionPrompt), shown
// only when the page's click activated the controller's document as the
// page called (Controllerbound.extensionGesture).
import { EXTENSION_ID } from '../../extensions/crx';
import { cleanPath } from '../../extensions/origin';
import { permissionMessages } from '../../extensions/permissionMessages';
import type {
	ExtensionPromptAnswer,
	ExtensionPromptRequest,
	Manifest,
} from '../../extensions/types';
import { getPublicSuffix } from '../../suffix';
import type { ExtensionRegistry, Loaded } from './registry';
import { extensionState } from './store';
import { isTheme } from './themes';

declare const self: ServiceWorkerGlobalScope;

/** The only origin that can use the store bindings. */
export const STORE_HOST = 'chromewebstore.google.com';

/** whether a real URL is a page of the store (https://chromewebstore.google.com/*) */
export function isStoreURL(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.origin === `https://${STORE_HOST}`;
	} catch (error) {
		return false;
	}
}

/** what the worker reaches through the controller of an address (serviceWorker.ts sets them) */
export const webStore = {
	/** the host asks the user */
	prompt: (
		_directory: string,
		_request: ExtensionPromptRequest,
	): Promise<ExtensionPromptAnswer> => Promise.resolve('cancel'),
	/** whether a click activated the page `client` as it called, null when its controller cannot say (its dialog reads it then) */
	gesture: (_directory: string, _client: string): Promise<boolean | null> =>
		Promise.resolve(false),
	/** a GET through the controller's transport, without the jar's cookies (the icon, the package) */
	fetch: (_directory: string, _url: string): Promise<Response> =>
		Promise.reject(new Error('no controller')),
};

// ---- Chromium's words ------------------------------------------------------

const INVALID_ID = 'Invalid id';
const INVALID_ICON_URL = 'Invalid icon url';
const INVALID_MANIFEST = 'Invalid manifest';
const ALREADY_INSTALLED = 'This item is already installed';
const USER_CANCELLED = 'User cancelled install';
const IMAGE_DECODE = 'Image decode failed';
/** Chromium answers no gesture error for an install (it shows its dialog); STomp shows the host's only for a click */
export const INSTALL_GESTURE =
	'This function must be called during a user gesture';
export const UNINSTALL_GESTURE =
	'chrome.management.uninstall requires a user gesture.';
const MANIFEST_INVALID = 'Manifest file is invalid';
const noExtension = (id: string) => `Failed to find extension with id ${id}.`;
const cannotModify = (id: string) =>
	`Extension ${id} cannot be modified by user.`;
const notAnApp = (id: string) => `Extension ${id} is not an App.`;

/** the update service a store install downloads from */
const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

/** an answer: a value, or an error (with the result the callback still gets: ErrorWithArgumentsDoNotUse) */
export type StoreAnswer =
	{ value: unknown } | { error: string; result?: unknown };

class StoreError extends Error {
	constructor(
		message: string,
		readonly result?: unknown,
	) {
		super(message);
	}
}

// ---- the extensions as the store sees them ---------------------------------

/** management.ExtensionInfo (CreateExtensionInfo), as the store's pages and the extensions with "management" read it */
export function managementInfo(loaded: Loaded): Record<string, unknown> {
	const { record, manifest } = loaded;
	const enabled = record.enabled;
	const store = record.source === 'webstore';
	const apis = [...loaded.granted]
		.filter((name) => name !== '<all_urls>' && !name.includes('://'))
		.sort();
	const hosts = [...loaded.granted]
		.filter((name) => name === '<all_urls>' || name.includes('://'))
		.sort();
	const options = manifest.options_ui?.page ?? manifest.options_page;
	const raw = record.manifest as Manifest & {
		theme?: unknown;
		homepage_url?: string;
		update_url?: string;
		version_name?: string;
		offline_enabled?: boolean;
	};
	const info: Record<string, unknown> = {
		id: record.id,
		name: manifest.name,
		shortName: manifest.short_name ?? manifest.name,
		description: manifest.description ?? '',
		version: manifest.version ?? '',
		// (always there, '' without version_name: measured on Chrome 157)
		versionName: typeof raw.version_name === 'string' ? raw.version_name : '',
		mayDisable: !record.policy,
		...(enabled ? {} : { mayEnable: !record.policy }),
		enabled,
		...(enabled ? {} : { disabledReason: 'unknown' }),
		isApp: false,
		type: loaded.theme ? 'theme' : 'extension',
		homepageUrl:
			typeof raw.homepage_url === 'string'
				? raw.homepage_url
				: store
					? `https://${STORE_HOST}/detail/${record.id}`
					: '',
		// the manifest's (ManifestURL::GetUpdateURL: a store package's may be http:)
		...(typeof raw.update_url === 'string'
			? { updateUrl: raw.update_url }
			: store
				? { updateUrl: UPDATE_URL }
				: {}),
		offlineEnabled: raw.offline_enabled === true,
		optionsUrl: options
			? `chrome-extension://${record.id}/${cleanPath(options)}`
			: '',
		...(Object.keys(manifest.icons ?? {}).length
			? {
					icons: Object.keys(manifest.icons ?? {})
						.map(Number)
						.sort((a, b) => a - b)
						.map((size) => ({
							size,
							url: `chrome://extension-icon/${record.id}/${size}/0`,
						})),
				}
			: {}),
		permissions: apis,
		hostPermissions: hosts,
		installType: record.policy
			? 'admin'
			: record.source === 'unpacked'
				? 'development'
				: 'normal',
	};
	// in Chrome's order: the dictionary the bindings convert is sorted
	return Object.fromEntries(
		Object.keys(info)
			.sort()
			.map((key) => [key, info[key]]),
	);
}

/** every extension, enabled ones first (getAll's order) */
async function everyExtension(registry: ExtensionRegistry): Promise<Loaded[]> {
	const loaded = (await registry.list())
		.map((info) => registry.get(info.id))
		.filter((item): item is Loaded => !!item);
	return [
		...loaded.filter((item) => item.record.enabled),
		...loaded.filter((item) => !item.record.enabled),
	];
}

/** the registry ICANN suffix of a host, '' for none (permission_message_util GetDistinctHosts) */
function registryOf(host: string): string {
	try {
		const suffix = getPublicSuffix(host, false);
		return suffix ?? '';
	} catch (error) {
		return '';
	}
}

/** what an installed extension's dialog lists */
export function warningsOf(manifest: Record<string, unknown>) {
	return permissionMessages(manifest, registryOf);
}

/** a name as Chrome's dialogs show it: 75 characters at most (ui_util.cc) */
const shown = (name: string) =>
	[...name].length > 75 ? `${[...name].slice(0, 74).join('')}…` : name;

// ---- installs --------------------------------------------------------------

interface Approval {
	client: string;
	expires: number;
	manifest: Record<string, unknown>;
	directory: string;
}

/** the store's document that called, and its click as read when it called */
interface StorePage {
	url: string;
	client: string;
	gesture: Promise<boolean | null>;
}

/**
 * The prompt's `gestured`, or the gesture refusal: Chrome takes the call's
 * gesture with the call, so the click is read when the page calls
 * (storeCall), never after the icon's download
 */
async function gestured(page: StorePage): Promise<{ gestured?: true } | null> {
	const gesture = await page.gesture;
	if (gesture === false) return null;
	return gesture ? { gestured: true } : {};
}

/** what beginInstallWithManifest3 approved, until completeInstall takes it (PendingApprovals) */
const approvals = new Map<string, Approval>();
/** the ids an install is under way for (InstallTracker's active installs) */
const active = new Set<string>();

function expireApprovals() {
	for (const [id, approval] of approvals)
		if (approval.expires <= Date.now()) approvals.delete(id);
}

/** a manifest the store sent: JSON (RFC), an object Chrome can make an extension of */
function storeManifest(text: unknown): Record<string, unknown> | null {
	if (typeof text !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return null;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const manifest = value as Record<string, unknown>;
	if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string')
		return null;
	return manifest;
}

/** getExtensionStatus's ExtensionInstallStatus (PerformSynchronousChecks) */
function installStatus(
	loaded: Loaded | undefined,
	manifestVersion: number,
	theme: boolean,
): string {
	if (loaded?.record.policy) return 'force_installed';
	if (loaded?.record.enabled) return 'enabled';
	// Chrome 157 installs no Manifest V2 extension (ManifestV2Handler,
	// hard_disable), but a theme of any version (most of the store's are MV2)
	if (manifestVersion < 3 && !theme) return 'deprecated_manifest_version';
	if (loaded) return 'disabled';
	return 'installable';
}

/** the icon the store names, fetched and decoded as Chrome's dialog takes it (WebstoreInstallHelper) */
async function iconOf(directory: string, url: string): Promise<string> {
	let response: Response;
	try {
		response = await webStore.fetch(directory, url);
	} catch (error) {
		throw new StoreError(IMAGE_DECODE, 'icon_error');
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (response.status !== 200 || !bytes.length)
		throw new StoreError(IMAGE_DECODE, 'icon_error');
	const type = (response.headers.get('content-type') ?? 'image/png')
		.split(';')[0]
		.trim();
	try {
		const bitmap = await createImageBitmap(
			new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
		);
		bitmap.close();
	} catch (error) {
		throw new StoreError(IMAGE_DECODE, 'icon_error');
	}
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return `data:${type.startsWith('image/') ? type : 'image/png'};base64,${btoa(binary)}`;
}

async function beginInstall(
	registry: ExtensionRegistry,
	directory: string,
	page: StorePage,
	details: Record<string, unknown>,
): Promise<string> {
	const id = String(details.id);
	if (!EXTENSION_ID.test(id.toLowerCase()))
		throw new StoreError(INVALID_ID, 'invalid_id');
	let iconUrl: string | null = null;
	if (typeof details.iconUrl === 'string') {
		try {
			iconUrl = new URL(details.iconUrl, page.url).href;
		} catch (error) {
			throw new StoreError(INVALID_ICON_URL, 'invalid_icon_url');
		}
	}
	expireApprovals();
	if (registry.get(id) || active.has(id) || approvals.has(id))
		throw new StoreError(ALREADY_INSTALLED, 'already_installed');
	active.add(id);
	try {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(details.manifest));
		} catch (error) {
			throw new StoreError(
				error instanceof Error ? error.message : INVALID_MANIFEST,
				'manifest_error',
			);
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new StoreError('Manifest is not a dictionary', 'manifest_error');
		const icon = iconUrl ? await iconOf(directory, iconUrl) : null;
		const manifest = storeManifest(details.manifest);
		if (!manifest) throw new StoreError(INVALID_MANIFEST, 'manifest_error');
		const theme = isTheme(manifest as Manifest);
		if (manifest.app || (!theme && manifest.manifest_version !== 3))
			throw new StoreError(
				'Unsupported extension type',
				'unsupported_extension_type',
			);
		if (details.esbAllowlist === false)
			throw new StoreError(
				'The store flagged this extension for an additional safety check.',
				'blocked_by_policy',
			);
		const name =
			typeof details.localizedName === 'string' && details.localizedName
				? details.localizedName
				: String(manifest.name);
		const gesture = await gestured(page);
		if (!gesture)
			throw new StoreError(INSTALL_GESTURE, 'user_gesture_required');
		// a theme installs on the click with no dialog (Chrome 157 measured):
		// the controller asks the host nothing
		const answer = await webStore.prompt(directory, {
			...gesture,
			kind: theme ? 'theme' : 'install',
			id,
			name: shown(name),
			iconUrl: icon,
			permissions: theme ? [] : warningsOf(manifest),
			url: page.url,
			client: page.client,
		});
		if (answer === 'gesture')
			throw new StoreError(INSTALL_GESTURE, 'user_gesture_required');
		if (answer !== 'accept')
			throw new StoreError(USER_CANCELLED, 'user_cancelled');
		approvals.set(id, {
			manifest,
			directory,
			client: page.client,
			expires: Date.now() + 120_000,
		});
		// (the old store took '' for success, and the new one takes both)
		return '';
	} finally {
		active.delete(id);
	}
}

/** Compare the manifest the user approved, ignoring object key order. */
function manifestMatches(
	approved: Record<string, unknown>,
	downloaded: Record<string, unknown>,
): boolean {
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.keys(value as object)
							.sort()
							.map((key) => [
								key,
								canonical((value as Record<string, unknown>)[key]),
							]),
					)
				: value;
	return (
		JSON.stringify(canonical(approved)) ===
		JSON.stringify(canonical(downloaded))
	);
}

async function completeInstall(
	registry: ExtensionRegistry,
	directory: string,
	client: string,
	expected: string,
): Promise<undefined> {
	if (!EXTENSION_ID.test(expected.toLowerCase()))
		throw new StoreError(INVALID_ID);
	expireApprovals();
	const approval = approvals.get(expected);
	if (
		!approval ||
		approval.client !== client ||
		approval.directory !== directory
	)
		throw new StoreError(
			`${expected} does not match a previous call to beginInstallWithManifest3`,
		);
	approvals.delete(expected);
	active.add(expected);
	try {
		await registry.install(
			{ op: 'install', webStore: expected },
			async (url) => {
				let response: Response;
				try {
					response = await webStore.fetch(directory, url);
				} catch (error) {
					throw new StoreError('Download interrupted');
				}
				if (response.status === 401 || response.status === 403)
					throw new StoreError('Access denied.');
				if (response.status !== 200)
					throw new StoreError(
						'Download was not a valid extension or user script',
					);
				return new Uint8Array(await response.arrayBuffer());
			},
			(read) => {
				if (read.id !== expected)
					throw new StoreError(
						`Expected ID "${expected}", but ID was "${read.id}"`,
					);
				if (
					!manifestMatches(
						approval.manifest,
						read.manifest as unknown as Record<string, unknown>,
					)
				)
					throw new StoreError(MANIFEST_INVALID);
			},
			client,
		);
	} catch (error) {
		// the registry's own words for what it could not read or download
		const cause = (error as { cause?: unknown })?.cause;
		if (cause instanceof StoreError) throw cause;
		if (error instanceof StoreError) throw error;
		throw new StoreError(
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		active.delete(expected);
	}
	return undefined;
}

// ---- the calls -------------------------------------------------------------

const VERSION_HINTS = ['fullVersionList'];

/** the browser's full version (version_info::GetVersionNumber) */
async function fullVersion(): Promise<string> {
	const data = (
		navigator as Navigator & {
			userAgentData?: {
				getHighEntropyValues(hints: string[]): Promise<{
					fullVersionList?: { brand: string; version: string }[];
				}>;
			};
		}
	).userAgentData;
	try {
		const list = (await data?.getHighEntropyValues(VERSION_HINTS))
			?.fullVersionList;
		const brand =
			list?.find((item) => item.brand === 'Google Chrome') ??
			list?.find((item) => item.brand === 'Chromium');
		if (brand?.version) return brand.version;
	} catch (error) {
		// the reduced version below
	}
	return /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '';
}

async function webstorePrivate(
	registry: ExtensionRegistry,
	directory: string,
	page: StorePage,
	call: string,
	args: unknown[],
): Promise<unknown> {
	switch (call) {
		case 'beginInstallWithManifest3':
			return beginInstall(
				registry,
				directory,
				page,
				(args[0] ?? {}) as Record<string, unknown>,
			);
		case 'completeInstall':
			return completeInstall(registry, directory, page.client, String(args[0]));
		case 'getExtensionStatus': {
			const id = String(args[0]);
			if (!EXTENSION_ID.test(id.toLowerCase()))
				throw new StoreError(INVALID_ID);
			let version = 3;
			let theme = false;
			if (args[1] !== undefined && args[1] !== null) {
				const manifest = storeManifest(args[1]);
				if (!manifest) throw new StoreError(INVALID_MANIFEST);
				version = Number(manifest.manifest_version) || 1;
				theme = isTheme(manifest as Manifest);
			}
			return installStatus(registry.get(id), version, theme);
		}
		case 'getBrowserLogin':
			// (no account is signed in to the browser STomp runs in)
			return { login: '' };
		case 'getStoreLogin':
			return String((await extensionState.get('_', 'storeLogin')) ?? '');
		case 'setStoreLogin':
			await extensionState.put('_', 'storeLogin', String(args[0]));
			return undefined;
		case 'getFullChromeVersion':
			return { version_number: await fullVersion() };
		case 'getReferrerChain':
			// Safe Browsing's referrer chain: none here, as with it off
			return '';
		case 'getMV2DeprecationStatus':
			return 'hard_disable';
		case 'shouldShowEnterprisePromotionBanner':
			return 'PROMOTION_TYPE_UNSPECIFIED';
		case 'isInIncognitoMode':
		case 'getIsLauncherEnabled':
		case 'isPendingCustodianApproval':
			return false;
		case 'enableAppLauncher':
		case 'logEnterprisePromoShown':
		case 'onEnterprisePromoClick':
			return undefined;
		default:
			throw new StoreError(`webstorePrivate.${call} is not a call.`);
	}
}

async function management(
	registry: ExtensionRegistry,
	directory: string,
	page: StorePage,
	call: string,
	args: unknown[],
): Promise<unknown> {
	const id = String(args[0]);
	const found = () => {
		const loaded = registry.get(id);
		if (!loaded) throw new StoreError(noExtension(id));
		return loaded;
	};
	switch (call) {
		case 'getAll':
			return (await everyExtension(registry)).map(managementInfo);
		case 'get':
			return managementInfo(found());
		case 'getPermissionWarningsById':
			return warningsOf(
				found().record.manifest as unknown as Record<string, unknown>,
			).map((item) => item.message);
		case 'setEnabled': {
			const loaded = found();
			if (loaded.record.policy) throw new StoreError(cannotModify(id));
			if (loaded.record.enabled !== !!args[1])
				await registry.setEnabled(id, !!args[1]);
			return undefined;
		}
		case 'uninstall': {
			const loaded = found();
			if (loaded.record.policy) throw new StoreError(cannotModify(id));
			const info = await registry.infoOf(id);
			const gesture = await gestured(page);
			if (!gesture) throw new StoreError(UNINSTALL_GESTURE);
			const answer = await webStore.prompt(directory, {
				...gesture,
				kind: 'uninstall',
				id,
				name: shown(loaded.manifest.name),
				iconUrl: info?.iconUrl ?? null,
				permissions: [],
				url: page.url,
				client: page.client,
			});
			if (answer === 'gesture') throw new StoreError(UNINSTALL_GESTURE);
			if (answer !== 'accept')
				throw new StoreError(`Extension ${id} uninstall canceled by user.`);
			// (removed in another window while the dialog showed)
			if (!registry.get(id)) throw new StoreError(noExtension(id));
			await registry.remove(id);
			return undefined;
		}
		case 'launchApp':
		case 'createAppShortcut':
		case 'setLaunchType':
			found();
			throw new StoreError(notAnApp(id));
		case 'generateAppForLink':
			throw new StoreError(
				'chrome.management.generateAppForLink is not supported on this platform.',
			);
		default:
			throw new StoreError(`management.${call} is not a call.`);
	}
}

/** the calls that show a dialog, only on a click */
const GESTURE_CALLS = new Set([
	'webstorePrivate.beginInstallWithManifest3',
	'management.uninstall',
]);

/**
 * A call of the store's page: refused unless the calling document is the
 * store's, by its own client's URL (never by what the call says)
 */
export async function storeCall(
	registry: ExtensionRegistry,
	directory: string,
	client: string | undefined,
	realURL: (routed: string) => string,
	area: string,
	call: string,
	args: unknown[],
): Promise<{ status: number; body: StoreAnswer }> {
	// the click, read as the page calls (Chrome takes the call's gesture
	// with it): what the worker does before its dialog may take longer than
	// the activation lasts. Only the store's page goes on to use it
	const gesture =
		client && GESTURE_CALLS.has(`${area}.${call}`)
			? webStore.gesture(directory, client).catch(() => null)
			: Promise.resolve(false);
	const found = client ? await self.clients.get(client) : undefined;
	const url = found ? realURL(found.url) : '';
	if (!found || found.type !== 'window' || !isStoreURL(url))
		return {
			status: 403,
			body: { error: `This page may not call ${area}.${call}.` },
		};
	await registry.sweepThemes();
	const page: StorePage = { url, client: found.id, gesture };
	try {
		const value =
			area === 'webstorePrivate'
				? await webstorePrivate(registry, directory, page, call, args)
				: area === 'management'
					? await management(registry, directory, page, call, args)
					: Promise.reject(new StoreError(`${area} is not an area.`));
		return { status: 200, body: { value: await value } };
	} catch (error) {
		if (error instanceof StoreError)
			return {
				status: 200,
				body: {
					error: error.message,
					...(error.result !== undefined ? { result: error.result } : {}),
				},
			};
		return {
			status: 200,
			body: { error: error instanceof Error ? error.message : String(error) },
		};
	}
}
