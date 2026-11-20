// The extensions layer's types (docs/extensions.md): what the host's
// `controller.extensions` takes and answers, the manifest as the worker
// reads it, and what travels between the service worker, the controller's
// hub and the runtime in extension contexts. Types and constants only: the
// controller, the worker and the runtime asset all import this file.

export type Icons = Record<string, string>;

export interface ManifestAction {
	default_icon?: string | Icons;
	default_title?: string;
	default_popup?: string;
}

export type RunAt = 'document_start' | 'document_end' | 'document_idle';
export type World = 'ISOLATED' | 'MAIN' | 'USER_SCRIPT';

export interface ManifestContentScript {
	matches?: string[];
	exclude_matches?: string[];
	include_globs?: string[];
	exclude_globs?: string[];
	js?: string[];
	css?: string[];
	run_at?: RunAt;
	all_frames?: boolean;
	match_about_blank?: boolean;
	match_origin_as_fallback?: boolean;
	world?: World;
}

/** manifest.json, as much of it as STomp reads (anything else is kept as it is) */
export interface Manifest {
	name: string;
	short_name?: string;
	description?: string;
	version?: string;
	manifest_version?: number;
	default_locale?: string;
	key?: string;
	icons?: Icons;
	action?: ManifestAction;
	browser_action?: ManifestAction;
	page_action?: ManifestAction;
	background?: {
		service_worker?: string;
		type?: 'module' | 'classic';
		page?: string;
		scripts?: string[];
		persistent?: boolean;
	};
	content_scripts?: ManifestContentScript[];
	options_page?: string;
	options_ui?: { page?: string; open_in_tab?: boolean };
	permissions?: string[];
	optional_permissions?: string[];
	host_permissions?: string[];
	declarative_net_request?: {
		rule_resources?: { id: string; enabled?: boolean; path: string }[];
	};
	commands?: Record<
		string,
		{ description?: string; suggested_key?: Record<string, string> }
	>;
	web_accessible_resources?:
		| string[]
		| { resources?: string[]; matches?: string[]; extension_ids?: string[] }[];
	update_url?: string;
	[key: string]: unknown;
}

/**
 * An unpacked extension: its files by path (`manifest.json` among them), as
 * text or bytes. A folder picked with `<input webkitdirectory>` can be
 * handed over as its FileList or File[] too: each File's
 * `webkitRelativePath` names it, the folder's own name taken off.
 */
export type ExtensionFiles = Record<
	string,
	string | ArrayBuffer | ArrayBufferView | Blob
>;

/**
 * What `extensions.install()` takes: a .crx or .zip as bytes, a Blob or a
 * File; a Chrome Web Store id or a Web Store (or update service) URL, which
 * the worker downloads through the transport; an unpacked extension's file
 * map, or a folder's files.
 */
export type ExtensionSource =
	| ArrayBuffer
	| ArrayBufferView
	| Blob
	| string
	| ExtensionFiles
	| FileList
	| File[];

export interface InstallOptions {
	/** a name for the package, for an id when it carries none (default: the File's name) */
	filename?: string;
	/** installed turned off (default: on; an update keeps the extension's state) */
	enabled?: boolean;
	/**
	 * Installed by policy (as an enterprise policy installs one in Chrome):
	 * an MV3 extension may then block in webRequest. Default false.
	 */
	policy?: boolean;
}

/** where an installed extension came from */
export type ExtensionOrigin = 'package' | 'webstore' | 'unpacked';

/** an installed extension, as `list()` and `get()` answer */
export interface ExtensionInfo {
	id: string;
	name: string;
	shortName: string;
	version: string;
	description: string;
	manifestVersion: number;
	enabled: boolean;
	/** installed by policy (InstallOptions.policy) */
	policy: boolean;
	installedAt: number;
	updatedAt: number;
	source: ExtensionOrigin;
	/** the Web Store id it updates from, for an extension installed from there */
	webStoreId: string | null;
	/** the largest icon's URL, routable through the controller (`frame.go`, `<img>` via `route`) */
	iconUrl: string | null;
	/** the URL of its options page, null without one */
	optionsUrl: string | null;
	/** whether it has a toolbar action (action / browser_action / page_action) */
	hasAction: boolean;
	permissions: string[];
	hostPermissions: string[];
	/** how many content_scripts entries it has */
	contentScripts: number;
	/** its background: none, a page (MV2), or a service worker (MV3, emulated in a page) */
	background: 'none' | 'page' | 'service_worker';
	/** the manifest, localized (`__MSG_*__` filled in) */
	manifest: Manifest;
	/** what went wrong reading parts of it (an unreadable ruleset, a missing content script) */
	warnings: string[];
}

/** an extension's toolbar button, for one tab or its defaults */
export interface ActionState {
	title: string;
	/** a URL an `<img>` can show directly: a data: URL, or the icon's routed URL */
	iconUrl: string | null;
	badgeText: string;
	/** CSS color */
	badgeColor: string;
	/** CSS color, null for the browser's choice */
	badgeTextColor: string | null;
	/** the popup page's URL, null when a click fires `action.onClicked` */
	popupUrl: string | null;
	enabled: boolean;
}

/** `actions()`'s rows: one per enabled extension that has an action */
export interface ExtensionAction extends ActionState {
	id: string;
	name: string;
}

/** what `onChange` hears */
export interface ExtensionsChange {
	type:
		| 'installed'
		| 'updated'
		| 'removed'
		| 'enabled'
		| 'disabled'
		| 'action'
		| 'notification'
		| 'menus'
		| 'tab'
		| 'ready';
	/** the extension it is about (none for `ready`) */
	id?: string;
	/** the tab it is about (an action change for one tab) */
	tabId?: number;
	/**
	 * `tab`: a tab the extension opened (tabs.create, its options page)
	 * while the host has none to open it from: the host opens it, as it
	 * would in onOpen
	 */
	url?: string;
	/** `notification`: what the extension showed or cleared */
	notification?: ExtensionNotification;
}

export interface ExtensionNotification {
	id: string;
	cleared?: boolean;
	type?: string;
	title?: string;
	message?: string;
	iconUrl?: string;
	buttons?: { title: string }[];
	requireInteraction?: boolean;
	silent?: boolean;
}

/** `clickAction()`'s answer */
export type ClickResult = 'popup' | 'clicked' | 'disabled';

/** why a call of the extensions API failed (ExtensionError.code) */
export type ExtensionErrorCode =
	| 'bad-source'
	| 'bad-package'
	| 'no-manifest'
	| 'bad-manifest'
	| 'not-found'
	| 'webstore'
	| 'no-update'
	| 'no-popup'
	| 'no-controller'
	| 'unsupported';

/** an error of the extensions API: `code` says which, the message says what to do */
export class ExtensionError extends Error {
	readonly code: ExtensionErrorCode;
	constructor(code: ExtensionErrorCode, message: string) {
		super(message);
		this.name = 'ExtensionError';
		this.code = code;
	}
}

/** the popup a host showed (`mountPopup`, `openPopup`) */
export interface PopupHandle {
	readonly id: string;
	readonly tabId: number | null;
	readonly element: HTMLIFrameElement;
	/** the popup's document's size, clamped as Chrome clamps it (25-800 x 25-600), once it reported one */
	readonly size: { width: number; height: number } | null;
	/** called with each size the popup reports */
	onResize(listener: (size: { width: number; height: number }) => void): void;
	/** called once, when the popup closed itself (`window.close()`) or `close()` was called */
	onClose(listener: () => void): void;
	/** unload the popup (and remove its element when `openPopup` made it) */
	close(): void;
}

/** what `options()` answers */
export interface ExtensionOptions {
	/** the page's URL, to `frame.go()` or `mountOptions()` */
	url: string;
	/** the same as `chrome-extension://<id>/...`, for an address bar */
	displayUrl: string;
	/** Chrome opens it in a tab rather than in the extensions page */
	openInTab: boolean;
}

// ---- what travels between the worker, the hub and the runtime -------------

/** one content_scripts entry (or scripting registration) as a document's shell carries it */
export interface ShippedEntry {
	/** its key in the worker's script routes and the runtime's table */
	key: string;
	runAt: RunAt;
	world: World;
	/** has scripts (the shell loaded a route that defines its function) */
	js: boolean;
	/** its stylesheets, rewritten, joined */
	css: string;
}

/** what an extension context knows about its extension (the hook payload carries it) */
export interface ShippedExtension {
	id: string;
	name: string;
	version: string;
	manifestVersion: number;
	/** the extension's origin, `https://<id>.invalid` */
	origin: string;
	/** the manifest (content scripts get it too: getManifest is synchronous) */
	manifest: Manifest;
	/** i18n messages, most specific locale first (lowercased keys) */
	messages: Record<
		string,
		{ message: string; placeholders?: Record<string, { content: string }> }
	>[];
	/** the browser's UI locale, `en_US` */
	uiLocale: string;
	/** granted permissions and host permissions */
	permissions: string[];
	/** may block in webRequest (MV2 with webRequestBlocking, or policy-installed) */
	blocking: boolean;
	/** userScripts.configureWorld gave the USER_SCRIPT world messaging */
	userScriptMessaging?: boolean;
	/** a content document's entries that match it */
	entries?: ShippedEntry[];
}

/** what the shell hands the runtime (its `prepare`) */
export interface RuntimePayload {
	/** the BroadcastChannel names' prefix: the controller's address */
	channel: string;
	/** this document's service worker client id, '' when unknown */
	client: string;
	/** the document's real URL */
	url: string;
	/** the outermost proxied document of its frame */
	top: boolean;
	/** what the worker checks on a content document's calls, by extension */
	tokens: Record<string, string>;
	/** a content document: the extensions whose scripts run in it */
	content?: ShippedExtension[];
	/** an extension page: its extension, and what the worker made of its path */
	page?: ShippedExtension & { kind: ContextKind };
	/** an extension page that emulates an MV3 service worker: its script, module or classic */
	serviceWorker?: { url: string; module: boolean };
}

/** the kinds of extension context */
export type ContextKind =
	'background' | 'popup' | 'tab' | 'offscreen' | 'content';

/**
 * The window name the hub gives an extension page's frame (read by the
 * runtime with the native getter, before the inject shadows it): the kind
 * and, for a popup, its tab
 */
export const CONTEXT_NAME_PREFIX = 'ext-context:';

/** the global the runtime asset leaves for the shell's scripts (deleted as the page's document opens) */
export const RUNTIME_GLOBAL = '__extensionRuntime';

/** the generated page an extension's background runs in */
export const BACKGROUND_PAGE = '_generated_background_page.html';

/** the generated page an MV3 extension's service worker is emulated in */
export const SERVICE_WORKER_PAGE = '_generated_service_worker.html';

/** the meta of a service worker's page that lists the imports it loaded ahead (the runtime's importScripts skips them) */
export const IMPORTED_META = 'imported-scripts';

/**
 * Where an MV3 service worker's page is: in its script's folder, so what the
 * script resolves against its own URL (a fetch of `../config/x`, a relative
 * importScripts) resolves as in the worker
 */
export const serviceWorkerPage = (script: string) =>
	`${script.replace(/^\/+/, '').replace(/[^/]*$/, '')}${SERVICE_WORKER_PAGE}`;

/** the worker's route for an extension context's calls (`<directory>extapi`) */
export const EXTENSION_API_ROUTE = 'extapi';

/** the route kind of a content script's rewritten function (`<directory>extcs/...`) */
export const CONTENT_SCRIPT_ROUTE = 'extcs';

/** the emulated origin's host suffix: `https://<id>.invalid` */
export const EXTENSION_HOST_SUFFIX = '.invalid';

/** a webRequest listener a background context registered, as the hub pushes it to the worker */
export interface WebRequestListener {
	extensionId: string;
	event:
		| 'onBeforeRequest'
		| 'onBeforeSendHeaders'
		| 'onSendHeaders'
		| 'onHeadersReceived'
		| 'onResponseStarted'
		| 'onCompleted'
		| 'onErrorOccurred';
	urls: string[];
	types?: string[];
	tabId?: number;
	/** `extraInfoSpec` has 'blocking' and the extension may block */
	blocking: boolean;
	/** `extraInfoSpec` (requestHeaders, responseHeaders, requestBody, extraHeaders) */
	extra: string[];
}

/** what a webRequest listener is told (Chrome's details object) */
export interface WebRequestDetails {
	requestId: string;
	url: string;
	method: string;
	type: string;
	tabId: number;
	frameId: number;
	parentFrameId: number;
	initiator?: string;
	timeStamp: number;
	statusCode?: number;
	statusLine?: string;
	fromCache?: boolean;
	error?: string;
	requestHeaders?: { name: string; value: string }[];
	responseHeaders?: { name: string; value: string }[];
	/** the service worker client of the document that made it (the hub turns it into tabId, frameId) */
	client?: string;
}

/** what blocking listeners answered, merged */
export interface WebRequestVerdict {
	cancel?: boolean;
	redirectUrl?: string;
	requestHeaders?: { name: string; value: string }[];
	responseHeaders?: { name: string; value: string }[];
}

/** a command the controller sends the worker's extension backend (`extensions` RPC) */
export type ExtensionCommand =
	| {
			op: 'install';
			bytes?: ArrayBuffer;
			files?: Record<string, ArrayBuffer>;
			webStore?: string;
			filename?: string;
			enabled?: boolean;
			policy?: boolean;
	  }
	| { op: 'list' }
	| { op: 'get'; id: string }
	| { op: 'enable'; id: string; enabled: boolean }
	| { op: 'remove'; id: string }
	| { op: 'update'; id: string }
	| { op: 'webRequest'; listeners: WebRequestListener[] }
	| { op: 'storage'; id: string; area: string; call: string; args: unknown[] }
	| { op: 'state'; id: string; key: string; value?: unknown; write?: boolean }
	| {
			op: 'dnr';
			id: string;
			call: string;
			args: unknown[];
	  }
	/** a hub tells which tab a client's document is in (declarativeNetRequest's tab ids) */
	| { op: 'place'; client: string; tabId: number };
