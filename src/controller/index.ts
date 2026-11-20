import type {
	ProxyTransport,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { acceptLanguage } from '../acceptLanguage';
import {
	resolveAdblockOptions,
	withAdblockLists,
	type AdblockApplied,
	type AdblockInit,
	type AdblockList,
	type AdblockOptions,
	type SiteShields,
} from '../blocker/types';
import {
	assetFile,
	assetName,
	Assets,
	Config,
	ConfigCodec,
	DEFAULT_ASSETS,
	WASM_ASSETS,
	type BundleAsset,
	type HostGeometry,
} from '../config';
import {
	helperNames,
	mintClientName,
	validateNames,
	type HelperNames,
} from '../helperNames';
import {
	resolveHooks,
	validateHooks,
	type HookErrorInfo,
	type InitHooks,
} from '../hooks';
import type { IsolationEngine } from '../isolation';
import { askHost } from '../passkeys/host';
import type {
	PasskeyAnswer,
	PasskeyCommand,
	PasskeyInfo,
	PasskeyManager,
	PasskeyPrompt,
	PasskeyRequest as PasskeyRequestBase,
	PasskeysConfig,
	PasskeysInit as PasskeysInitOf,
} from '../passkeys/types';
import { coreFile, injectDocumentFile, libraryFile } from '../routeURL';
import { isUrlLike, urlLike } from '../StompURL';
import { startCarrierHost, useCarrierHost } from '../transport/carrierClient';
import { constructTransport, resolveHttp3 } from '../transport/construct';
import { jarChanged, serveJar } from '../transport/jarServer';
import type {
	HostReload,
	IdentityChooserRequest,
	PermissionRequestInfo,
	RequestRule,
	SiteArrival,
} from '../transport/messages';
import {
	ACTIVATED,
	BLOCKER_SERVE,
	BlockerServeMessage,
	CLIENT_HINTS,
	CLIENT_ID,
	ClientHintsReport,
	CONTROLLER_CLOSE,
	CONTROLLER_INIT,
	CONTROLLER_MODULES,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerInitMessage,
	ControllerModulesMessage,
	CookieCommand,
	CookieRecord,
	CookieResult,
	FRAME_ENTRY,
	FRAME_MOVED,
	HANDSHAKE_REFUSED,
	HISTORY_RUN,
	HOOK_ERROR,
	KEEPALIVE_MS,
	NAVIGATE,
	NavigateInfo,
	NAVIGATION_TYPE,
	OPEN_TAB,
	PAGE_MODULES,
	postToPort,
	RequestInfo,
	ReviveMessage,
	SOCKET_PARTITION,
	STANDBY_DECLINED,
	SW_KICK,
	SW_PORT,
	SW_REVIVE,
	SW_WAKE,
	SWbound,
	TRANSPORT_INIT,
	WORKER_MODULES,
} from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import { connectionLost } from '../transport/RevivingTransport';
import { RpcHelper } from '../transport/rpc';
import serveTransport from '../transport/serveTransport';
import {
	transportLog,
	watchTransportNotes,
	type TransportNote,
} from '../transport/transportLog';
import TransportWorker from '../transport/TransportWorker';
import { watchCarrier, type CarrierInfo } from '../transport/wispWebTransport';
import { ADBLOCK_SNAPSHOT, BUILD } from '../version';
import { compileModule } from '../wasm/module';
import { drawAccountChooser } from './accountChooser';
import {
	APART_ROUTE,
	ApartAgent,
	outOfReach,
	publishCore,
	type ApartCommand,
	type ApartFrameInfo,
} from './apart';
import { ClientFrames } from './clientFrames';
import { GeometryWatch, sharedGeometry, shareGeometry } from './geometry';
import {
	answerRun,
	bindHistory,
	canTraverse,
	clientView,
	earlierWindows,
	framePath,
	noteActivation,
	noteBrowserNavigation,
	tellSteps,
	traverse,
	type Direction,
	type ReportedEntry,
	type RunsExpectation,
	type RunState,
	type SiteHistoryAnswer,
	type SiteHistoryOp,
} from './history';
import { watchHostInput } from './hostActivation';
import { hostReload } from './hostReload';
import {
	controllerId,
	fingerprintSeed,
	forgetControllerIds,
	keptControllerId,
	keptHelperNames,
} from './id';
import { probeIsolation } from './isolationProbe';
import { mediaVerdict } from './mediaVerdict';
import type { StaleInfo, TransportDescriptor } from './messages';
import { DEFAULT_SANDBOX } from './remote';
import RewriteWorkers, {
	DEFAULT_REWRITE_TIMEOUT_MS,
	defaultRewriteWorkers,
} from './rewriteWorkers';
import { createShields, type Shields } from './shields';
import { poolOrigins, slotAllow, type SitePoolInit } from './sitePool';
import {
	decorateOver,
	SiteHub,
	type BrokeredPool,
	type BrokeredTransport,
	type FannedMethod,
	type SiteAgentHooks,
	type SiteFrameInfo,
	type SiteHistoryCommand,
} from './sites';
import { suggestThrough, type SuggestOptions } from './suggest';
import { debugTransportStored, printNote } from './transportConsole';

export { default as SearchBuilder } from '../bootstrapper/SearchBuilder';
export {
	SEARCH_ENGINES,
	searchEngine,
	type SearchEngine,
} from '../bootstrapper/searchEngines';
export type { SuggestOptions } from './suggest';
export type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
export type { Config, ConfigCodec } from '../config';

export { RemoteController, RemoteFrame, DEFAULT_SANDBOX } from './remote';
export type {
	RemoteControllerInit,
	RemotePasskeyRequest,
	RemotePasskeysInit,
} from './remote';
export type {
	PasskeyAnswer,
	PasskeyInfo,
	PasskeyManager,
} from '../passkeys/types';
export type { TransportDescriptor, FrameInfo } from './messages';
export type {
	AdblockApplied,
	AdblockList,
	AdblockOptions,
} from '../blocker/types';
export { default as Http3Transport } from '../transport/http3/Http3Transport';
export type {
	DatagramChannel,
	Http3Info,
	Http3Options,
	UdpOpener,
} from '../transport/http3/Http3Transport';
export type { Http3DescriptorOptions } from '../transport/construct';
export type {
	CarrierInfo,
	WispWebTransportOptions,
} from '../transport/wispWebTransport';
export type {
	NavigateInfo,
	CookieRecord,
	RequestInfo,
} from '../transport/messages';

export interface ControllerInit {
	/**
	 * The registered STomp service worker, or its registration (from
	 * `StompController.register()` or `navigator.serviceWorker.register()`):
	 * then the controller takes its worker and waits for it to activate.
	 */
	serviceworker: ServiceWorker | ServiceWorkerRegistration;
	/**
	 * The transport proxied traffic goes through. A TransportDescriptor
	 * (`{ module, options }`) is imported and constructed in a dedicated
	 * Worker the controller starts from `transportWorker.js` in `directory`
	 * (`host: 'page'` keeps it in this page); off the host page's thread, a
	 * proxied frame's synchronous XHR that needs the network completes
	 * instead of deadlocking. A ProxyTransport instance (an EpoxyTransport
	 * the host constructed) is served from this page, as before. See
	 * `transportHost` and the `transporthost` event.
	 */
	transport: ProxyTransport | TransportDescriptor;
	codec?: ConfigCodec;
	/**
	 * URL of the directory `serviceworker` is scoped to and `dist/` is served
	 * from. Defaults to the directory of the current script, or of the page
	 * when loaded as a module.
	 */
	directory?: urlLike;
	/**
	 * This controller's id, 1 to 32 characters of `[A-Za-z0-9_-]` (a TypeError
	 * otherwise); 8 random characters by default. It names the controller's
	 * address under the directory (`/stomp/<id>/`, `config.directory`), so two
	 * host tabs on one directory run two controllers side by side; the same id
	 * passed again replaces the earlier controller. Without one the
	 * controller keeps an id of its own from visit to visit, one for each
	 * controller open at once (src/controller/id.ts): the tab's history
	 * entries, reloads and copied links keep resolving, and the browser keeps
	 * the compiled code of the scripts proxied pages load (it does so only
	 * for the same URL, and every routed URL starts with the id). That id is
	 * known once `wait()` resolves (`id` is empty until then), and is
	 * forgotten with the cookies (`cookies.clear()` for every site).
	 */
	id?: string;
	/** origins allowed to frame proxied documents (CSP frame-ancestors) */
	frameAncestors?: string[];
	/**
	 * Called when a proxied page wants a new tab (`window.open`, a link with
	 * `target="_blank"` or a name, a modifier click). The page's `window.open`
	 * then returns null, like a popup blocker. Without it, popups open
	 * natively as bare proxied tabs.
	 */
	onOpen?: (url: string, frame: Frame) => void;
	/**
	 * Called whenever a proxied page reports where it is (load, pushState,
	 * hashchange, title change); the same information arrives as a
	 * `navigate` CustomEvent on the Frame (`event.detail`).
	 */
	onNavigate?: (info: NavigateInfo, frame: Frame) => void;
	/** @internal pages may post open requests; set by the controller frame */
	openTab?: boolean;
	/**
	 * Called once per proxied request with what the service worker saw: real
	 * URL, method, destination, status, time, whether the cache answered (or
	 * had the origin confirm its entry), the size, an error, and the Frame it belongs to when known. Nothing is
	 * built or sent when unset.
	 */
	onRequest?: (info: RequestEvent) => void;
	/** @internal the service worker sends request reports; set by the controller frame */
	requestLog?: boolean;
	/**
	 * The transport's verbose log on the console (src/transport/transportLog.ts):
	 * a `[net]` line for each connection the transport opens to a site, what
	 * it rides there (HTTP/1.1, HTTP/2 over TLS over a Wisp TCP stream,
	 * HTTP/3 over a Wisp UDP stream) and what that Wisp stream rides to the
	 * relay (WebTransport's QUIC stream or datagrams, or the WebSocket), and
	 * each HTTP/3 fallback with its reason. Off by default, when nothing is
	 * built for it; `localStorage['stomp:debug-transport'] = '1'` on the
	 * host's origin turns it on when this is not given. The `[wisp]` notes
	 * (what the wisp connection rides) are on the console either way.
	 */
	debugTransport?: boolean;
	/**
	 * Whether a transport given a wisp URL rides the carrier host's wisp
	 * connection (src/transport/carrierHost.ts): a SharedWorker of the
	 * transport worker's script that keeps the origin's WebTransport session
	 * (or WebSocket) to the relay up across reloads and tabs, so that a
	 * reload and a second tab do not open one again. On by default; false
	 * has each transport open its own, as every start did before.
	 */
	carrierHost?: boolean;
	/** @internal the controller frame hands the transport's notes to its host, which prints them */
	onTransportNote?: (note: TransportNote) => void;
	/**
	 * @internal how the host page was loaded (hostReload.ts), found out by
	 * the host side of a controller frame; null: it was not reloaded
	 */
	hostReload?: HostReload | null;
	/**
	 * Called when a proxied site asks for a permission (geolocation, camera,
	 * microphone, notifications, ...) that the browser already gave the proxy
	 * origin for another site: the browser will not ask the user again, so
	 * the host does. Resolve true to grant it to this site, false to deny it,
	 * null (or throw) when the user closed the prompt. Without it such a
	 * request is dismissed; a site's own first request still gets the
	 * browser's prompt. docs/permissions.md.
	 */
	onPermissionRequest?: (
		request: PermissionRequest,
	) => boolean | null | Promise<boolean | null>;
	/**
	 * Passkeys for proxied sites (docs/passkeys.md), off unless given.
	 * WebAuthn cannot work through a proxy (the browser checks and signs the
	 * proxy's origin), so with this STomp is the passkey provider, as a
	 * password manager is: the service worker keeps a key pair per passkey
	 * (not extractable) in a store no proxied page reaches, bound to the
	 * site's real relying party id, and `onRequest` asks the user about every
	 * one made and every sign-in. Their safety is the inject's containment,
	 * as that of every site's cookies and storage on the proxy origin is.
	 * Without it a proxied page's WebAuthn requests end as they do in a
	 * browser that holds no passkey for the site.
	 */
	passkeys?: PasskeysInit;
	/**
	 * @internal For tests: a proxied page's FedCM request ends without the
	 * random delay Chrome gives a failure before its UI and without the
	 * three seconds it holds a token, as Chrome does under DevTools'
	 * FedCm.enable({ disableRejectionDelay: true })
	 */
	fedcmTesting?: boolean;
	/** @internal the controller frame (a slot's agent) hands a FedCM account chooser to its host's page, which draws it */
	identityRelay?: (
		request: IdentityChooserRequest,
		port: MessagePort,
	) => Promise<number>;
	/** @internal the controller frame hands every prompt to its host, which asks the user */
	passkeyRelay?: {
		config: PasskeysConfig;
		prompt: (
			request: PasskeyPrompt,
			port: MessagePort,
		) => Promise<PasskeyAnswer | null>;
		/** whether the focus is in the host's frame that shows the document `client` (#passkeyFocused) */
		focused?: (client: string) => Promise<boolean>;
	};
	/**
	 * HTTP cache in the service worker, on by default: GET/HEAD responses
	 * with explicit freshness (max-age, Expires) are kept in a Cache API
	 * store and revalidated when stale; `clearCache()` drops it. `false`
	 * turns it off.
	 */
	cache?: boolean;
	/**
	 * A script the rewriter cannot parse runs as it was (default, like a
	 * browser that does not know the syntax either). `false` makes it fail
	 * with a SyntaxError naming the rewriter error instead, so a broken
	 * rewrite is loud while developing.
	 */
	allowInvalidJs?: boolean;
	/**
	 * The window membrane, on by default. Every proxied site shares the
	 * proxy's one real origin, so the browser never keeps one proxied site
	 * from another's windows: the inject hands a page every window, and every
	 * object of another window's realm, through a proxy that checks on each
	 * use which site that window shows now, and behaves as the browser's
	 * cross-origin window when it is another. `false` turns it off, for a
	 * site it breaks: windows of another site are then restricted only where
	 * the page reads them, and one held while it was of the page's own site
	 * stays the window itself. (The setting reaches every document now; the
	 * membrane it switches is being built, and until it lands both values
	 * behave alike.)
	 */
	membrane?: boolean;
	/**
	 * Emulated service workers, on unless `false` (docs/service-workers.md).
	 * A proxied page's `navigator.serviceWorker` works: its worker script
	 * runs in a dedicated Worker this controller starts (never a real
	 * registration on the proxy origin, which would serve every site), and
	 * the STomp service worker hands it the requests of the pages it
	 * controls, navigations included, so offline pages, caches and fetch
	 * rewriting work. `false` leaves pages without `navigator.serviceWorker`,
	 * which a page can read as a proxy tell.
	 */
	serviceWorkers?: boolean;
	/** @internal ms an emulated service worker may take to say whether it answers a request (tests) */
	serviceWorkerTimeout?: number;
	/** @internal ms every emulated service worker event waits before it reaches the pages (tests) */
	serviceWorkerEventDelay?: number;
	/** @internal ms before the service worker answers a routed request with 504 (tests) */
	fetchTimeout?: number;
	/** @internal ms a navigation with no referrer waits for its document's hint (tests) */
	navigationHintWait?: number;
	/**
	 * Request rules, run in the service worker on the real URL: block, answer
	 * with a status, redirect, or edit request and response headers; the
	 * first matching rule wins. `setRules()` replaces them later.
	 */
	rules?: RequestRule[];
	/**
	 * Per-site shields the controller starts with (the demo's content-blocker
	 * UI, docs/adblock.md): a host-keyed state the host persisted. They travel
	 * to the service worker with the handshake, and `controller.shields` reads
	 * and writes them later. Left out, no host has an entry and STomp behaves as
	 * it would without shields (the blocker on, cookies and HTTPS untouched).
	 */
	shields?: SiteShields[];
	/**
	 * Called after `controller.shields.set(host, ...)` with the host and its new
	 * state, for the host to persist the change (the demo writes localStorage).
	 */
	onShieldsChange?: (host: string, state: SiteShields) => void;
	/**
	 * The served file names, when the host renamed them (see Assets): the
	 * inject bundles the worker names in its shell. A same-origin host
	 * registers the worker itself, so `serviceWorker` only documents its choice.
	 */
	assets?: Assets;
	/**
	 * The global names the rewriter and the inject bundles use (see
	 * HelperNames): a deployment's own, when the host set them. Each must be
	 * an identifier no plain window has; the controller throws a TypeError
	 * otherwise. Defaults: `$s$j`, `$s$L`, `$s$N`, and for `client` a name
	 * the controller mints, which no page is told. A host that sets `client`
	 * publishes it: any page that names the client reaches the real windows
	 * it holds, so leave it unset.
	 */
	names?: Partial<HelperNames>;
	/**
	 * Host code run inside every proxied realm (documents, nested frames,
	 * about:blank children, popups, srcdoc frames; workers with
	 * `hooks.workers`): `hooks.init.pre` before the inject installs its hooks,
	 * `hooks.init.post` after, before the page's first script. Scripts that
	 * travel, not closures: `{ source }` is the text, `{ url }` is fetched
	 * once at construction and its text travels (a redeploy of the file needs
	 * a new controller). Trusted host code with the realm's real globals; see
	 * src/hooks.ts. A bad shape is a TypeError; a URL that cannot be fetched
	 * is a `hookerror` event (and an entry in `hookErrors`), and the
	 * controller serves without that hook.
	 */
	hooks?: InitHooks;
	/**
	 * a host hook threw in a proxied realm (or a hook URL failed); also the
	 * `hookerror` CustomEvent. `frame` is the one showing the page the realm
	 * belongs to (the page's own document or one in a frame nested in it),
	 * null for a hook URL
	 */
	onHookError?: (info: HookErrorInfo, frame: Frame | null) => void;
	/**
	 * The host's own page for a document the proxy failed to produce (the
	 * transport could not reach the origin, the worker's timeout, a routing
	 * error, a blocked rule): a URL on this origin, resolved against the
	 * page. Served under the frame's routed
	 * URL with the failure's status, never cached, with
	 * `globalThis.stompError = { url, status, error, kind }` in its head;
	 * `location.reload()` retries. Without it the built-in pages answer.
	 */
	errorPage?: string;
	/**
	 * The built-in blocker (docs/adblock.md), on by default: EasyList,
	 * EasyPrivacy and uBlock Origin's lists are fetched through the transport
	 * and what they name is blocked, hidden and neutralised, as a content
	 * blocker in the user's browser would; an object names other lists, the
	 * resources, a prebuilt engine or the refresh interval, and `false`
	 * turns it off (nothing of it is fetched then). A blocked request is a
	 * network error to the page, nothing more. Left out, the blocker is best
	 * effort: a host that does not serve `blocker.wasm`, or lists that cannot
	 * be fetched, leave it off with one line on the console, and no page
	 * waits for the lists. `true` and an object are the host asking for it:
	 * the first navigation then waits for the engine (five seconds at most).
	 */
	adblock?: boolean | AdblockOptions;
	/**
	 * The filter lists to start the blocker with in place of the defaults (the
	 * demo seeds what its Filter Lists editor kept): the same lists
	 * `setAdblockLists` would push, but carried by the first handshake so the
	 * engine is built from them once, not rebuilt after a default build. Ignored
	 * when `adblock` is `false`. `adblockDefaults()` still reports the untouched
	 * default lists, for the editor to show.
	 */
	adblockLists?: (string | AdblockList)[];
	/**
	 * sandbox flags for proxied frames, default `DEFAULT_SANDBOX`. Same-origin
	 * frames are not a security boundary, but without a sandbox the browser
	 * lets `<a target="_top">`, `<form target="_parent">` and
	 * `window.open(url, '_top')` navigate the host page. `null` disables it.
	 */
	sandbox?: string | null;
	/**
	 * How many Workers the controller starts to rewrite scripts for the
	 * service worker, whose own thread would otherwise rewrite one script at
	 * a time (from `rewriteWorker.js` in `directory`). A large webpack
	 * bundle is shared out among them, a part to each. Default: half the
	 * cores, one to four; `0` starts none. Whenever no worker answers (none
	 * started, one failed to load or crashed, this page closed), the service
	 * worker rewrites the script itself.
	 */
	rewriteWorkers?: number;
	/**
	 * Milliseconds the service worker waits for a rewrite worker's answer
	 * before it rewrites the script itself and stops using that worker.
	 * Default 10000.
	 */
	rewriteTimeout?: number;
	/**
	 * Show every proxied site (its registrable domain) from one of a few
	 * origins, the pool's slots (`{ origins: [...] }`,
	 * src/controller/sitePool.ts, docs/site-pool.md): other ports of this
	 * page's host, say. The browser then gives each slot a process of its
	 * own, so a page and a frame of another site in it are apart as
	 * natively, and a window of a site in another slot is another origin to
	 * the browser itself. A site keeps its slot; with more sites than slots,
	 * some share one, as every site does without a pool. Every slot must
	 * serve `directory` as this page's origin does, with
	 * `Origin-Agent-Cluster: ?1` on everything it answers.
	 *
	 * Used wherever it can work: a page that is not a secure context (where
	 * the browser ignores Origin-Agent-Cluster), and a slot that does not
	 * answer or whose service worker does not start, show their sites from
	 * this page's origin, as without a pool. `false` (or no origins) shows
	 * every site from this page's origin.
	 */
	sitePool?: SitePoolInit | false;
	/** @internal the controller is a slot's agent of a site pool (src/controller/sites.ts) */
	agent?: SiteAgentHooks;
	/**
	 * @internal the site pool's hub is a controller frame (RemoteController,
	 * src/controller/frame.ts): the proxied frames are the host page's, of
	 * this origin
	 */
	siteHost?: string;
	/**
	 * @internal how many windows up from this controller's document the
	 * window is whose frames the proxied frames are: 0 for the host's page
	 * (the default), 1 for a RemoteController's controller frame, whose
	 * siblings they are (./apart.ts)
	 */
	framesUp?: number;
	/**
	 * @internal the service worker said the document `client` is a page
	 * isolated natively shown without isolation (NavigateInfo.isolation): a
	 * RemoteController's controller frame tells the host
	 */
	onIsolationWanted?: (client: string) => void;
}

/**
 * a RequestInfo with the frame it belongs to: the one showing the page that
 * made the request, whatever in the page did (a document in a nested frame,
 * one on about:srcdoc or about:blank, a worker), once its document reported
 * its client id; null for a client no frame holds (a page's emulated
 * service worker)
 */
export interface RequestEvent extends RequestInfo {
	frame: Frame | null;
}

/** a proxied site's permission request the host is asked about (onPermissionRequest) */
export interface PermissionRequest {
	/** the site: the real origin of the proxied page at the top of the frame */
	origin: string;
	/** the permission, as permissions.query names it (`geolocation`, `camera`, ...) */
	permission: string;
	/** the frame the request came from, when its page reported its client id */
	frame: Frame | null;
	/** the requesting document's service worker client id */
	client?: string;
}

/** a proxied site's passkey ceremony the host is asked about (ControllerInit.passkeys) */
export interface PasskeyRequest extends PasskeyRequestBase {
	/** the frame the request came from, when its page reported its client id */
	frame: Frame | null;
}
/** the passkeys option (see ControllerInit.passkeys) */
export type PasskeysInit = PasskeysInitOf<PasskeyRequest>;

/** the host's view of the cookie jar (see StompController.cookies) */
export interface CookieJar {
	/** the Cookie header value the proxy would send to `url` */
	get(url: string): Promise<string>;
	/** apply Set-Cookie header values as if `url` had sent them */
	set(url: string, setCookie: string | string[]): Promise<void>;
	/** every stored cookie, or those a page of `origin` could receive */
	list(origin?: string): Promise<CookieRecord[]>;
	/** forget every cookie, or those of `origin` */
	clear(origin?: string): Promise<void>;
}

/** @internal a CookieJar over a command function */
/** the host's view of the service worker's passkeys, over `run` (see StompController.passkeys) */
export function passkeyManager(
	run: (command: PasskeyCommand) => Promise<PasskeyInfo[] | boolean | null>,
): PasskeyManager {
	return {
		list: async (rpId) => {
			const list = await run(
				rpId === undefined ? { op: 'list' } : { op: 'list', rpId },
			);
			return Array.isArray(list) ? list : [];
		},
		delete: async (id) => (await run({ op: 'delete', id })) === true,
		clear: async (rpId) => {
			await run(rpId === undefined ? { op: 'clear' } : { op: 'clear', rpId });
		},
	};
}

export function cookieJar(
	run: (command: CookieCommand) => Promise<CookieResult>,
): CookieJar {
	return {
		get: async (url) => String((await run({ op: 'get', url })) ?? ''),
		set: async (url, setCookie) => {
			await run({ op: 'set', url, setCookie });
		},
		list: async (origin) =>
			((await run({ op: 'list', origin })) as CookieRecord[] | undefined) ?? [],
		clear: async (origin) => {
			await run({ op: 'clear', origin });
		},
	};
}

/**
 * @internal The frame of `frames` a message came from: the one whose window
 * is its `source`, or (`nested`) the one showing the page that holds the
 * frame that is, however deep. A proxied page of the host's own origin
 * answers `parent` itself (it believes it is the top, and a frame of another
 * site in it sees a stand-in), so the chain is read with the host's own
 * getter, which no page reached; a window of another origin has only that
 * answer.
 */
export function frameOfSource<F extends { element: HTMLIFrameElement }>(
	frames: F[],
	source: MessageEventSource | null,
): { frame: F; nested: boolean } | null {
	const parentOf = Reflect.getOwnPropertyDescriptor(window, 'parent')?.get;
	let context = source as Window | null;
	// the chain of a frame of ours ends at the host's own window
	for (let depth = 0; context && context !== window; depth++) {
		const found = context;
		const frame = frames.find((frame) => frame.element.contentWindow === found);
		if (frame) return { frame, nested: depth > 0 };
		let parent: Window | null;
		try {
			parent = parentOf
				? (Reflect.apply(parentOf, context, []) as Window | null)
				: context.parent;
		} catch (error) {
			// not a window (a port, a worker)
			return null;
		}
		if (parent === context) return null;
		context = parent;
	}
	return null;
}

/** a navigate report posted by a proxied page, else null */
/** keep `client` in `clients`, the oldest dropped past 64 (NavigateInfo.isolation) */
export function keepClient(clients: Set<string>, client: string) {
	clients.delete(client);
	if (clients.size >= 64) clients.delete(clients.values().next().value!);
	clients.add(client);
}

export function navigateReport(data: unknown): NavigateInfo | null {
	if (typeof data !== 'object' || data === null) return null;
	const info = (data as Record<string, unknown>)[NAVIGATE];
	if (typeof info !== 'object' || info === null) return null;
	const { url, title, canGoBack, canGoForward, icon, client } =
		info as NavigateInfo;
	if (typeof url !== 'string' || typeof title !== 'string') return null;
	return {
		url,
		title,
		canGoBack: typeof canGoBack === 'boolean' ? canGoBack : null,
		canGoForward: typeof canGoForward === 'boolean' ? canGoForward : null,
		icon: typeof icon === 'string' ? icon : null,
		...(typeof client === 'string' ? { client } : {}),
	};
}

/** the service worker client id a document in a frame of a proxied page posted, else null */
/** how the browser navigated to the document a navigate report is of (NAVIGATION_TYPE), else null */
export function navigationTypeReport(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const type = (data as Record<string, unknown>)[NAVIGATION_TYPE];
	return typeof type === 'string' ? type : null;
}
/** where the document a navigate report is of is in its slot's stretch of the frame's history (HISTORY_RUN), else null */
export function historyRunReport(data: unknown): [number, number] | null {
	if (typeof data !== 'object' || data === null) return null;
	const run = (data as Record<string, unknown>)[HISTORY_RUN];
	if (!Array.isArray(run) || run.length !== 2) return null;
	const [index, length] = run as unknown[];
	return Number.isInteger(index) &&
		Number.isInteger(length) &&
		(index as number) >= 0 &&
		(index as number) < (length as number)
		? [index as number, length as number]
		: null;
}
/** a FRAME_MOVED report of a document in a frame of a proxied page (with its client id, when it has one), else null */
export function frameMovedReport(
	data: unknown,
): { client: string | null; entry: ReportedEntry | null } | null {
	if (typeof data !== 'object' || data === null || !(FRAME_MOVED in data))
		return null;
	const client = (data as Record<string, unknown>)[FRAME_MOVED];
	const entry = (data as Record<string, unknown>)[FRAME_ENTRY] as
		Record<string, unknown> | null | undefined;
	return {
		client: typeof client === 'string' ? client : null,
		entry:
			typeof entry?.key === 'string' &&
			typeof entry.id === 'string' &&
			typeof entry.url === 'string'
				? { key: entry.key, id: entry.id, url: entry.url }
				: null,
	};
}
export function clientReport(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const client = (data as Record<string, unknown>)[CLIENT_ID];
	return typeof client === 'string' ? client : null;
}

/** the token of a proxied document that reported its first user activation, else null */
export function activatedReport(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const token = (data as Record<string, unknown>)[ACTIVATED];
	return typeof token === 'string' ? token : null;
}

/** a hook error report posted by a proxied page, else null */
export function hookErrorReport(data: unknown): HookErrorInfo | null {
	if (typeof data !== 'object' || data === null) return null;
	const info = (data as Record<string, unknown>)[HOOK_ERROR];
	if (typeof info !== 'object' || info === null) return null;
	const { phase, kind, url, message, stack } = info as HookErrorInfo;
	if (
		(phase !== 'pre' && phase !== 'post' && phase !== 'url') ||
		typeof url !== 'string' ||
		typeof message !== 'string'
	)
		return null;
	return {
		phase,
		url,
		message,
		...(typeof kind === 'string' ? { kind } : {}),
		...(typeof stack === 'string' ? { stack } : {}),
	};
}

/** the run of the worker named by a STANDBY_DECLINED message, or null for any other message */
function standbyDeclined(data: unknown): string | null {
	if (typeof data !== 'object' || data === null || !(STANDBY_DECLINED in data))
		return null;
	const declined = (data as Record<string, unknown>)[STANDBY_DECLINED] as {
		instance?: unknown;
	} | null;
	return typeof declined?.instance === 'string' ? declined.instance : '';
}
/** the URL of an open request posted by a proxied page, else null */
export function openRequest(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const url = (data as Record<string, unknown>)[OPEN_TAB];
	return typeof url === 'string' ? url : null;
}

/** this soon after we registered, a "revive" broadcast is checked over the port rather than acted on */
const REVIVE_GUARD_MS = 2000;
/** how long that check waits for the worker to answer */
const REVIVE_PING_MS = 1000;
/**
 * How long a handshake offered for a stopped worker stands with no answer
 * (taken or declined) before a page's wait may withdraw it for another: its
 * message went to a worker that stopped again before it read it
 */
const STANDBY_STALE_MS = 10000;
/**
 * After the worker that has this controller declined an offer, how long no
 * other is made: it was running then, and the keepalive (KEEPALIVE_MS) keeps
 * it running, where Chrome stops a worker nothing reached for 30 s. Only a
 * crash in that time would leave a page's wait unanswered, as before offers.
 * Wall-clock time, so a machine that slept or a tab that was frozen is past it
 */
const DECLINED_HOLD_MS = KEEPALIVE_MS;
/**
 * How long a channel this controller let go of (it shook hands again)
 * stays open at most, answering what is in flight on it: past the worker's
 * own bound for that (DRAIN_MS and RETIRE_GRACE_MS in
 * src/server/serviceWorker.ts), so the worker is what closes it
 */
const LINGER_MS = 70000;
/**
 * how long a service worker of another build gets to update and activate
 * before wait() resolves on the one we have (the new one is adopted when it
 * activates)
 */
const UPDATE_GRACE_MS = 5000;
/** how long after registration.update() to wait for `updatefound` before concluding nothing changed */
const UPDATE_FOUND_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a frame's navigation to `routed` (`reported`, see
 * Frame.#arrival); when a newer service worker takes over (`onHandover`)
 * and, HANDOVER_GRACE_MS later, the frame has neither reported, fired its
 * load event nor changed document (`before`, null for another origin's),
 * the navigation is sent again, once, and the next report (`nextReport`)
 * is waited for. By way of about:blank: Chrome drops a navigation to the
 * URL a frame still on its first document is already on its way to
 * (measured), and the stuck one would go on waiting.
 */
export async function arrival(
	element: HTMLIFrameElement,
	routed: string,
	reported: Promise<void>,
	onHandover: (listener: () => void) => () => void,
	nextReport: () => Promise<void>,
	before: Document | null,
	sent: () => void = () => {},
): Promise<void> {
	let arrived = false;
	const shown = () => {
		arrived = true;
	};
	element.addEventListener('load', shown);
	const settled = reported.then(shown);
	let handedOver = () => {};
	const handover = new Promise<void>((resolve) => (handedOver = resolve));
	const stop = onHandover(handedOver);
	try {
		await Promise.race([settled, handover]);
		if (!arrived) await Promise.race([settled, sleep(HANDOVER_GRACE_MS)]);
		if (arrived || element.contentDocument !== before) return await reported;
		stop();
		const again = nextReport();
		element.src = 'about:blank';
		element.src = routed;
		sent();
		await again;
	} finally {
		stop();
		element.removeEventListener('load', shown);
	}
}

/** how long a document's request report waits for its page to say which frame it is in */
const ATTRIBUTION_WAIT_MS = 3000;
/** the same for a subresource fetched before the page reported (head scripts, styles) */
const SUBRESOURCE_WAIT_MS = 1500;
/** how long go() and reload() wait for the new document's first report before resolving anyway */
export const NAVIGATION_WAIT_MS = 30000;
/** how long after the frame's load event they wait for a report that may never come (a document nothing injected) */
export const REPORT_GRACE_MS = 1000;
/**
 * How long a frame's navigation that a new service worker's takeover may
 * have lost is given to show itself before it is sent again (see
 * Frame.#arrival)
 */
const HANDOVER_GRACE_MS = 1000;
/** how long register() and the constructor wait for a worker to activate before going on with what there is */
export const REGISTER_WAIT_MS = 30000;

/**
 * What a controller's start waits for before its first handshake, begun by
 * register() while the service worker installs: the wasm modules' and the
 * rewriter library's fetches, and the transport worker's script. Begun by
 * the start itself, once the worker was activated, the fetches went one
 * after another and the transport worker started beside them: 39 ms from
 * activation to the worker's first answer on Chrome 157, where it is 28 ms
 * now (the page's thread is idle through the install). Each is taken once,
 * by its URL (bootFetch, bootWorker); what no start takes is let go after
 * EARLY_KEEP_MS.
 */
const earlyFetches = new Map<string, Promise<Response>>();
/** the transport worker scripts register() started, and whether one failed to */
const earlyWorkers = new Map<string, { worker: Worker; failed: boolean }>();
const EARLY_KEEP_MS = 30000;
/** `url` fetched, or the early fetch of it register() made */
function bootFetch(url: URL): Promise<Response> {
	const early = earlyFetches.get(url.href);
	if (!early) return fetch(url);
	earlyFetches.delete(url.href);
	return early;
}
/**
 * The transport worker register() started at `url`, unless its script
 * failed (a new one fails where TransportWorker hears why). Nothing posts
 * to the page before the transport's init but the clock's tick, the first
 * KEEPALIVE_MS after the start.
 */
function bootWorker(url: URL): Worker | undefined {
	const early = earlyWorkers.get(url.href);
	if (!early) return undefined;
	earlyWorkers.delete(url.href);
	if (!early.failed) return early.worker;
	early.worker.terminate();
}
/** begin what a controller's start in `scope` waits for (see earlyFetches) */
function bootEarly(scope: URL, assets: Assets | undefined) {
	const fetches = [
		coreFile(assets),
		assetFile(assets, 'blocker'),
		libraryFile(assets),
	].map((file) => {
		const url = new URL(file, scope).href;
		const early = fetch(url);
		early.catch(() => {});
		earlyFetches.set(url, early);
		return [url, early] as const;
	});
	const url = new URL(assetFile(assets, 'transportWorker'), scope).href;
	let worker: { worker: Worker; failed: boolean } | undefined;
	try {
		worker = { worker: new Worker(url), failed: false };
		const started = worker;
		started.worker.addEventListener('error', () => (started.failed = true));
		earlyWorkers.set(url, started);
	} catch (error) {
		// the start makes its own, and says why it cannot
	}
	setTimeout(() => {
		for (const [url, early] of fetches)
			if (earlyFetches.get(url) === early) earlyFetches.delete(url);
		if (worker && earlyWorkers.get(url) === worker) {
			earlyWorkers.delete(url);
			worker.worker.terminate();
		}
	}, EARLY_KEEP_MS);
}
const DOCUMENT_DESTINATIONS = new Set([
	'document',
	'iframe',
	'frame',
	'embed',
	'object',
]);

/** resolves once the worker is activated; rejects when it becomes redundant */
export function activated(worker: ServiceWorker): Promise<ServiceWorker> {
	if (worker.state === 'activated') return Promise.resolve(worker);
	return new Promise((resolve, reject) => {
		worker.addEventListener('statechange', () => {
			if (worker.state === 'activated') resolve(worker);
			else if (worker.state === 'redundant')
				reject(new Error('Service worker became redundant'));
		});
	});
}

/** the worker a registration holds, newest first; throws for an empty one */
function registrationWorker(
	registration: ServiceWorkerRegistration,
): ServiceWorker {
	const worker =
		registration.active || registration.waiting || registration.installing;
	if (!worker)
		throw new Error(
			`No service worker in the registration for ${registration.scope}`,
		);
	return worker;
}

export type { StaleInfo };
/** the build this controller bundle came from (version plus commit, or the package version); `controller.build` carries it too */
export { BUILD } from '../version';
export type { Assets } from '../config';
export { DEFAULT_ASSETS } from '../config';
export type { HelperNames } from '../helperNames';
export type {
	HookContext,
	HookErrorInfo,
	HookScript,
	InitHooks,
} from '../hooks';
export { DEFAULT_NAMES } from '../helperNames';
export type {
	RequestRule,
	RequestRuleAction,
	RequestRuleMatch,
} from '../transport/messages';

function defaultDirectory(): URL {
	const script =
		typeof document !== 'undefined' &&
		(document.currentScript as HTMLScriptElement | null);
	return new URL('.', script && script.src ? script.src : location.href);
}

/** a TransportDescriptor rather than a ProxyTransport instance */
function isTransportDescriptor(
	transport: ProxyTransport | TransportDescriptor,
): transport is TransportDescriptor {
	return (
		typeof transport === 'object' &&
		transport !== null &&
		typeof (transport as TransportDescriptor).module === 'string'
	);
}

/** the descriptor with its module URL resolved against this page (the worker would resolve it against its own) */
function resolvedModule(descriptor: TransportDescriptor): TransportDescriptor {
	return resolveHttp3(
		{
			...descriptor,
			module: new URL(descriptor.module, location.href).href,
		},
		location.href,
	);
}

/** import a descriptor's module in this page and construct it */
function importTransport(
	descriptor: TransportDescriptor,
): Promise<ProxyTransport> {
	return constructTransport(resolvedModule(descriptor));
}

/**
 * A transport that fails every request with `error`: what a controller holds
 * while its transport is still loading, or when neither the worker nor the
 * page could import the module. Requests then fail at once (the worker's
 * error page) rather than hang, and `setTransport()` repairs the controller.
 */
function failingTransport(error: unknown): ProxyTransport {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ready: true,
		async init() {},
		async request() {
			throw new Error(`Stomp: no transport (${message})`);
		},
		connect(
			_url,
			_protocols,
			_headers,
			_onopen,
			_onmessage,
			_onclose,
			onerror,
		) {
			onerror(`Stomp: no transport (${message})`);
			return [() => {}, () => {}];
		},
	};
}

/**
 * Owns the transport and registers itself with the service worker.
 * Proxied content lives in frames created by `createFrame()`.
 */
/**
 * Events: `stale` (detail: StaleInfo) when the handshake met a service worker
 * of another build that could not be replaced in time, `rebind` (detail:
 * `{ build }`) when a later handshake agrees again, `transporthost`
 * (detail: `{ host: 'page', error }`) when the transport worker could not
 * host a descriptor and the page took over, and `carrier` (detail:
 * CarrierInfo, also `carrier`) each time a descriptor's transport given a
 * wisp URL is up on what its wisp connection rides.
 */
export class StompController extends EventTarget {
	config: Config;
	/**
	 * set while the service worker serving this controller is another build
	 * than the controller (a deploy the browser has not finished installing);
	 * null once the builds agree
	 */
	stale: StaleInfo | null = null;
	/** the directory the host gave: the service worker's scope and the asset base (`config.scope`) */
	directory: URL;
	/**
	 * this controller's id; its address is `config.directory` (`directory` +
	 * id + `/`). Empty, as the address is, until the controller that was
	 * given none has the one it keeps (before `wait()` resolves)
	 */
	id: string;
	/** the build this controller bundle came from (STOMP_BUILD: version plus commit, or the package version); the worker's build is `config.build`, and `stale` says when the two differ */
	readonly build: string = BUILD;
	serviceworker: ServiceWorker;
	/**
	 * The transport the proxy uses. With a worker-hosted descriptor this is a
	 * RemoteTransport over a port the worker serves (so a host can still probe
	 * `controller.transport.request()` from its console); otherwise the
	 * instance the host gave or the page imported.
	 */
	transport: ProxyTransport;
	/**
	 * Where the transport runs: `worker` for a descriptor hosted in the
	 * transport worker, `page` for an instance, a descriptor with
	 * `host: 'page'`, or a descriptor the worker could not host (then a
	 * `transporthost` event said so). `setTransport()` takes a descriptor for
	 * the one and an instance for the other.
	 */
	transportHost: 'worker' | 'page';
	/**
	 * What the transport's wisp connection rides, WebTransport or its
	 * WebSocket, once a descriptor's transport given a wisp URL chose (with
	 * `webTransport`) or opened its WebSocket (without: `why` is `off`); a
	 * `carrier` event each time, a revived transport too. Null before, and
	 * for an instance or a transport given no wisp URL. The host's alone: no
	 * proxied page is told.
	 */
	carrier: CarrierInfo | null = null;
	frames: Frame[] = [];
	/**
	 * The host's browser window as its frames' documents see it
	 * (./geometry.ts), kept on this window and every slot's agent's
	 */
	#geometry = new GeometryWatch(
		() => this.frames.map((frame) => frame.element),
		(geometry) => this.shareGeometry(geometry),
	);
	isReady = false;
	#worker?: TransportWorker | BrokeredTransport;
	/** prints a note of the transport's (the host's console), or hands it to the host that does */
	#note: (note: TransportNote) => void;
	/** the verbose mode (ControllerInit.debugTransport) */
	#debugTransport: boolean;
	/** ControllerInit.carrierHost */
	#sharesCarrier: boolean;
	#rewriteWorkers?: RewriteWorkers | BrokeredPool;
	/** the site pool's hub (ControllerInit.sitePool) */
	#sites?: SiteHub;
	#rewriteTimeout: number;
	/** the bytes of the wasm modules loaded for `rewriter: 'wasm'`, once they are; every handshake carries them */
	#modules: Record<string, ArrayBuffer> | null = null;
	/**
	 * The blocker's module compiled here and kept, never run. The service
	 * worker compiles the handshake's bytes again on every start, and V8
	 * finds the code it compiled for the same bytes in its process while any
	 * thread still holds a module of them. Nothing else held the blocker's:
	 * a worker that Chrome stopped and started again compiled the 944
	 * functions its first navigation called (18.4 to 21.8 ms, measured on
	 * Chrome 157), and with this page holding it, it compiles none. (V8 keeps
	 * no code cache of it: none was produced for a compileStreaming from the
	 * worker's own Cache Storage, measured the same way.)
	 */
	#blockerHeld?: WebAssembly.Module;
	/** the same modules compiled, for the threads and pages of this agent cluster (none without `rewriter: 'wasm'`) */
	#compiled: Promise<Record<string, WebAssembly.Module>> | null = null;
	/** settles once the modules' bytes are in (#modules) */
	#loaded: Promise<unknown>;
	/** settles once the transport exists where it is hosted; the handshake waits for it */
	#hostReady: Promise<void>;
	/** settles once the transport is hosted where it will stay (`suggest()` waits for it) */
	#transportUp: Promise<void>;
	/** every hook error so far (a hook that threw, a hook URL that failed), newest last; also `hookerror` events */
	readonly hookErrors: HookErrorInfo[] = [];
	#init: ControllerInit;
	/** the service worker clients the pages reported, by frame, and those nobody spoke for */
	#clients = new ClientFrames<Frame>(
		() => this.frames,
		(clients) => this.goneClients(clients),
	);
	/** @internal how many clients are kept with a frame, and how many without (tests) */
	get clientCounts(): { clients: number; silent: number } {
		return this.#clients.sizes;
	}
	#onRequest?: (info: RequestEvent) => void;
	#sandbox: string | null;
	#port?: MessagePort;
	#rpc?: RpcHelper<Controllerbound, SWbound>;
	/** the pages' emulated service workers this controller hosts, by the worker's id for them */
	#serviceWorkers = new Map<string, Worker>();
	#stopServing?: () => void;
	/** settles when the service worker answered the handshake under way; a new one for every handshake after the first */
	#ready: Promise<void>;
	/** how the host page was loaded, until the worker has been told (hostReload.ts) */
	#hostReload: Promise<HostReload | undefined> | null = null;
	/**
	 * the same once known, and when: a site pool's agents tell their slots'
	 * workers as this one told its own (the page the host shows again is a
	 * slot's when its site is shown from one)
	 */
	#hostReloaded: { mode: HostReload; at: number } | null = null;
	#readyResolve!: () => void;
	#readyReject!: (error: Error) => void;
	#readySettled = false;
	private lastHandshake = 0;
	/** a handshake is on its way and the worker has not said it took it (hello) */
	#awaiting = false;
	/** the run of the worker that took our handshake (ReviveMessage.instance) */
	#instance: string | undefined;
	#takenWaiters = new Set<() => void>();
	/**
	 * this instance's name in each of its handshakes
	 * (ControllerInitMessage.token): the worker tells it shaking hands again
	 * from another controller taking its address
	 */
	#token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	/** a handshake offered to a worker that may have stopped (see #standIn) */
	#standby?: { port: MessagePort; at: number; stopServing?: () => void };
	/** the run of the worker that last declined an offer, and when */
	#declined?: { instance: string; at: number };
	/** a build mismatch is being healed: the next ready answer must agree */
	#healing = false;
	#rules: RequestRule[];
	/**
	 * Per-site shields (docs/adblock.md): `controller.shields` reads and writes
	 * them, each change pushes the whole set to the worker, and they travel with
	 * every handshake as the rules do. Built in the constructor
	 */
	#shields!: Shields;
	/**
	 * The per-session farbling seed for the anti-fingerprint surfaces, kept in
	 * the host origin's storage so a site's noise is stable across reloads, tabs
	 * and worker restarts (src/controller/id.ts fingerprintSeed). Sent to the
	 * worker with the shields; the worker mixes it with each document's eTLD+1.
	 */
	readonly #fpSeed = fingerprintSeed();
	/** the blocker's lists in force, while it is on (docs/adblock.md); its module is `#modules.blocker` */
	#adblock: AdblockInit | null = null;
	/**
	 * the blocker's default lists, kept untouched when `setAdblockLists` changes
	 * the lists in force, so `adblockDefaults()` can show the editor what the
	 * defaults are. Null when the host turned the blocker off
	 */
	#adblockBase: AdblockInit | null = null;
	/**
	 * the served file names `init.assets` falls back to (the dist names), for
	 * a classic-script host that names a file itself, such as a service worker
	 * it registers without `register()` or the omnibox module (`omnibox`)
	 */
	static readonly DEFAULT_ASSETS: Readonly<Required<Assets>> = DEFAULT_ASSETS;
	/**
	 * Register the STomp service worker served from `directory` (the
	 * constructor's default when omitted: the directory of the current script)
	 * and resolve once it is activated. The registration goes straight into
	 * `serviceworker` of the constructor.
	 */
	static async register(
		directory?: urlLike,
		options: {
			/** the served file names, when the host renamed them */
			assets?: Assets;
			/** passed to `navigator.serviceWorker.register`; `none` by default */
			updateViaCache?: ServiceWorkerUpdateViaCache;
		} = {},
	): Promise<ServiceWorkerRegistration> {
		if (!('serviceWorker' in navigator))
			throw new Error('Your browser does not support service workers.');
		const scope = isUrlLike(directory)
			? new URL(directory, location.href)
			: defaultDirectory();
		bootEarly(scope, options.assets);
		const registration = await navigator.serviceWorker.register(
			new URL(
				options.assets?.serviceWorker ?? DEFAULT_ASSETS.serviceWorker,
				scope,
			),
			{ scope: scope.href, updateViaCache: options.updateViaCache ?? 'none' },
		);
		// a worker stuck in installing must not hang the host: the controller
		// then speaks to what the registration has (never-block, as for a
		// build mismatch)
		await Promise.race([
			activated(registrationWorker(registration)).catch(() => {}),
			sleep(REGISTER_WAIT_MS),
		]);
		return registration;
	}
	/** the registration the host gave, when it did */
	#registration?: ServiceWorkerRegistration;
	constructor(init: ControllerInit) {
		super();
		this.#init = init;
		// before anything async: a bad name is a programming error
		validateNames(init.names, Object.getOwnPropertyNames(globalThis));
		validateHooks(init.hooks);
		if (!('serviceWorker' in navigator))
			throw new Error('Your browser does not support service workers.');
		// a step of a frame's history taken with location.replace is a
		// history step all the same (history.ts)
		tellSteps((url) => this.#call('historyStep', url));

		if (init.serviceworker instanceof ServiceWorkerRegistration) {
			this.#registration = init.serviceworker;
			this.serviceworker = registrationWorker(init.serviceworker);
		} else this.serviceworker = init.serviceworker;
		const given = init.transport;
		if (init.agent) {
			// a slot's agent serves its transport through the hub's
			this.transportHost = 'worker';
			this.#worker = init.agent.worker;
			init.agent.worker.bind(this.#handshakeHeaders, this.#admitSession);
			init.agent.keepAlive = this.#keepAlive;
			this.transport = new RemoteTransport(init.agent.worker.serve());
		} else if (isTransportDescriptor(given)) {
			this.transportHost =
				(given.host ?? 'worker') === 'page' ? 'page' : 'worker';
			this.transport = failingTransport('the transport is still loading');
		} else {
			this.transportHost = 'page';
			this.transport = given;
		}
		// a transport in this page announces its carrier here, and tells
		// its notes (the worker's come over its channel)
		watchCarrier((info) => {
			if (this.transportHost === 'page') this.#carrierChosen(info);
		});
		this.#note = init.onTransportNote ?? printNote;
		this.#debugTransport = init.debugTransport ?? debugTransportStored();
		this.#sharesCarrier = init.carrierHost !== false;
		if (this.#debugTransport) transportLog.on = true;
		watchTransportNotes((note) => {
			if (this.transportHost === 'page') this.#note(note);
		});
		this.#sandbox = init.sandbox === undefined ? DEFAULT_SANDBOX : init.sandbox;
		const rewriteWorkers = Math.min(
			16,
			Math.max(0, Math.floor(init.rewriteWorkers ?? defaultRewriteWorkers())),
		);
		this.#rewriteTimeout = Math.min(
			120000,
			Math.max(50, init.rewriteTimeout ?? DEFAULT_REWRITE_TIMEOUT_MS),
		);
		this.#onRequest = init.onRequest;
		this.#rules = init.rules ?? [];
		// each change pushes the whole set to the worker (fire and forget: it is
		// resent with the handshake); the host persists it from onShieldsChange
		this.#shields = createShields((list) => {
			this.#call('shields', { list, seed: this.#fpSeed }).catch(() => {});
			this.#sites?.apply('shields', list);
		}, init.onShieldsChange);
		if (init.shields?.length) this.#shields.replace(init.shields);
		this.directory = isUrlLike(init.directory)
			? new URL(init.directory, location.href)
			: defaultDirectory();

		if (this.directory.origin !== location.origin)
			throw new Error('Stomp directory must be same-origin');
		// a host's own id is the address at once; without one the address is
		// the id this controller keeps, which it has before its first
		// handshake (#hostReady): until then there is none, and nothing that
		// needs one (a route, a frame, a report to the worker) happens. An
		// empty id is none: what a host read off `id` too early and passed
		// back
		this.id = init.id ? controllerId(init.id) : '';
		let errorPage: string | undefined;
		if (init.errorPage !== undefined) {
			const page = new URL(init.errorPage, location.href);
			if (page.origin !== location.origin)
				throw new Error('Stomp errorPage must be same-origin');
			errorPage = `${page.pathname}${page.search}`;
		}

		// passkeys: the frame's host asks the user (the relay), or this page does
		const passkeys: PasskeysConfig | undefined =
			init.passkeyRelay?.config ??
			(init.passkeys
				? {
						uv: init.passkeys.userVerification === true,
						testing: init.passkeys.testing === true,
					}
				: undefined);

		this.config = {
			codec: init.codec ?? 'xor',
			// the address: the scope plus the id, so controllers of one scope
			// are told apart in the worker; the assets stay at the scope
			directory: this.id ? `${this.directory.pathname}${this.id}/` : '',
			scope: this.directory.pathname,
			...(init.frameAncestors ? { frameAncestors: init.frameAncestors } : {}),
			...(init.onOpen || init.openTab ? { openTab: true } : {}),
			// the host's page sent COOP same-origin and an embedder policy (in
			// origin-isolation mode this is the controller's frame, which the
			// host's page lets be isolated): proxied frames can be isolated here
			...(globalThis.crossOriginIsolated === true || init.agent?.isolated
				? { isolated: true }
				: {}),
			...(init.cache === false ? { cache: false } : {}),
			...(init.onRequest || init.requestLog ? { requestLog: true } : {}),
			...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
			...(init.membrane === false ? { membrane: false } : {}),
			...(passkeys ? { passkeys } : {}),
			...(init.fedcmTesting === true ? { fedcmTesting: true } : {}),
			...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
			// the rewriter is wasm-only (the core module); every thread uses it
			rewriter: 'wasm',
			...(init.serviceWorkerTimeout
				? { serviceWorkerTimeout: init.serviceWorkerTimeout }
				: {}),
			...(init.serviceWorkerEventDelay
				? { serviceWorkerEventDelay: init.serviceWorkerEventDelay }
				: {}),
			...(init.fetchTimeout ? { fetchTimeout: init.fetchTimeout } : {}),
			...(init.navigationHintWait
				? { navigationHintWait: init.navigationHintWait }
				: {}),
			...(init.assets ? { assets: init.assets } : {}),
			...(init.adblock !== false ? { adblock: true } : {}),
			// the client's name is this controller's own unless the host chose
			// one: a page that could name it would reach the real windows it
			// holds (see mintClientName). The others are the host origin's own
			// (keptHelperNames), so a STomp this one proxies does not meet them
			names: {
				...keptHelperNames(Object.getOwnPropertyNames(globalThis)),
				...init.names,
				client:
					init.names?.client ??
					mintClientName(Object.getOwnPropertyNames(globalThis)),
			},
			...(errorPage ? { errorPage } : {}),
			// a slot's agent: its pages know the hub and its message token
			...(init.agent ? { sites: init.agent.sites } : {}),
			// the hub of a site pool (as below): its slots are the proxy's own
			// origins (a slot's agent knows them from `sites`)
			...(init.sitePool &&
			init.sitePool.origins?.length &&
			!init.agent &&
			globalThis.isSecureContext === true
				? { slotOrigins: poolOrigins(init.sitePool, location.origin) }
				: {}),
		};

		if (init.agent) this.#rewriteWorkers = init.agent.pool;
		else if (rewriteWorkers > 0)
			this.#rewriteWorkers = new RewriteWorkers(
				new URL(assetFile(this.config.assets, 'rewriteWorker'), this.directory),
				rewriteWorkers,
			);
		// the rewriter is the wasm core, always: the controller compiles it
		// once and hands it to the rewrite workers (compiled) and the service
		// worker (as bytes it compiles itself), and the first handshake waits
		// for it (#rewriterReady), so no thread rewrites a script before it
		// holds the module
		// A slot's agent has no rewrite workers of its own: it only loads the
		// bytes, for its worker, and compiles them the first time a thread of
		// its agent cluster asks (#compiledNow), which a spare slot's
		// (SiteHub.warm) may never do
		this.#loaded = init.agent
			? this.#compileModules(WASM_ASSETS, false)
			: (this.#compiled = this.#compileModules(WASM_ASSETS));

		// a described transport is started where it is hosted before the first
		// handshake; a failure there never leaves the controller dead
		// the hooks' text must be in the config before the first handshake
		const hooksReady = resolveHooks(init.hooks, location.href).then(
			({ hooks, errors }) => {
				if (hooks) this.config.hooks = hooks;
				for (const error of errors) this.#reportHookError(error, null);
			},
		);
		// the blocker's module is one more of the wasm modules, loaded like
		// them, and the first handshake waits for it: the service worker
		// builds the engine once it holds the module. A module that cannot be
		// had leaves the blocker off (and the config says so to every document)
		// the default resources are the directory's own file
		// (init.assets.adblockResources), which the service worker reads from
		// this origin rather than through the transport, and so is the engine
		// snapshot a worker with no engine stored serves while it fetches the
		// default lists (init.assets.adblockSnapshot, asked for by its hash)
		this.#adblock = resolveAdblockOptions(
			init.adblock,
			new URL(assetName(init.assets, 'adblockResources'), this.directory).href,
			new URL(
				`${assetName(init.assets, 'adblockSnapshot')}?${ADBLOCK_SNAPSHOT}`,
				this.directory,
			).href,
		);
		// the default lists are kept for adblockDefaults(); the lists in force
		// start as the host's seed (the demo's kept editor state) or the defaults
		this.#adblockBase = this.#adblock;
		if (this.#adblock && init.adblockLists)
			this.#adblock = withAdblockLists(this.#adblock, init.adblockLists);
		// a slot's agent: the slot's worker asks the hub's engine, and needs
		// no module of its own
		const adblockReady: Promise<void> =
			!this.#adblock || init.agent
				? Promise.resolve()
				: this.#compileModules(['blocker']).then(() => {
						if (this.#modules?.blocker) return;
						this.#adblock = null;
						delete this.config.adblock;
					});
		const transportReady: Promise<void> =
			init.agent || !isTransportDescriptor(given)
				? Promise.resolve()
				: this.transportHost === 'worker'
					? this.#startWorker(given)
					: this.#importInPage(given);
		this.#transportUp = transportReady.catch(() => {});
		// the transport is hosted where it will stay (a worker that failed has
		// fallen back to the page by now, and setTransport keeps the host)
		// before the first handshake hands the config to any frame
		const idReady: Promise<void> = this.id
			? Promise.resolve()
			: keptControllerId().then((id) => {
					this.id = id;
					this.config.directory = `${this.directory.pathname}${id}/`;
				});
		// the rewriter is the wasm core module, so the first handshake waits
		// for it to load and compile here: a host that does not serve it is
		// told here, not by a page that cannot rewrite, and no thread is handed
		// a script to rewrite before it holds the module (the rewrite workers
		// are adopted before the service worker's handshake sends them a port,
		// the service worker compiles the bytes it is handed, and a page's
		// library compiles them synchronously if a rewrite beats the module)
		const rewriterReady = this.#rewriterReady();
		rewriterReady.then(() => this.#warmBundle()).catch(() => {});
		this.#hostReady = Promise.all([
			hooksReady,
			transportReady,
			idReady,
			adblockReady,
			rewriterReady,
		]).then(() => {
			if (this.transportHost === 'worker') this.config.workerTransport = true;
			else delete this.config.workerTransport;
			if (!this.#worker) this.#startClock();
			// a page of ours waits for the worker inside one of its tasks (the
			// event names the address, which exists from here on)
			window.addEventListener(`${SW_KICK}${this.config.directory}`, () =>
				this.#standIn(),
			);
		});

		// the host's own input gives its proxied documents no activation of
		// their own (./hostActivation.ts)
		watchHostInput(helperNames(this.config).client, (now) => {
			// (and the documents a Document-Isolation-Policy keeps out of
			// reach, once one was shown)
			if (this.#apart) void this.#apart.then((agent) => agent?.hostInput(now));
		});
		// the site pool, where the browser keeps its slots apart: only a
		// secure context's Origin-Agent-Cluster is heard
		if (
			init.sitePool &&
			init.sitePool.origins?.length &&
			!init.agent &&
			globalThis.isSecureContext === true
		)
			this.#sites = new SiteHub(
				{
					init,
					// the page whose frames show the sites: this one, or the host
					// page of the controller frame this controller runs in
					top: init.siteHost ?? location.origin,
					framesUp: init.siteHost ? 2 : 1,
					directory: this.directory,
					// by the hash of their bytes, as the workers (assetFile)
					frameFile: assetFile(this.config.assets, 'controllerFrame'),
					scriptFile: assetFile(this.config.assets, 'siteFrameScript'),
					codecKey: () => this.#call('codecKey', undefined),
					agentOptions: async () => {
						await this.#ready;
						return this.#agentOptions();
					},
					poolSize: () =>
						this.#rewriteWorkers instanceof RewriteWorkers
							? this.#rewriteWorkers.size
							: 0,
					serve: (port, decorate) => {
						if (this.#worker && 'serveDecorated' in this.#worker)
							this.#worker.serveDecorated(port, decorate);
						else {
							// the transport in this page: the handshake headers are
							// still the site's, asked over its port
							const asked = decorateOver(decorate);
							serveTransport(
								port,
								() => this.transport,
								asked.decorate,
								asked.admit,
							);
						}
					},
					jar: (port) => {
						if (this.#worker && 'serveJar' in this.#worker)
							this.#worker.serveJar(port);
						else serveJar(port);
					},
					blocker: (port) => {
						// the slots' workers build no engine: this page's worker's
						// answers theirs
						this.#ready.then(
							() =>
								this.serviceworker.postMessage(
									{
										[BLOCKER_SERVE]: {
											directory: this.config.directory,
										} satisfies BlockerServeMessage,
									},
									[port],
								),
							() => port.close(),
						);
					},
					rewritePorts: (ports) => {
						if (this.#rewriteWorkers instanceof RewriteWorkers)
							this.#rewriteWorkers.servePorts(ports);
					},
					arrive: (arrival) => this.siteArrive(arrival),
					request: (info) => this.#reportRequest(info),
					permission: (info) => this.#askPermission(info),
					passkeys: () => this.config.passkeys,
					passkeyPrompt: (request, port) => this.#passkeyPrompt(request, port),
					passkeyFocused: (client) => this.#passkeyFocused(client),
					identityChooser: (request, port) =>
						this.#identityChooser(request, port),
					setTransport: (descriptor) =>
						this.setTransport(descriptor as TransportDescriptor),
				},
				poolOrigins(init.sitePool, location.origin),
			);

		window.addEventListener('message', (event) => {
			// only our own frames: same origin as this page, or (the site
			// pool) of a slot's origin
			if (event.origin !== location.origin && !this.#sites?.has(event.origin))
				return;
			const found = frameOfSource(this.frames, event.source);
			if (!found) return;
			const { frame, nested } = found;
			// a document of the frame got a user activation: read it now
			const activated = activatedReport(event.data);
			if (activated !== null) {
				const apart = this.#sites ? null : frame.apartPath();
				if (this.#sites) frame.siteActivated(activated, nested);
				else if (apart) this.apartActivated(apart, activated, nested);
				else noteActivation(frame.historyWindow(), activated, nested);
				return;
			}
			// a document in a frame of the page tells the real top which client
			// it is (its requests are this frame's), when its history moved and
			// that a hook of the host's threw in it, as the page does; nothing
			// else is taken from it (where the frame is, and what it opens, is
			// its page's to say)
			if (nested) {
				const client = clientReport(event.data);
				const moved = frameMovedReport(event.data);
				const id = client ?? moved?.client;
				if (id) this.#clients.attribute(id, frame);
				// a frame in the page that navigated is a step of the frame's
				// history (a tab's Back steps it first): the buttons follow
				// (the site pool: once the agent of the frame's slot heard)
				if (moved && this.#sites)
					frame.siteNested(event.source as Window, moved.entry);
				const apart = moved && !this.#sites && frame.apartPath();
				if (apart) void frame.apartChanged(apart);
				const changed =
					moved && !this.#sites && !apart && frame.historyChanged();
				if (changed) this.frameNavigated(changed, frame);
				const thrown = client || moved ? null : hookErrorReport(event.data);
				if (thrown) this.#reportHookError(thrown, frame);
				return;
			}
			const navigate = navigateReport(event.data);
			if (navigate) {
				if (navigate.client) this.#clients.attribute(navigate.client, frame);
				// (the controller's word, never the page's: navigateReport takes
				// no such field from it)
				if (navigate.client && this.#isolationWanted.has(navigate.client))
					navigate.isolation = 'wanted';
				// the site pool: reported once the agent of the document's slot
				// took it (the frame's buttons are its history's)
				if (this.#sites)
					frame.siteReport(
						event.origin,
						navigate,
						navigationTypeReport(event.data),
						() => {
							frame.report(navigate);
							this.frameNavigated(navigate, frame);
						},
						historyRunReport(event.data),
					);
				else {
					if (!nested) frame.reportedFrom(event.source as Window);
					frame.report(navigate);
					this.frameNavigated(navigate, frame);
				}
				return;
			}
			const url = openRequest(event.data);
			if (url !== null) {
				init.onOpen?.(url, frame);
				this.dispatchEvent(new CustomEvent('open', { detail: { url, frame } }));
				return;
			}
			const hookError = hookErrorReport(event.data);
			if (hookError) this.#reportHookError(hookError, frame);
		});

		this.#ready = new Promise((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		// a controller that cannot start says so once, whether or not the
		// host waits for it
		this.#ready.catch(() => {});
		// the site pool's spare agent, once this controller is up
		if (this.#sites) this.#ready.then(() => this.#sites?.warm());
		this.#hostReady.catch((error) => {
			console.error(error);
			this.#readyReject(error instanceof Error ? error : new Error(`${error}`));
		});
		this.#hostReload =
			init.hostReload === undefined
				? hostReload()
				: Promise.resolve(init.hostReload ?? undefined);
		this.#hostReload.then((mode) => {
			if (mode) this.#hostReloaded = { mode, at: Date.now() };
		});

		// Our worker (re)started and asks its controllers to shake hands again.
		// A revive before the first handshake is nothing to act on (that
		// handshake is pending; our worker's own startup broadcast lands here
		// while a transport worker is still importing its module). The host
		// page is often controlled by the host's own service worker (an app
		// with a root worker): only a revive from one of our workers counts,
		// and only a controller of ours is adopted; a foreign worker in
		// control changes nothing about which worker we talk to (the
		// controllerchange handler below applies the same test).
		navigator.serviceWorker.addEventListener('message', async (event) => {
			if (
				typeof event.data !== 'object' ||
				event.data === null ||
				!(SW_REVIVE in event.data) ||
				!this.lastHandshake
			)
				return;
			const source = event.source;
			if (!(source instanceof ServiceWorker) || !this.#ours(source)) return;
			// The revive names the run of the worker it is from, and so did
			// the worker that took our handshake (hello): the same one knows us
			// already (its revive goes out to everyone a moment after it
			// starts, our handshake may be what started it), any other is a
			// worker that knows nobody. A handshake still on its way is given
			// a moment to be taken first. Nothing is asked over the port: a
			// stopped worker's port says nothing, and waiting out its silence
			// was a second on top of the first thing a host did after two
			// stops in a row
			const revive = event.data[SW_REVIVE] as ReviveMessage | null;
			const instance =
				typeof revive?.instance === 'string' ? revive.instance : null;
			if (instance !== null) {
				if (this.#awaiting || this.#standby) await this.#taken(REVIVE_PING_MS);
				if (this.#instance === instance) return;
			} else if (
				// a worker of a build that does not name itself: soon after a
				// handshake its revive is usually from the worker that handshake
				// started, which knows us already. Usually: a worker that stopped
				// right after it (Chrome stops idle ones; a crash) took the
				// registration with it, and its successor's revive is the only one
				// there will be. So ask over the port instead of assuming: an
				// answer means it knows us, silence or a dead port means shake
				// hands again
				Date.now() - this.lastHandshake <= REVIVE_GUARD_MS &&
				(await this.#knownToWorker())
			)
				return;
			const active = navigator.serviceWorker.controller;
			this.serviceworker =
				active && this.#ours(active)
					? active
					: (this.#registration?.active ?? source);
			this.#handshake();
		});

		// back from the back/forward cache: Chrome closed the page's
		// WebSockets on the way in, the transport's wisp connection with them
		// (RevivingTransport)
		window.addEventListener('pageshow', (event) => {
			if (!event.persisted) return;
			if (this.#worker instanceof TransportWorker)
				this.#worker.connectionLost();
			else connectionLost(this.transport);
		});

		// the tab is going away for good (not into the back/forward cache):
		// the worker forgets this controller now, so a link copied from it goes
		// to a live controller at once rather than to a dead port
		window.addEventListener('pagehide', (event) => {
			// without an address yet the worker never heard of this controller
			if (event.persisted || !this.id) return;
			try {
				this.serviceworker.postMessage({
					[CONTROLLER_CLOSE]: { directory: this.config.directory },
				});
			} catch (error) {
				// a worker that is already gone has nothing to forget
			}
		});

		// a worker still installing (a registration just made) is spoken to
		// once it is activated, or after REGISTER_WAIT_MS with whatever the
		// registration has by then; anything else (a test double included)
		// gets the handshake at once
		if (
			['installing', 'installed', 'activating'].includes(
				this.serviceworker.state,
			)
		)
			Promise.race([
				activated(this.serviceworker).catch(() => {}),
				sleep(REGISTER_WAIT_MS),
			]).then(() => {
				const active = this.#registration?.active;
				if (active && this.serviceworker.state !== 'activated')
					this.serviceworker = active;
				this.#handshake();
			});
		else this.#handshake();
		// a worker that activates after this handshake (a deploy the browser
		// installs while the page is open) is adopted without a reload
		this.#watchRegistration();
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			const controller = navigator.serviceWorker.controller;
			if (
				controller &&
				controller !== this.serviceworker &&
				this.#ours(controller)
			)
				this.rebind(controller).catch(() => {});
		});
	}
	/** the handover listeners (onHandover) */
	#handovers = new Set<() => void>();
	/**
	 * @internal `listener` runs when a newer service worker of the
	 * registration takes over, the moment the old one is stopped (Frame.go
	 * sends again a navigation it may have lost); the returned function
	 * removes it
	 */
	onHandover(listener: () => void): () => void {
		this.#handovers.add(listener);
		return () => this.#handovers.delete(listener);
	}
	/** run the handover listeners once `worker` starts activating */
	#takingOver(worker: ServiceWorker) {
		const changed = () => {
			if (worker.state === 'redundant')
				worker.removeEventListener('statechange', changed);
			if (worker.state !== 'activating' && worker.state !== 'activated') return;
			worker.removeEventListener('statechange', changed);
			for (const listener of [...this.#handovers]) listener();
		};
		worker.addEventListener('statechange', changed);
	}
	/** a worker served from our directory (the host's own service worker is not) */
	#ours(worker: ServiceWorker): boolean {
		return worker.scriptURL.startsWith(this.directory.href);
	}
	/** the registration the host gave, else the one for the directory */
	#findRegistration(): Promise<ServiceWorkerRegistration | undefined> {
		return this.#registration
			? Promise.resolve(this.#registration)
			: navigator.serviceWorker.getRegistration(this.directory.href);
	}
	async #watchRegistration() {
		try {
			const registration = await this.#findRegistration();
			if (!registration) return;
			const adopt = (worker: ServiceWorker | null) => {
				if (!worker) return;
				this.#takingOver(worker);
				activated(worker).then(
					() => {
						// heal() rebinds on its own once its worker is activated
						if (worker !== this.serviceworker && !this.#healing)
							this.rebind(worker).catch(() => {});
					},
					() => {},
				);
			};
			registration.addEventListener('updatefound', () =>
				adopt(registration.installing),
			);
			adopt(registration.installing || registration.waiting);
		} catch (error) {
			// no registration to watch
		}
	}
	/**
	 * The service worker answered the handshake with another build: the page
	 * loaded a newer bundle than the worker still active (a deploy the browser
	 * has not finished installing), or the other way round. Update the
	 * registration and, when the new worker activates within the grace
	 * period, bind to it and shake hands again. Otherwise the user is not kept
	 * waiting: `wait()` resolves on the worker we have, `stale` records both
	 * builds (a `stale` event for the host's notice) and the new worker is
	 * adopted when it does activate (the old one may be pinned by a request
	 * that never settles).
	 */
	async #heal(build: string) {
		const settle = () => {
			this.#healing = false;
			if (!this.stale)
				console.warn(
					`Stomp: the controller is build ${BUILD}, the service worker is build ${build}; the new worker has not activated yet, continuing with the old one and switching when it does`,
				);
			this.stale = { controller: BUILD, worker: build };
			this.config = { ...this.config, build };
			this.isReady = true;
			this.#readySettled = true;
			this.#readyResolve();
			this.dispatchEvent(new CustomEvent('stale', { detail: this.stale }));
		};
		// the second mismatch in a row: the update did not help
		if (this.#healing) return settle();
		this.#healing = true;
		console.warn(
			`Stomp: the controller is build ${BUILD}, the service worker is build ${build}; updating the service worker`,
		);
		try {
			const worker = await Promise.race([
				this.#updatedWorker(),
				sleep(UPDATE_GRACE_MS).then(() => null),
			]);
			if (!worker) return settle();
			await this.rebind(worker);
		} catch (error) {
			settle();
		}
	}
	/**
	 * The registration's newer worker, activated: one the browser already
	 * found, or one an update finds now. Null when there is nothing newer
	 * than the worker this controller talks to.
	 */
	async #updatedWorker(): Promise<ServiceWorker | null> {
		const registration = await this.#findRegistration();
		if (!registration) return null;
		// the registration's active worker is not the one we were handed (the
		// host picked while a newer one was installing): that one, now
		const active = registration.active;
		if (active && active !== this.serviceworker) return active;
		let worker: ServiceWorker | null =
			registration.installing || registration.waiting;
		if (!worker) {
			const found = new Promise<ServiceWorker | null>((resolve) =>
				registration.addEventListener(
					'updatefound',
					() => resolve(registration.installing),
					{ once: true },
				),
			);
			await registration.update().catch(() => {});
			worker = await Promise.race([
				found,
				sleep(UPDATE_FOUND_MS).then(
					() => registration.installing || registration.waiting,
				),
			]);
		}
		if (worker) return activated(worker);
		return null;
	}
	/**
	 * Talk to another service worker from now on (default: the registration's
	 * active worker) and shake hands again; the next ready answer settles
	 * `wait()` as usual. Hosts that update the worker themselves call this
	 * instead of reaching into the controller.
	 */
	async rebind(worker?: ServiceWorker): Promise<void> {
		if (!worker) {
			const registration = await this.#findRegistration();
			worker = registration?.active ?? undefined;
			if (!worker)
				throw new Error(`No active service worker for ${this.directory.href}`);
		}
		this.serviceworker = worker;
		this.#handshake();
	}
	/**
	 * Start the transport worker and have it host `descriptor`. When the
	 * worker cannot start or the module cannot be imported there, the page
	 * imports it instead (the `transporthost` event tells the host); when
	 * that fails too, the controller holds a transport that fails every
	 * request until `setTransport()` gives it one.
	 */
	async #startWorker(descriptor: TransportDescriptor): Promise<void> {
		const url = new URL(
			assetFile(this.config.assets, 'transportWorker'),
			this.directory,
		);
		let worker: TransportWorker | undefined;
		try {
			worker = new TransportWorker(
				url,
				this.#handshakeHeaders,
				this.#keepAlive,
				this.#admitSession,
				this.#carrierChosen,
				(note) => this.#note(note),
				bootWorker(url),
			);
			if (this.#debugTransport) worker.debugTransport(true);
			const host = this.#carrierHost(descriptor);
			if (host) worker.carrierHost(host);
			await worker.init(resolvedModule(descriptor));
			this.#worker = worker;
			// the host's own view of the transport, served by the worker like
			// the service worker's
			this.transport = new RemoteTransport(worker.serve());
		} catch (error) {
			worker?.terminate();
			console.warn(
				'Stomp: the transport worker could not host the transport, hosting it in the page',
				error,
			);
			this.transportHost = 'page';
			await this.#importInPage(descriptor);
			this.dispatchEvent(
				new CustomEvent('transporthost', { detail: { host: 'page', error } }),
			);
		}
	}
	/**
	 * A controller that hosts its transport in the page has no worker to
	 * keep the time for #keepAlive: the transport worker's script is started
	 * for its clock alone (it imports nothing until it is told to). Where
	 * that script cannot start either (the reason some transports are in the
	 * page), the page's own timer is what there is: good for five minutes
	 * of a hidden tab, once a minute after.
	 */
	#startClock() {
		const own = () => setInterval(this.#keepAlive, KEEPALIVE_MS);
		try {
			const url = new URL(
				assetFile(this.config.assets, 'transportWorker'),
				this.directory,
			);
			const clock = new TransportWorker(
				url,
				this.#handshakeHeaders,
				this.#keepAlive,
				undefined,
				undefined,
				undefined,
				bootWorker(url),
			);
			clock.onFailure(() => {
				clock.terminate();
				own();
			});
		} catch (error) {
			own();
		}
	}
	/**
	 * The carrier host's port, for a descriptor whose transport rides a wisp
	 * carrier (a `wisp` URL): the SharedWorker that keeps the origin's wisp
	 * connections up across reloads and tabs (carrierHost.ts). Null without
	 * one; the transport opens its own carrier then.
	 */
	#carrierHost(descriptor: TransportDescriptor): MessagePort | null {
		const first = descriptor.options?.[0] as { wisp?: unknown } | undefined;
		if (!this.#sharesCarrier || typeof first?.wisp !== 'string') return null;
		return startCarrierHost(
			new URL(assetFile(this.config.assets, 'transportWorker'), this.directory),
		);
	}
	/** import a descriptor's module in this page (`host: 'page'`, or the worker fallback) */
	async #importInPage(descriptor: TransportDescriptor): Promise<void> {
		const host = this.#carrierHost(descriptor);
		if (host) useCarrierHost(host);
		try {
			this.transport = await importTransport(descriptor);
		} catch (error) {
			console.error('Stomp: the transport module could not be imported', error);
			this.transport = failingTransport(error);
		}
	}
	/** whether the worker at the other end of our port answers within REVIVE_PING_MS (it holds this controller) */
	async #knownToWorker(): Promise<boolean> {
		const rpc = this.#rpc;
		if (!rpc) return false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				rpc.call('route', 'https://example.com/'),
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('no answer')),
						REVIVE_PING_MS,
					);
				}),
			]);
			return true;
		} catch (error) {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}
	/** resolves when the worker has taken the handshake on its way (hello), or after `ms` */
	#taken(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				this.#takenWaiters.delete(done);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.#takenWaiters.add(done);
		});
	}
	/** the handshake on its way was taken, or will not be (its port closed) */
	#settleTaken() {
		this.#awaiting = false;
		for (const done of [...this.#takenWaiters]) done();
	}
	/** (re)register with the service worker once the transport is hosted */
	#handshake() {
		this.#hostReady.then(
			() => this.#handshakeNow(),
			() => {
				// the controller could not start (the constructor said why)
			},
		);
	}
	/**
	 * Wait for the rewriter's wasm core module to load and compile
	 * (#compileModules), and fail with the asset's key when the host does
	 * not serve it: the rewriter is wasm-only, so without the module no
	 * script can be rewritten. The first handshake waits for this, so the
	 * controller hands nothing to the service worker and `wait()` rejects.
	 */
	async #rewriterReady(): Promise<void> {
		await this.#loaded;
		const compiled = (await this.#compiled) ?? {};
		if (this.#init.agent ? !this.#modules?.core : !compiled.core) {
			const url = new URL(
				assetName(this.config.assets, 'core'),
				this.directory,
			);
			throw new Error(
				`Stomp: the host does not serve the asset 'core' (${url.href}). The rewriter is the wasm core module; serve dist/${DEFAULT_ASSETS.core} beside the other bundles, or name it in init.assets.core.`,
			);
		}
		await this.#fetchLibrary();
	}
	/**
	 * Fetch the document bundle by the URL a proxied document's shell loads
	 * it with, so that the HTTP cache has it when the first document asks:
	 * that document downloaded all of it (510 KB), its parser waiting
	 * between its first byte and its first script. A host that serves it
	 * no-cache (the demo) still has each document ask whether it changed.
	 * Nothing waits for this, and a failure leaves the document to fetch
	 * the bundle itself, as before.
	 */
	#warmBundle() {
		const url = new URL(injectDocumentFile(this.config), this.directory);
		fetch(url)
			.then((response) => response.arrayBuffer())
			.catch(() => {});
	}
	/**
	 * Fetch the light rewriter library asset (`init.assets.rewriterLib`) by the
	 * URL a page's shell loads it with (src/routeURL.ts), which leaves it in
	 * the HTTP cache where a proxied top's shell and a sandboxed frame's
	 * synchronous request find it. The library is the wasm glue the inject
	 * bundles do not carry; a top cannot rewrite without it. Throws, with the
	 * asset's key, when the host does not serve it.
	 */
	async #fetchLibrary(): Promise<void> {
		const url = new URL(libraryFile(this.config.assets), this.directory);
		const missing = (why: string) =>
			new Error(
				`Stomp: the host does not serve the asset 'rewriterLib' (${why} for ${url.href}). The inject bundles load the light rewriter library from that file; serve dist/${DEFAULT_ASSETS.rewriterLib} beside the other bundles, or name it in init.assets.rewriterLib.`,
			);
		let response: Response;
		try {
			response = await bootFetch(url);
		} catch (error) {
			throw missing(`${error}`);
		}
		if (!response.ok) throw missing(`HTTP ${response.status}`);
		// a host that answers every path with its own page
		const type = response.headers.get('content-type') ?? '';
		if (/^text\/html\b/i.test(type)) throw missing(`a ${type} answer`);
		// the cache keeps a response that was read to its end
		const bytes = await response.arrayBuffer();
		// a slot's agent makes the library its slot's frames share from it
		// (src/controller/slotLibrary.ts)
		if (this.#init.agent) this.#libraryText = new TextDecoder().decode(bytes);
	}
	/** the light rewriter library's file as a slot's agent read it (#fetchLibrary), null elsewhere @internal */
	get libraryText(): string | null {
		return this.#libraryText;
	}
	#libraryText: string | null = null;
	/**
	 * What the browser makes of cross-origin isolation (./isolationProbe.ts),
	 * asked once the worker first needs it and kept; asked again after it
	 * could not tell
	 */
	#isolationEngine(): Promise<IsolationEngine | null> {
		this.#isolationProbe ??= probeIsolation(this.config.directory).then(
			(engine) => {
				if (!engine) this.#isolationProbe = undefined;
				return engine;
			},
		);
		return this.#isolationProbe;
	}
	#isolationProbe?: Promise<IsolationEngine | null>;
	/** the clients the worker said show a page isolated natively without isolation (NavigateInfo.isolation) */
	#isolationWanted = new Set<string>();
	/**
	 * The agent that reaches the documents a Document-Isolation-Policy of
	 * the proxy's own isolates, out of this realm's reach (./apart.ts): made
	 * the first time a frame shows one, null when it could not start (it is
	 * tried again a minute later)
	 */
	#apart: Promise<ApartAgent | null> | null = null;
	/** the worker served a document with the proxy's Document-Isolation-Policy (Controllerbound apartServed) */
	#apartServed = false;
	/** @internal the agent of the documents a Document-Isolation-Policy isolates (./apart.ts) */
	apartAgent(): Promise<ApartAgent | null> {
		// none before the worker served such a document: until then a frame
		// out of reach shows the host's initial about:blank (each new tab of
		// a RemoteController's host), an error page or another origin, which
		// no agent reaches, and starting one there put a document of its own
		// in a process of its own under every such host
		if (!this.#apartServed) return Promise.resolve(null);
		return (this.#apart ??= (async () => {
			await this.#ready;
			const token = Array.from(
				crypto.getRandomValues(new Uint8Array(16)),
				(byte) => byte.toString(16).padStart(2, '0'),
			).join('');
			const agent = await this.#call('apartAgent', {
				token,
				script: new URL(
					assetFile(this.config.assets, 'controllerFrameScript'),
					this.directory,
				).href,
			})
				.then(() =>
					ApartAgent.start(new URL(`${APART_ROUTE}/${token}`, this.directory), {
						client: helperNames(this.config).client,
						up: (this.#init.framesUp ?? 0) + 1,
					}),
				)
				.catch(() => null);
			if (!agent) {
				setTimeout(() => (this.#apart = null), 60_000);
				return null;
			}
			// what the documents read synchronously of the controller's window
			const geometry = sharedGeometry(window);
			if (geometry) agent.geometry(geometry);
			const core = this.#modules?.core;
			if (core) agent.core(core.slice(0));
			return agent;
		})());
	}
	/**
	 * @internal what the agent says of the frame at `path` (its indices from
	 * the window whose frames they are), null when no agent reaches it
	 */
	async apartInfo(path: number[]): Promise<ApartFrameInfo | null> {
		return (await this.apartAgent())?.info(path) ?? null;
	}
	/** @internal step, reload or mark the frame at `path` through the agent; null when no agent reaches it */
	async apartCommand(
		path: number[],
		command: ApartCommand,
	): Promise<boolean | null> {
		return (await this.apartAgent())?.command(path, command) ?? null;
	}
	/** @internal a document of the frame at `path`, out of reach here, reported a user activation */
	apartActivated(path: number[], token: string, nested: boolean) {
		void this.apartAgent().then((agent) =>
			agent?.activated(path, token, nested),
		);
	}
	/**
	 * The wasm artifacts, loaded once and compiled once, here. The rewrite
	 * workers share this page's agent cluster and get the compiled modules,
	 * which they only instantiate. The service worker does not (a message
	 * holding a WebAssembly.Module never reaches it), so it gets the bytes
	 * and compiles them on its own thread: with the next handshake, or now
	 * when it already shook hands. One that fails to load or compile is left
	 * out, and its JavaScript rewriter answers. The blocker's module
	 * (`adblock`, docs/adblock.md) runs in the service worker alone: its
	 * bytes go there, and the module compiled here is only kept
	 * (#blockerHeld).
	 */
	async #compileModules(names: readonly BundleAsset[], compile = true) {
		const compiled: Record<string, WebAssembly.Module> = {};
		const loaded: Record<string, ArrayBuffer> = {};
		await Promise.all(
			names.map(async (name) => {
				try {
					// the core module by the URL a page's synchronous fetch of it
					// asks (routeURL.ts coreWasm), which the HTTP cache answers
					const response = await bootFetch(
						new URL(
							name === 'core'
								? coreFile(this.config.assets)
								: name === 'blocker'
									? assetFile(this.config.assets, name)
									: assetName(this.config.assets, name),
							this.directory,
						),
					);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const bytes = await response.arrayBuffer();
					if (name === 'blocker')
						void compileModule(bytes).then(
							(module) => (this.#blockerHeld = module),
							() => {},
						);
					else if (compile) {
						compiled[name] = await compileModule(bytes);
						if (name === 'core')
							publishCore(this.config.names?.client, compiled[name]);
					}
					loaded[name] = bytes;
				} catch (error) {
					// a blocker nobody asked for (it is on by default) is not a
					// fault of the host's: said once, and not as a warning
					if (name === 'blocker' && this.#adblock?.byDefault)
						console.info(
							'Stomp: the content blocker is off, its module did not load',
							error,
						);
					else console.warn(`Stomp: the ${name} module did not load`, error);
				}
			}),
		);
		// the rewriter's modules and the blocker's load apart: neither load
		// drops what the other brought
		this.#modules = { ...this.#modules, ...loaded };
		if (Object.keys(compiled).length) this.#rewriteWorkers?.adopt(compiled);
		if (this.#port) {
			const message: ControllerModulesMessage = {
				directory: this.config.directory,
				modules: loaded,
			};
			this.serviceworker.postMessage({ [CONTROLLER_MODULES]: message });
		}
		return compiled;
	}
	/** the rewriter's modules compiled, compiled now when they were not (a slot's agent) */
	#compiledNow(): Promise<Record<string, WebAssembly.Module>> {
		return (this.#compiled ??= this.#loaded.then(async () => {
			const compiled: Record<string, WebAssembly.Module> = {};
			for (const name of WASM_ASSETS) {
				const bytes = this.#modules?.[name];
				if (!bytes) continue;
				try {
					compiled[name] = await compileModule(bytes);
					if (name === 'core')
						publishCore(this.config.names?.client, compiled[name]);
				} catch (error) {
					console.warn(`Stomp: the ${name} module did not compile`, error);
				}
			}
			return compiled;
		}));
	}
	/** @internal the wasm modules each thread holds, by Assets key (tests: `rewriter: 'wasm'` reached every thread) */
	async wasmModules(): Promise<{
		serviceWorker: string[];
		rewriteWorkers: string[][];
	}> {
		await this.wait();
		return {
			serviceWorker: await this.#rpc!.call('modules', undefined),
			rewriteWorkers: this.#rewriteWorkers?.held() ?? [],
		};
	}
	/** @internal the public suffix list the service worker answers sites from (its suffix module's), null while tldts answers (tests) */
	async suffixList(): Promise<{ commit: string; date: string } | null> {
		await this.wait();
		return this.#rpc!.call('suffixList', undefined);
	}
	/** what waits for the worker from here on waits for the next handshake's answer */
	#expectHandshake() {
		this.isReady = false;
		if (!this.#readySettled) return;
		this.#readySettled = false;
		this.#ready = new Promise((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		this.#ready.catch(() => {});
	}
	/** the channel in use goes: what waits for the worker waits for the next handshake's answer */
	#retire() {
		if (this.#port) {
			// the worker hears it first: it lets the channel go once what is
			// in flight on it is answered. Calls of ours on it are made again
			// on the next channel (#call)
			this.#rpc?.call('retire', undefined).catch(() => {});
			this.#rpc?.abort('Service worker replaced');
			this.#linger(this.#port, this.#stopServing);
		}

		this.#expectHandshake();
		this.lastHandshake = Date.now();
		this.#awaiting = true;
		this.#instance = undefined;
		// a new handshake is a new (or restarted) service worker: it holds no
		// port to the emulated workers this controller hosts, and starts them
		// again when it needs them
		for (const worker of this.#serviceWorkers.values()) worker.terminate();
		this.#serviceWorkers.clear();
	}
	/**
	 * A channel this controller let go of: it goes on answering the worker
	 * (its transport, when it is served on this port, and its calls) until
	 * the worker closes it, once nothing is in flight there, or LINGER_MS.
	 * Closed at once, it failed every request in flight on it: a page's
	 * fetches, and a navigation as the host's error page (502)
	 */
	#linger(port: MessagePort, stopServing?: () => void) {
		const timer = setTimeout(() => {
			stopServing?.();
			port.close();
		}, LINGER_MS);
		port.addEventListener(
			'close',
			() => {
				clearTimeout(timer);
				stopServing?.();
			},
			{ once: true },
		);
	}
	/**
	 * a handshake offered for a stopped worker only (see #handshakeNow) is
	 * withdrawn. `linger`: for a handshake made in its place, while the worker
	 * may have taken the offer already (it says so a moment later): what it
	 * sent on the offer's channel is answered there (#linger)
	 */
	#dropStandby(linger = false) {
		const standby = this.#standby;
		if (!standby) return;
		this.#standby = undefined;
		if (linger) this.#linger(standby.port, standby.stopServing);
		else {
			standby.stopServing?.();
			standby.port.close();
		}
		for (const done of [...this.#takenWaiters]) done();
	}
	/**
	 * A page of ours has waited a moment for the worker inside one of its
	 * own tasks (a synchronous ask: document.cookie, localStorage, a
	 * synchronous XMLHttpRequest; see the bundle's Sync module) and says so
	 * with an event on this window. When the browser stopped the worker, the
	 * one the page's ask started knows no controller, and its revive waits
	 * in this thread's queue behind the page: the page spun to its limit (10
	 * seconds, 30 for a request) for an answer that could not come. So the
	 * handshake the revive would cause is offered now, from inside the
	 * page's task: every part of it is a message. Offered, not made: a
	 * worker that is running and only busy keeps the channel it has.
	 *
	 * An offer carries all a handshake does (the wasm modules, a port per
	 * rewrite worker), so one is made only where it can matter: never while
	 * another is on its way, and not again soon after the worker that has
	 * this controller declined one (DECLINED_HOLD_MS). A page making slow
	 * synchronous requests to a running worker, which every one of those
	 * asks would otherwise answer with an offer, gets one.
	 */
	#standIn() {
		if (!this.lastHandshake || this.#awaiting) return;
		const now = Date.now();
		if (this.#standby) {
			if (now - this.#standby.at < STANDBY_STALE_MS) return;
			this.#dropStandby();
		}
		const declined = this.#declined;
		if (
			declined &&
			declined.instance === this.#instance &&
			now - declined.at < DECLINED_HOLD_MS
		)
			return;
		this.#handshakeNow(true);
	}
	/**
	 * (Re)register with the service worker over a fresh MessageChannel. A
	 * `standby` handshake is for a worker that does not know this controller
	 * (one the browser stopped and something started again): a worker that
	 * knows it closes the offer's ports and nothing changes, a worker that
	 * takes it says so (hello), and the channel is this one from then on.
	 */
	#handshakeNow(standby = false) {
		this.#dropStandby(!standby);
		if (!standby) this.#retire();

		const channel = new MessageChannel();
		const port = channel.port1;
		if (!standby) this.#port = port;
		// the modules go first on the port (ControllerInitMessage
		// modulesOnPort); a worker that does not say it took them there (of
		// an earlier build) is sent them as for a load after the handshake
		const modules = this.#modules;
		let modulesTaken = !modules;
		const modulesAfter = () => {
			if (modulesTaken) return;
			modulesTaken = true;
			const message: ControllerModulesMessage = {
				directory: this.config.directory,
				modules: modules!,
			};
			this.serviceworker.postMessage({ [CONTROLLER_MODULES]: message });
		};
		let stopServing: (() => void) | undefined;
		/** whether this channel is the one in use; a standby offer the worker answers becomes it */
		const current = (): boolean => {
			if (this.#port === port) return true;
			if (this.#standby?.port !== port) return false;
			this.#standby = undefined;
			this.#retire();
			this.#port = port;
			this.#rpc = rpc;
			this.#stopServing = stopServing;
			this.#postClientHints();
			return true;
		};
		// the worker dropped this controller (another took its id) or went
		// away: a call on the dead port would wait forever, so every pending
		// and later one fails at once
		// (a worker that went away comes back knowing no controller and asks
		// for a handshake: calls wait for that one, see #call; a controller
		// another took the id of has nothing to wait for)
		let superseded = false;
		port.addEventListener('close', () => {
			// the worker knows this controller and declined the offer
			if (this.#standby?.port === port) this.#dropStandby();
			if (this.#port !== port) return;
			rpc.abort('Service worker port closed');
			this.#settleTaken();
			if (!superseded) this.#expectHandshake();
		});

		const rpc = new RpcHelper<Controllerbound, SWbound>(
			{
				hello: async (info) => {
					if (!current()) return;
					this.#instance = info?.instance;
					if (info?.portModules) modulesTaken = true;
					else modulesAfter();
					this.#settleTaken();
					this.#init.agent?.heard?.();
				},
				replaced: async () => {
					if (this.#port !== port) return;
					superseded = true;
					rpc.abort('Controller replaced');
				},
				isolationEngine: async () => [await this.#isolationEngine(), []],
				isolationWanted: async (client) => {
					if (typeof client !== 'string') return;
					keepClient(this.#isolationWanted, client);
					this.#init.onIsolationWanted?.(client);
				},
				apartServed: async () => {
					this.#apartServed = true;
				},
				// (kept a while: the worker reads it at once)
				blobProbe: async () => {
					const url = URL.createObjectURL(new Blob([]));
					setTimeout(() => URL.revokeObjectURL(url), 10000);
					return [url, []];
				},
				mediaVerdict: async (constraints) => [
					await mediaVerdict(constraints),
					[],
				],
				permission: async (info) => [await this.#askPermission(info), []],
				siteSlot: async (site) => [
					this.#init.agent
						? await this.#init.agent.siteSlot(site)
						: this.#sites
							? ((await this.#sites.originOf(site, location.origin)) ??
								location.origin)
							: null,
					[],
				],
				siteHomed: async (site) => [
					(await this.#sites?.homed(site)) ?? false,
					[],
				],
				blockerPort: async () => {
					const blocker = this.#init.agent?.blocker?.() ?? null;
					return [blocker, blocker ? [blocker] : []];
				},
				passkeyPrompt: async ({ request, port }) => [
					await this.#passkeyPrompt(request, port),
					[],
				],
				passkeyFocused: async (client) => [
					await this.#passkeyFocused(client),
					[],
				],
				identityChooser: async ({ request, port }) => [
					await this.#identityChooser(request, port),
					[],
				],
				crossSite: async (args) => [
					this.#init.agent
						? await this.#init.agent.crossSite(args)
						: this.#sites
							? await this.#sites.cross(args.site, args.arrival)
							: null,
					[],
				],
				ready: async (info) => {
					if (!current()) return;
					// a worker of a build that says no hello
					if (this.#awaiting) this.#settleTaken();
					modulesAfter();
					const build = info?.build;
					// the worker we already settled on as stale answers again
					// (it restarted): nothing new to heal
					if (
						build !== undefined &&
						build !== BUILD &&
						this.stale?.worker !== build
					) {
						this.#heal(build);
						return;
					}
					this.#healing = false;
					// the id both sides agreed on, visible to the host
					if (build !== undefined) this.config = { ...this.config, build };
					// the rules travel with every handshake (a new worker starts empty)
					if (this.#rules.length) await rpc.call('rules', this.#rules);
					// the shields travel with every handshake too (a new worker
					// starts with none)
					const shields = this.#shields.all();
					if (shields.length)
						await rpc.call('shields', { list: shields, seed: this.#fpSeed });
					// how the host was loaded is said once: it is about the pages
					// the host shows again right after
					const reloaded = this.#hostReload;
					this.#hostReload = null;
					const mode = await reloaded;
					if (mode) await rpc.call('hostReload', mode);
					if (this.stale && build === BUILD) {
						this.stale = null;
						this.dispatchEvent(
							new CustomEvent('rebind', { detail: { build } }),
						);
					}
					this.isReady = true;
					this.#readySettled = true;
					this.#readyResolve();
				},
				startServiceWorker: async ({ id, url, type }) => {
					// a page's emulated service worker (docs/service-workers.md):
					// only this controller holds its Worker, no page reaches it
					const worker = new Worker(url, {
						type: type === 'module' ? 'module' : 'classic',
					});
					// a service worker's uncaught error is its own console's, never
					// the host page's (one that throws at its top level fails its
					// registration instead)
					worker.addEventListener('error', (event) => event.preventDefault());
					const transport = new MessageChannel();
					if (this.#worker) this.#worker.servePort(transport.port1);
					else
						serveTransport(
							transport.port1,
							() => this.transport,
							this.#handshakeHeaders,
							this.#admitSession,
						);
					// with `rewriter: 'wasm'` the worker rewrites what it evaluates
					// in the modules compiled here, as a page's dedicated worker
					// does in its page's (WORKER_MODULES): it is a worker of this
					// agent cluster, and they follow on a port of their own once
					// they are in, so the worker never waits for them
					const modules = new MessageChannel();
					void this.#compiledNow().then((compiled) =>
						modules.port1.postMessage({ [WORKER_MODULES]: compiled }),
					);
					worker.postMessage(
						{ [TRANSPORT_INIT]: true, [WORKER_MODULES]: true },
						[transport.port2, modules.port2],
					);
					const channel = new MessageChannel();
					worker.postMessage({ [SW_PORT]: true }, [channel.port2]);
					this.#serviceWorkers.get(id)?.terminate();
					this.#serviceWorkers.set(id, worker);
					return [channel.port1, [channel.port1]];
				},
				stopServiceWorker: async ({ id }) => {
					this.#serviceWorkers.get(id)?.terminate();
					this.#serviceWorkers.delete(id);
				},
				pageModules: async (port) => {
					// a proxied top's rewriter library (src/inject/rewriter.ts)
					// instantiates the modules this controller compiled. A page
					// outside this agent cluster (a tab opened with noopener)
					// hears a messageerror and keeps the JavaScript rewriter
					const compiled = await this.#compiledNow();
					try {
						port.postMessage({ [PAGE_MODULES]: compiled });
					} catch (error) {
						// the page is gone
					}
				},
				initRemoteTransport: async (port) => {
					// a page's own transport port (its WebSockets): served from the
					// worker when there is one, so the page's sockets run off-thread too
					if (this.#worker) this.#worker.servePort(port);
					else
						serveTransport(
							port,
							() => this.transport,
							this.#handshakeHeaders,
							this.#admitSession,
						);
				},
				request: async (info) => this.#reportRequest(info),
			},
			CONTROLLER_RPC,
			(data, transfer) => postToPort(port, data, transfer),
		);

		port.addEventListener('message', (event) => {
			const declined = standbyDeclined(event.data);
			if (declined === null) {
				rpc.receive(event.data);
				return;
			}
			// a running worker that has this controller: the offer's ports go
			// now, and it is not made again for a while (see #standIn)
			if (this.#standby?.port !== port) return;
			this.#declined = { instance: declined, at: Date.now() };
			this.#dropStandby();
		});
		port.start();
		if (standby) this.#standby = { port, at: Date.now() };
		else this.#rpc = rpc;

		const transfer: Transferable[] = [channel.port2];
		if (this.#worker) {
			// the service worker's transport is served from the worker, on a
			// port of its own that travels with the handshake
			const transportChannel = new MessageChannel();
			this.#worker.servePort(transportChannel.port1);
			transfer.push(transportChannel.port2);
		} else
			// the service worker's own transport shares this port with the rpc above
			stopServing = serveTransport(
				port,
				() => this.transport,
				this.#handshakeHeaders,
				this.#admitSession,
			);
		if (this.#standby?.port === port) this.#standby.stopServing = stopServing;
		else this.#stopServing = stopServing;

		// a slot's agent: the hub's cookie jar and blocker, for the slot's
		// worker
		if (this.#init.agent)
			transfer.push(this.#init.agent.jar(), this.#init.agent.blocker());

		// the rewrite workers' ports come last (see ControllerInitMessage)
		const rewritePorts = this.#rewriteWorkers?.ports() ?? [];
		transfer.push(...rewritePorts);

		const message: ControllerInitMessage = {
			directory: this.config.directory,
			config: this.config,
			build: BUILD,
			token: this.#token,
			...(standby ? { standby: true } : {}),
			...(rewritePorts.length
				? {
						rewritePool: {
							ports: rewritePorts.length,
							timeout: this.#rewriteTimeout,
						},
					}
				: {}),
			...(modules ? { modulesOnPort: true } : {}),
			...(this.#adblock ? { adblock: this.#adblock } : {}),
			...(this.#init.agent
				? {
						codecKey: this.#init.agent.codecKey,
						slot: true,
						slots: this.#init.agent.slots,
					}
				: {}),
			// the hub: its worker sends a site's documents to the site's slot
			...(this.#sites ? { pooled: true } : {}),
		};

		if (modules) {
			const first: ControllerModulesMessage = {
				directory: this.config.directory,
				modules,
			};
			port.postMessage({ [CONTROLLER_MODULES]: first });
		}
		this.serviceworker.postMessage({ [CONTROLLER_INIT]: message }, transfer);
		// what the pages' client hints carry before any page reported it
		if (!standby) this.#postClientHints();
	}
	/** a proxied request completed: the host hears of it with its frame */
	async #reportRequest(info: RequestInfo) {
		// a slot's agent: the hub has the frames
		if (this.#init.agent) {
			this.#init.agent.request(info);
			return;
		}
		// a worker's request is its creator's frame's (info.owner)
		const known = () => this.#clients.frame(info.client, info.owner);
		let frame = known();
		// a document's own request, and the subresources its head fetches,
		// are reported before the page has told us which frame it is in:
		// give that report a moment to arrive. Not without frames: the
		// controller frame relays every report to a host that owns them.
		// And once for a client that never tells (see ClientFrames)
		if (
			!frame &&
			info.client &&
			this.frames.length &&
			!this.#clients.silent(info.client)
		) {
			const deadline =
				Date.now() +
				(DOCUMENT_DESTINATIONS.has(info.destination)
					? ATTRIBUTION_WAIT_MS
					: SUBRESOURCE_WAIT_MS);
			while (!frame && Date.now() < deadline) {
				await sleep(50);
				frame = known();
			}
			if (!frame) this.#clients.silence(info.client);
		}
		// kept under the worker's own id too: the service worker
		// forgets who made a worker when it restarts
		if (frame && info.client && info.owner)
			this.#clients.attribute(info.client, frame);
		const event: RequestEvent = { ...info, frame };
		this.#onRequest?.(event);
		this.dispatchEvent(new CustomEvent('request', { detail: event }));
	}
	/** a site's passkey ceremony (its worker's, or a slot's worker's through its agent): the host asks the user */
	async #passkeyPrompt(
		request: PasskeyPrompt,
		port: MessagePort,
	): Promise<PasskeyAnswer | null> {
		const relay = this.#init.passkeyRelay;
		if (relay) return relay.prompt(request, port);
		const init = this.#init.passkeys;
		// nobody here to ask: the request ends as one the user declined
		if (!init) {
			port.close();
			return null;
		}
		return askHost(init, request, port, {
			frame: this.#clients.frame(request.client),
		});
	}
	/**
	 * whether the focus is in the page of the frame that shows the document
	 * `client`, a slot's (the site pool's ceremony focus check): the frame
	 * has it in the hub's page
	 */
	async #passkeyFocused(client: string): Promise<boolean> {
		if (this.#init.agent) return this.#init.agent.passkeyFocused(client);
		// the controller frame: its host's page has the frames
		const relay = this.#init.passkeyRelay?.focused;
		if (relay) return relay(client);
		const frame = this.#clients.frame(client);
		return (
			!!frame && document.hasFocus() && document.activeElement === frame.element
		);
	}
	/**
	 * a site's FedCM account chooser (its worker's, or a slot's worker's
	 * through its agent), drawn in this page over the document's frame, or
	 * by the host's page of the controller frame (src/controller/
	 * accountChooser.ts)
	 */
	#identityChooser(
		request: IdentityChooserRequest,
		port: MessagePort,
	): Promise<number> {
		const relay = this.#init.identityRelay;
		if (relay) return relay(request, port);
		return drawAccountChooser(
			this.#clients.frame(request.client)?.element ?? null,
			request,
			port,
		);
	}
	/** a site asks for a permission: the host's onPermissionRequest answers */
	async #askPermission(info: PermissionRequestInfo): Promise<boolean | null> {
		if (this.#init.agent) return this.#init.agent.permission(info);
		const ask = this.#init.onPermissionRequest;
		if (!ask) return null;
		try {
			const answer = await ask({
				origin: info.origin,
				permission: info.permission,
				frame: this.#clients.frame(info.client),
				...(info.client ? { client: info.client } : {}),
			});
			return typeof answer === 'boolean' ? answer : null;
		} catch (error) {
			return null;
		}
	}
	/**
	 * Tell the worker what the browser's client hints carry that a worker
	 * cannot read (src/server/clientHints.ts): the pixel ratio and the media
	 * preferences, every window's; a `viewport` is the size of a frame
	 * about to navigate (its top-level navigation's viewport hints)
	 */
	#postClientHints(viewport?: [number, number]) {
		const query = (text: string) => {
			try {
				return window.matchMedia(text).matches;
			} catch (error) {
				return false;
			}
		};
		const report: ClientHintsReport = {
			directory: this.config.directory,
			dpr: window.devicePixelRatio,
			colorScheme: query('(prefers-color-scheme: dark)') ? 'dark' : 'light',
			reducedMotion: query('(prefers-reduced-motion: reduce)')
				? 'reduce'
				: 'no-preference',
			reducedTransparency: query('(prefers-reduced-transparency: reduce)')
				? 'reduce'
				: 'no-preference',
			...(viewport ? { viewport, top: true } : {}),
		};
		try {
			this.serviceworker.postMessage({ [CLIENT_HINTS]: report });
		} catch (error) {
			// no worker yet: the pages report it themselves
		}
	}
	/**
	 * @internal The size of a frame about to navigate (Frame.go, and the
	 * host's frames in isolation mode): what its navigation's viewport
	 * client hints name until its document reports its own
	 */
	reportViewport(width: number, height: number) {
		// once the controller has its address: a report names it
		if (width > 0 && height > 0)
			this.#hostReady.then(() =>
				this.#postClientHints([Math.round(width), Math.round(height)]),
			);
	}
	/**
	 * A page's WebSocket handshake carries the jar's Cookie header for the
	 * socket's URL, HttpOnly cookies included, under the SameSite rules for
	 * the page's origin (its Origin header). The header is added here, in
	 * the controller's realm, so the page never holds it; without a worker
	 * to ask (not ready, an error) the handshake goes out without one.
	 * Rejects with HANDSHAKE_REFUSED when the built-in blocker's lists block
	 * the socket: the transport's host fails it without connecting.
	 */
	#handshakeHeaders = async (
		url: URL,
		given: RawHeaders,
	): Promise<RawHeaders> => {
		// what Chrome's handshake carries besides: the user's languages, and a
		// request that no cache may answer. The transport's own client says
		// which encodings it takes (as on its HTTP requests), and offers no
		// permessage-deflate it could not speak
		// a context in a partition says so (SOCKET_PARTITION), for the jar
		const marked = given.find(
			([name]) => name.toLowerCase() === SOCKET_PARTITION,
		);
		const headers: RawHeaders = given.filter((header) => header !== marked);
		const has = (name: string) =>
			headers.some(([header]) => header.toLowerCase() === name);
		const languages = acceptLanguage(navigator.languages);
		if (languages && !has('accept-language'))
			headers.push(['Accept-Language', languages]);
		if (!has('pragma')) headers.push(['Pragma', 'no-cache']);
		if (!has('cache-control')) headers.push(['Cache-Control', 'no-cache']);
		if (!this.isReady || !this.#rpc) return headers;
		const origin = headers.find(([name]) => name.toLowerCase() === 'origin');
		// the built-in blocker (docs/adblock.md): a socket never passes the
		// service worker, where the engine is, so the worker is asked here,
		// beside the question for the cookies (one more message each way,
		// no wait of its own). A yes refuses the socket; no answer does not
		const blocked = this.#adblock
			? this.#rpc
					.call('socket', {
						url: url.href,
						source: origin && origin[1] !== 'null' ? origin[1] : '',
					})
					.catch(() => false)
			: false;
		// no jar answer: a handshake without cookies
		const cookie = this.#rpc
			.call('cookies', {
				op: 'get',
				url: url.href,
				header: true,
				...(origin ? { initiator: origin[1] } : {}),
				...(marked ? { partitionKey: marked[1] } : {}),
			})
			.catch(() => null);
		if (await blocked) throw new Error(HANDSHAKE_REFUSED);
		const jar = await cookie;
		return typeof jar === 'string' && jar
			? [...headers, ['Cookie', jar]]
			: headers;
	};
	/**
	 * Whether a page of `origin` may open a WebTransport session to `url`:
	 * a session never passes the service worker either, so the built-in
	 * blocker is asked as for a WebSocket (docs/adblock.md). No answer lets
	 * it go
	 */
	#admitSession = async (url: URL, origin: string): Promise<boolean> => {
		if (!this.#adblock || !this.isReady || !this.#rpc) return true;
		const blocked = await this.#rpc
			.call('socket', {
				url: url.href,
				source: origin === 'null' ? '' : origin,
				type: 'webtransport',
			})
			.catch(() => false);
		return !blocked;
	};
	/** the transport chose its carrier (in the worker, or in this page) */
	#carrierChosen = (info: CarrierInfo) => {
		this.carrier = info;
		this.dispatchEvent(new CustomEvent('carrier', { detail: info }));
	};
	/** resolves once the service worker has created a server for this controller */
	async wait(): Promise<void> {
		// a worker the browser stopped answers once something starts it
		if (this.lastHandshake && !this.isReady) this.#wake();
		await this.#ready;
	}
	/** a hook that threw in a realm, or a hook URL that failed: callback and `hookerror` event */
	#reportHookError(info: HookErrorInfo, frame: Frame | null) {
		this.hookErrors.push(info);
		this.#init.onHookError?.(info, frame);
		this.dispatchEvent(
			new CustomEvent('hookerror', { detail: { info, frame } }),
		);
	}
	/**
	 * Hot-swap the transport; in-flight requests finish on the old one. The
	 * argument matches `transportHost`: a TransportDescriptor for a
	 * worker-hosted transport (the worker imports and constructs it), a
	 * ProxyTransport instance for a page-hosted one; the other kind is a
	 * TypeError.
	 */
	async setTransport(
		transport: ProxyTransport | TransportDescriptor,
	): Promise<void> {
		await this.#hostReady;
		if (isTransportDescriptor(transport)) {
			if (!this.#worker)
				throw new TypeError(
					'Stomp: this controller hosts its transport in the page; setTransport() takes a ProxyTransport instance',
				);
			await this.#worker.setTransport(resolvedModule(transport));
		} else {
			if (this.#worker)
				throw new TypeError(
					'Stomp: this controller hosts its transport in a worker; setTransport() takes a TransportDescriptor',
				);
			this.transport = transport;
		}
	}
	/**
	 * A call to the service worker that a restart of it does not lose. The
	 * browser stops a worker nothing has reached for half a minute, and one
	 * that starts again knows no controller: it asks for a handshake, which
	 * is a new channel, and a call still waiting on the old one fails
	 * ("Service worker replaced"). It is made again on the channel that took
	 * its place, so a host's navigation after a page sat idle is carried
	 * through. A stopped worker hears nothing on a port, so a message goes
	 * with every call (SW_WAKE): that starts it.
	 */
	#wake() {
		try {
			this.serviceworker.postMessage({ [SW_WAKE]: true });
		} catch (error) {
			// a worker that is gone for good: the registration's next one
			// asks for the handshake itself
		}
	}
	/**
	 * Every KEEPALIVE_MS, on a worker's clock: the service worker hears from
	 * this controller, so the browser does not stop it while a controller is
	 * alive. It stops one nothing reached for 30 seconds, whatever the page
	 * shows, runs or holds open (measured: a visible tab, a hidden one, a
	 * page with a timer, a page with an open WebSocket), and the first thing
	 * a page or its host did after sitting idle then paid for a worker start
	 * and a handshake. A message and nothing else: no request, nothing per
	 * frame, and no event kept open (a worker with an event in progress
	 * keeps its successor waiting). One that finds the worker stopped anyway
	 * (the tab was frozen, the machine slept) starts it, and it asks for the
	 * handshake before anybody needs it.
	 */
	#keepAlive = () => {
		if (this.lastHandshake) this.#wake();
		this.#sites?.tick();
	};
	async #call<Method extends keyof SWbound>(
		method: Method,
		args: SWbound[Method][0],
	): Promise<SWbound[Method][1]> {
		for (let attempt = 0; ; attempt++) {
			this.#wake();
			await this.#ready;
			const rpc = this.#rpc!;
			try {
				return await rpc.call(method, args);
			} catch (error) {
				// the channel is still the one the call went out on: the worker
				// itself refused
				if (attempt >= 3 || (rpc === this.#rpc && this.isReady)) throw error;
			}
		}
	}
	/** replace the request rules the service worker applies (see ControllerInit.rules) */
	async setRules(rules: RequestRule[]): Promise<void> {
		this.#rules = rules;
		this.#sites?.apply('rules', rules);
		await this.#ready;
		await this.#call('rules', rules);
	}
	/**
	 * Per-site shields (the demo's content-blocker UI, docs/adblock.md):
	 * `get(host)` reads a host's state (the defaults when it has none),
	 * `set(host, patch)` changes it and pushes the whole set to the worker,
	 * `all()` is every entry (to persist), `replace(list)` sets them all.
	 */
	get shields(): Shields {
		return this.#shields;
	}
	/**
	 * The blocker's default filter lists (docs/adblock.md), for a host UI to
	 * show as toggle rows (the demo's Filter Lists editor): the list objects
	 * with their `name`, `url`, `trusted` and `format`, untouched by
	 * `setAdblockLists`. Empty when the host turned the blocker off.
	 */
	adblockDefaults(): AdblockList[] {
		return this.#adblockBase
			? this.#adblockBase.lists.map((l) => ({ ...l }))
			: [];
	}
	/**
	 * The filter lists the blocker is serving now: the defaults, or what
	 * `setAdblockLists` last set (an inline list among them is the custom-filters
	 * editor's text). Empty when the blocker is off.
	 */
	getAdblockLists(): AdblockList[] {
		return this.#adblock ? this.#adblock.lists.map((l) => ({ ...l })) : [];
	}
	/**
	 * Replace the built-in blocker's filter lists at runtime (docs/adblock.md
	 * "Changing the lists"): the service worker rebuilds the engine and swaps it
	 * in once compiled, keeping the old lists serving in between, so the change
	 * is live. An inline list (`{ filters, ... }`) compiles the custom-filters
	 * editor's own rules. The lists travel with every later handshake too, so a
	 * worker that restarts rebuilds from them. Returns `'live'` when the blocker
	 * is on to apply them, `'off'` when the host turned it off.
	 */
	async setAdblockLists(
		lists: (string | AdblockList)[],
	): Promise<AdblockApplied> {
		if (!this.#adblock) return { applied: 'off' };
		this.#adblock = withAdblockLists(this.#adblock, lists);
		this.#sites?.apply('adblock', { init: this.#adblock });
		await this.#ready;
		await this.#call('adblock', { init: this.#adblock });
		return { applied: 'live' };
	}
	/**
	 * Re-fetch and recompile the blocker's current lists (the demo's "Update
	 * lists" button): the engine is rebuilt even when the stored one for these
	 * exact lists is still fresh. `'off'` when the blocker is off.
	 */
	async refreshAdblockLists(): Promise<AdblockApplied> {
		if (!this.#adblock) return { applied: 'off' };
		this.#sites?.apply('adblock', { init: this.#adblock, refresh: true });
		await this.#ready;
		await this.#call('adblock', { init: this.#adblock, refresh: true });
		return { applied: 'live' };
	}
	/** drop every entry of the service worker's HTTP cache */
	async clearCache(): Promise<void> {
		this.#sites?.apply('clearCache', undefined);
		await this.#ready;
		await this.#call('clearCache', undefined);
	}
	/** @internal the service worker's passkey store (the controller frame asks for its host) */
	async passkeyCommand(
		command: PasskeyCommand,
	): Promise<PasskeyInfo[] | boolean | null> {
		await this.#ready;
		// (the site pool: every slot's worker keeps them in this one's store)
		return this.#call('passkeys', command);
	}
	/**
	 * @internal A command to the jar, from `cookies` or from the controller
	 * frame of a RemoteController (src/controller/frame.ts), with what a
	 * change of the jar means for the site pool's slots either way
	 */
	async cookieCommand(command: CookieCommand): Promise<CookieResult> {
		await this.#ready;
		const result = await this.#call('cookies', command);
		// the site pool: the slots' documents keep what they read of the jar
		if (this.#sites && (command.op === 'clear' || command.op === 'set'))
			this.#jarChanged();
		// and the device ids of a cleared host's origins, which each slot's
		// worker keeps for the documents it served
		if (command.op === 'clear')
			await this.#sites?.apply('forgetDeviceIds', command.origin);
		return result;
	}
	/** @internal which of these service worker clients no longer exist (ClientFrames; the controller frame asks for its host) */
	async goneClients(clients: string[]): Promise<string[]> {
		await this.#ready;
		const gone = await this.#call('goneClients', clients);
		// the site pool: a slot's documents are its worker's clients
		return this.#sites && gone.length ? this.#sites.goneClients(gone) : gone;
	}
	/**
	 * The cookie jar, for the host application only (pages never reach this
	 * port): read what the proxy would send, import Set-Cookie headers,
	 * export records, or wipe an origin.
	 */
	readonly cookies: CookieJar = cookieJar(async (command) => {
		const result = await this.cookieCommand(command);
		// every site's cookies are gone: so are the ids this origin's
		// controllers keep, the one name that would have outlived them
		if (command.op === 'clear' && command.origin === undefined)
			await forgetControllerIds();
		return result;
	});
	/**
	 * The passkeys the service worker holds for proxied sites
	 * (docs/passkeys.md), for the host application only: list them, forget
	 * one, or forget every one (of a relying party). `forgetStorage(origin)`
	 * forgets a site's too; `cookies.clear()` leaves them.
	 */
	readonly passkeys: PasskeyManager = passkeyManager((command) =>
		this.passkeyCommand(command),
	);
	/**
	 * Clear a site's virtualized storage (localStorage, sessionStorage,
	 * IndexedDB, Cache Storage) on the proxy origin, and the passkeys its host
	 * could have made (docs/passkeys.md): the "Forget me when I close this
	 * site" shield, called by the host once the site's last tab closes. The
	 * cookie jar is wiped through `cookies.clear(origin)`.
	 */
	async forgetStorage(origin: string): Promise<void> {
		// the site pool: the site's storage is its slot's
		this.#sites?.apply('forgetStorage', origin);
		await this.#ready;
		await this.#call('forgetStorage', origin);
	}
	/**
	 * A search engine's completions for `text`, as the host's own address
	 * bar shows them (src/controller/suggest.ts): asked through the
	 * transport from the engine's OpenSearch suggest endpoint, as a request
	 * of the host's (no proxied page's cookies or partition, no cookies at
	 * all), with the fields Chrome's omnibox sends. `options.engine` names
	 * the engine (an id of SEARCH_ENGINES or a SearchBuilder template of
	 * one, Google by default), `options.endpoint` any other engine's. Needs
	 * no service worker: it waits only for the transport.
	 */
	async suggest(text: string, options: SuggestOptions = {}): Promise<string[]> {
		await this.#transportUp;
		return suggestThrough(this.transport, text, options);
	}
	/** the proxied URL a frame should navigate to in order to load `url` */
	async route(url: string): Promise<string> {
		await this.#ready;
		return new URL(await this.#call('route', url), this.directory).href;
	}
	/**
	 * @internal the isolated host navigates a frame to the route `routed`
	 * itself (frame.ts frameCommand `typed`): its navigation waits for no
	 * document's hint. (A worker of a build that has no such call refuses.)
	 */
	async typed(routed: string): Promise<void> {
		await this.#ready;
		await this.#call('typed', routed);
	}
	/**
	 * The real URL a routed one stands for (the inverse of `route()`, with
	 * this controller's codec), or null for anything that is not a route: a
	 * host reading a routed URL off a frame or a report never has to parse
	 * one itself.
	 */
	async unroute(url: string): Promise<string | null> {
		await this.#ready;
		const routed = new URL(url, this.directory);
		// a slot of the site pool has the same routes on its own origin
		return this.#call(
			'unroute',
			this.#sites?.has(routed.origin)
				? new URL(
						`${routed.pathname}${routed.search}${routed.hash}`,
						this.directory,
					).href
				: routed.href,
		);
	}
	/**
	 * @internal the site pool: the slot `url`'s site is shown from (its
	 * origin), once that slot's agent and worker are up; null without a pool
	 */
	async siteOrigin(url: string): Promise<string | null> {
		if (!this.#sites) return null;
		await this.#ready;
		let site: string;
		try {
			site = await this.#call('siteOf', url);
		} catch (error) {
			// no site of its own (about:blank, a data: URL): any slot will do
			site = 'null';
		}
		// null: its slot does not answer from here (a network that lets
		// through the host's port alone, a slot left out since): the site is
		// shown from this page's origin, as without a pool
		return this.#sites.originOf(site);
	}
	/**
	 * @internal the site pool: the size of a host frame about to navigate to
	 * the slot `origin` (reportViewport), told to that slot's worker before
	 * the frame goes there: its top-level navigation's viewport hints
	 */
	async siteViewport(origin: string, width: number, height: number) {
		if (this.#sites && width > 0 && height > 0)
			await this.#sites.applyTo(origin, 'viewport', [
				Math.round(width),
				Math.round(height),
			]);
	}
	/** @internal the site pool: its slots' origins (none without a pool) */
	get siteOrigins(): string[] {
		return this.#sites?.origins ?? [];
	}
	/** whether this controller shows the sites from a pool of origins (ControllerInit.sitePool) */
	get siteMode(): boolean {
		return !!this.#sites;
	}
	/** @internal the site pool: whether `origin` is one of its slots */
	siteOriginKnown(origin: string): boolean {
		return !!this.#sites?.has(origin);
	}
	/** @internal the site pool: the slot `origin` sent a navigation back here (its agent is gone) */
	siteLeftOut(origin: string) {
		this.#sites?.leaveOut(origin);
	}
	/**
	 * @internal the site pool: ask the agent of `origin` about run `run` of
	 * the frame at `index` of this page (a run of this page's own origin, a
	 * site shown without the pool, is this realm's to answer)
	 */
	siteHistory(
		origin: string,
		index: number,
		run: number,
		op: SiteHistoryOp,
	): Promise<SiteHistoryAnswer | null> {
		if (origin === location.origin) {
			const win = window[index] as Window | undefined;
			return win
				? answerRun(win, run, op, helperNames(this.config).client)
				: Promise.resolve(null);
		}
		return this.#sites
			? this.#sites.history(origin, index, run, op)
			: Promise.resolve(null);
	}
	/** @internal the site pool: tell every slot's agent `op` of the frame at `index` of this page, unanswered */
	siteTell(index: number, op: SiteHistoryOp) {
		this.#sites?.tell(index, op);
	}
	/** @internal the site pool: what the frame at `index` of the host's page shows, asked of the agent of `origin` */
	siteFrameInfo(origin: string, index: number): Promise<SiteFrameInfo | null> {
		return this.#sites
			? this.#sites.frameInfo(origin, index)
			: Promise.resolve(null);
	}
	/** @internal the site pool: a user activation in the frame at `index`, told to the agent of `origin` */
	siteActivated(
		origin: string,
		index: number,
		token: string,
		nested: boolean,
	): Promise<boolean> {
		return this.#sites
			? this.#sites.activated(origin, index, token, nested)
			: Promise.resolve(false);
	}
	/** @internal the site pool: a command of the isolated RemoteController for the frame at `index` of the host's page, to the agent of `origin` (frame.ts frameCommand) */
	siteCommand(
		origin: string,
		index: number,
		command: SiteHistoryCommand,
	): Promise<boolean | null> {
		return this.#sites
			? this.#sites.command(origin, index, command)
			: Promise.resolve(null);
	}
	/** @internal a frame's report, or its history's state, changed: tell the host */
	frameNavigated(info: NavigateInfo, frame: Frame) {
		this.#init.onNavigate?.(info, frame);
		this.dispatchEvent(
			new CustomEvent('navigate', { detail: { info, frame } }),
		);
	}
	/** the site pool: the host changed the jar; every slot's worker tells its documents */
	#jarChanged() {
		if (this.#worker && 'jarChanged' in this.#worker)
			this.#worker.jarChanged('');
		else jarChanged('');
	}
	/** @internal a slot's agent: a navigation from another slot's worker is on its way */
	async siteArrive(arrival: SiteArrival): Promise<void> {
		await this.#call('arrive', arrival);
	}
	/** @internal a slot's agent: what the hub's host changed for every worker (FannedMethod) */
	async siteApply(method: FannedMethod, args: unknown): Promise<void> {
		switch (method) {
			case 'rules':
				return this.setRules(args as RequestRule[]);
			case 'shields':
				this.#shields.replace(args as SiteShields[]);
				return;
			case 'adblock': {
				const change = args as { init: AdblockInit; refresh?: boolean };
				if (!this.#adblock) return;
				this.#adblock = change.init;
				await this.#ready;
				await this.#call('adblock', change);
				return;
			}
			case 'clearCache':
				return this.clearCache();
			case 'forgetStorage':
				return this.forgetStorage(String(args));
			case 'forgetDeviceIds':
				await this.#ready;
				return this.#call(
					'forgetDeviceIds',
					typeof args === 'string' ? args : undefined,
				);
			case 'viewport': {
				const [width, height] = args as [number, number];
				this.reportViewport(Number(width), Number(height));
				return;
			}
		}
	}
	/** @internal a slot's agent: the hub's clock */
	siteTick() {
		this.#keepAlive();
	}
	/** the options a slot's agent runs its controller with: this one's, as resolved */
	#agentOptions(): Partial<ControllerInit> {
		const init = this.#init;
		const config = this.config;
		const hooks = config.hooks;
		return {
			id: this.id,
			codec: config.codec,
			...(config.cache === false ? { cache: false } : {}),
			...(config.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
			...(config.membrane === false ? { membrane: false } : {}),
			...(config.serviceWorkers === false ? { serviceWorkers: false } : {}),
			...(config.rewriter ? { rewriter: config.rewriter } : {}),
			...(config.serviceWorkerTimeout
				? { serviceWorkerTimeout: config.serviceWorkerTimeout }
				: {}),
			...(config.serviceWorkerEventDelay
				? { serviceWorkerEventDelay: config.serviceWorkerEventDelay }
				: {}),
			...(config.fetchTimeout ? { fetchTimeout: config.fetchTimeout } : {}),
			...(config.navigationHintWait
				? { navigationHintWait: config.navigationHintWait }
				: {}),
			...(config.assets ? { assets: config.assets } : {}),
			// a slot's documents are framed where this controller's are
			...(config.frameAncestors?.length
				? { frameAncestors: config.frameAncestors }
				: {}),
			...(config.openTab ? { openTab: true } : {}),
			...(config.requestLog ? { requestLog: true } : {}),
			...(config.errorPage ? { errorPage: config.errorPage } : {}),
			...(config.names ? { names: config.names } : {}),
			...(hooks
				? {
						hooks: {
							init: {
								...(hooks.pre ? { pre: { source: hooks.pre } } : {}),
								...(hooks.post ? { post: { source: hooks.post } } : {}),
							},
							...(hooks.workers ? { workers: true } : {}),
						},
					}
				: {}),
			adblock: this.#adblock ? (init.adblock ?? true) : false,
			rules: this.#rules,
			shields: this.#shields.all(),
			rewriteTimeout: this.#rewriteTimeout,
			// how the host was loaded, while the page it shows again may still
			// be coming (the worker's RESTORE_WINDOW_MS); none after, nor a
			// guess of the agent's own (its frame is no reloaded document)
			hostReload:
				this.#hostReloaded &&
				Date.now() - this.#hostReloaded.at < HOST_RESTORE_MS
					? this.#hostReloaded.mode
					: null,
		};
	}
	createFrame(element: HTMLIFrameElement = document.createElement('iframe')) {
		const frame = new Frame(this, element, this.#sandbox);
		this.frames.push(frame);
		this.#geometry.observe(element);
		return frame;
	}
	/** @internal measure the frames' geometry now (a frame about to navigate); settles once it was kept */
	measureGeometry(): Promise<void> {
		return this.#geometry.update();
	}
	/**
	 * @internal keep the host's geometry (./geometry.ts) on this window and
	 * tell every slot's agent: this page's own frames', or (an isolated
	 * RemoteController's controller frame) the host's page's
	 */
	shareGeometry(geometry: HostGeometry): Promise<void> {
		shareGeometry(window, geometry);
		if (this.#apart)
			void this.#apart.then((agent) => agent?.geometry(geometry));
		return this.#sites?.geometry() ?? Promise.resolve();
	}
}

/**
 * how long after the host page was reloaded a slot's agent that starts still
 * tells its worker (the worker's RESTORE_WINDOW_MS, src/server/rewrites.ts)
 */
const HOST_RESTORE_MS = 10_000;
/** how often `connected` looks for an insertion no mutation of the document's shows */
const CONNECTED_POLL_MS = 100;
/** how long `connected` waits for the element at most */
const CONNECTED_LIMIT_MS = 10_000;
/** what each element `connected` waits for resolves: kept as long as the element is */
const awaitingConnection = new WeakMap<Element, () => void>();

/**
 * Resolves once `element` is in the document, or once it has not been put
 * there for CONNECTED_LIMIT_MS. A mutation of the document's says so at once;
 * an insertion into a shadow tree is no mutation of the document's own, so a
 * timer looks as well. Neither holds the element (watchConnection): what
 * resolves the promise is kept by the element itself, so a frame dropped
 * before it is inserted takes its waiting with it.
 */
function connected(element: Element): Promise<void> {
	if (element.isConnected) return Promise.resolve();
	const waiting = new Promise<void>((resolve) =>
		awaitingConnection.set(element, resolve),
	);
	watchConnection(new WeakRef(element));
	return waiting;
}

/**
 * The observer and the timer of `connected`, made apart from it so that
 * nothing they close over reaches the element but the WeakRef: they stop once
 * it is in the document, past the limit, or collected
 */
function watchConnection(target: WeakRef<Element>) {
	const until = performance.now() + CONNECTED_LIMIT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		observer.disconnect();
		clearTimeout(timer);
	};
	const check = (polled: boolean) => {
		const element = target.deref();
		if (!element) return stop();
		if (element.isConnected || performance.now() >= until) {
			stop();
			const resolve = awaitingConnection.get(element);
			awaitingConnection.delete(element);
			return resolve?.();
		}
		if (polled) timer = setTimeout(() => check(true), CONNECTED_POLL_MS);
	};
	const observer = new MutationObserver(() => check(false));
	observer.observe(document, { childList: true, subtree: true });
	timer = setTimeout(() => check(true), CONNECTED_POLL_MS);
}

/** one run of a frame's history under a site pool (Frame #runs) */
interface SiteRun {
	/** names it to the agent of its origin, which keeps its states */
	id: number;
	origin: string;
	/** the last URL the frame reported from it */
	url: string;
	state: RunState;
	/** its agent answered for it */
	known: boolean;
	/** siteClock when it began */
	at: number;
	/** the frame's entries in it, as its documents reported them (HISTORY_RUN) */
	count: number;
	/** where in them the frame was last */
	index: number;
}

/**
 * The site pool: how many of the frame's entries are in other runs than
 * the one at `at` (the documents' `historyAcross`). The browser lists a
 * document the entries of its own origin around it, so a run of the same
 * origin with nothing but emptied runs between (a replace) is in that list
 * already
 */
export function entriesAcross(
	runs: readonly { origin: string; count: number }[],
	at: number,
): number {
	return entriesBeside(runs, at, -1) + entriesBeside(runs, at, 1);
}
/** entriesAcross on one side of the run at `at`: before it (`step` -1) or after it (1) */
function entriesBeside(
	runs: readonly { origin: string; count: number }[],
	at: number,
	step: number,
): number {
	const current = runs[at];
	if (!current) return 0;
	let across = 0;
	let joined = true;
	for (let i = at + step; i >= 0 && i < runs.length; i += step) {
		const run = runs[i];
		if (joined && run.count === 0) continue;
		if (joined && run.origin === current.origin) continue;
		joined = false;
		across += run.count;
	}
	return across;
}
/**
 * What every agent is told of a frame's runs, for the next document of the
 * frame (history.ts RunsExpectation), null while it has none
 */
export function runsExpectation(
	runs: readonly { origin: string; count: number; index: number }[],
	at: number,
): RunsExpectation | null {
	const current = runs[at];
	return current
		? {
				kind: 'expect',
				origin: current.origin,
				before: entriesBeside(runs, at, -1),
				index: current.index,
				count: current.count,
				after: entriesBeside(runs, at, 1),
			}
		: null;
}
/** a run's entries after the frame left it for a new one at `index` (a replace took that entry with it) */
export function prunedRun(
	run: { count: number; index: number },
	replaced: boolean,
) {
	run.count = Math.max(0, run.index + (replaced ? 0 : 1));
	run.index = Math.min(run.index, Math.max(0, run.count - 1));
}
/** a run's state before its agent answered: one state, not passed over */
const FRESH: RunState = {
	index: 0,
	skips: [false],
	exact: true,
	touched: 0,
	undecided: false,
};
let runIds = 0;
/** the site pool's clock of changes to the joint session history, across the host's frames */
let siteClock = 0;
/** how long a report waits for the agent of its slot before it is told anyway */
const SITE_ANSWER_MS = 300;
/** when an undecided activation is asked about again (history.ts ACTIVATION_GRACE, and a little) */
const SITE_RECHECK_MS = 450;

/**
 * A proxied frame. Dispatches `navigate` (CustomEvent, `detail` is a
 * NavigateInfo) whenever the page reports a new URL, title or history state.
 */
export class Frame extends EventTarget {
	/** the last report from the page, if any */
	lastNavigate: NavigateInfo | null = null;
	/**
	 * The site pool: the frame's history as runs, each a stretch of it shown
	 * from one slot (a slot's origin, or this page's for a site shown without
	 * the pool), in order. The browser lists a document the entries of its
	 * own origin only, so a run's states (every step of the frame and of the
	 * frames in its page, and which of them Chrome's Back passes over) are
	 * kept by the agent of its slot, which is of that origin
	 * (src/controller/history.ts answerRun), told of every report of the
	 * frame's documents; this page composes them. A step within a run is
	 * the agent's; a step to another run is the browser's own traversal of
	 * the joint session history, by the number of steps between, from the
	 * frame's document (the agent of its slot calls it).
	 */
	#runs: SiteRun[] = [];
	#at = -1;
	/** the step across runs under way: the run the next report from its origin is from */
	#stepping: number | null = null;
	/** the frame's next document is the host's (go): the run it leaves is not the page's navigation */
	#hostNavigation = false;
	/** siteClock when this frame last changed the joint session history */
	#touched = 0;
	/** reports and what they tell the agents, in order */
	#queue: Promise<unknown> = Promise.resolve();
	/** a run closed for the next one, until its agent decided on its last document */
	#leaving: Promise<unknown> = Promise.resolve();
	/** an undecided activation is asked about again (RunState.undecided) */
	#recheck = false;
	/** what the page said of its own slot's run of the history (while its agent does not answer) */
	#own = { back: false, forward: false };
	/** the site pool: the element's allow attribute as the host wrote it, and as slotAllow last made it */
	#hostAllow: string | null = null;
	#slotAllow: string | null = null;
	/**
	 * The site pool: the frame is about to show a slot's document, another
	 * origin than this page's to the browser: what the host's allow
	 * attribute lets a frame of this page's origin have, the slots get too
	 * (slotAllow), as a proxied top has it without a pool
	 */
	#allowSlots() {
		const slots = this.controller.siteOrigins;
		if (!slots.length) return;
		const current = this.element.getAttribute('allow');
		if (current !== this.#slotAllow) this.#hostAllow = current;
		let features: string[] = [];
		try {
			features = (
				document as Document & {
					featurePolicy?: { allowedFeatures(): string[] };
				}
			).featurePolicy!.allowedFeatures();
		} catch (error) {
			// no featurePolicy (not Chrome): what the host's attribute names
		}
		const value = slotAllow(this.#hostAllow, slots, location.origin, features);
		this.#slotAllow = value;
		if (value !== current) this.element.setAttribute('allow', value);
	}
	constructor(
		public controller: StompController,
		public element: HTMLIFrameElement,
		sandbox: string | null = DEFAULT_SANDBOX,
	) {
		super();
		if (sandbox !== null) element.setAttribute('sandbox', sandbox);
		// the site pool in a cross-origin isolated page: the frame's documents
		// are of the slots' origins, which the `cross-origin-isolated`
		// permission reaches only when the frame names them (the default
		// allowlist is this page's origin), so they may be isolated as one of
		// this origin is (the service worker serves every document that is
		// not isolated natively without the permission, src/isolation.ts).
		// Added to what the host allows the frame already
		const slots = controller.siteOrigins;
		if (slots.length && globalThis.crossOriginIsolated === true) {
			const allow = element.getAttribute('allow')?.trim() ?? '';
			if (!/(^|;)\s*cross-origin-isolated(\s|;|$)/.test(allow))
				element.setAttribute(
					'allow',
					`${allow}${allow && !allow.endsWith(';') ? '; ' : allow ? ' ' : ''}cross-origin-isolated 'self' ${slots.join(' ')}`,
				);
		}
		// a document of the frame tells of its first user activation here,
		// at once (the message it would post can come too late)
		Reflect.defineProperty(element, ACTIVATED, {
			value: (token: unknown) =>
				this.controller.siteMode
					? this.siteActivated(String(token), false)
					: noteActivation(this.historyWindow(), String(token)),
			configurable: true,
		});
	}
	/**
	 * @internal the site pool: a top document of the frame reported, from
	 * `origin`, navigated to as `type` says (NAVIGATION_TYPE), where its
	 * slot's stretch of the history has it (`entries`, HISTORY_RUN);
	 * `deliver` reports it once the agent of that origin took it
	 */
	siteReport(
		origin: string,
		info: NavigateInfo,
		type: string | null,
		deliver: () => void,
		entries: [number, number] | null = null,
	) {
		this.#own = {
			back: info.canGoBack === true,
			forward: info.canGoForward === true,
		};
		this.#enqueue(async () => {
			const { run, previous } = this.#place(origin, info, type);
			if (entries) [run.index, run.count] = entries;
			if (previous) prunedRun(previous, type === 'replace');
			if (previous) {
				// the run the frame left for a new one: the entries after its
				// state are gone, and a document that sent the frame on by
				// itself is passed over without a history activation; one
				// that replaced itself took its entry with it (and the run,
				// when that was the run's first)
				const replaced = type === 'replace';
				const decide = !this.#hostNavigation && !replaced;
				this.#leaving = this.#ask(previous, {
					kind: 'leave',
					decide,
					replaced,
				}).then((answer) => {
					const index = this.#runs.indexOf(previous);
					if (replaced && answer && !answer.done && index !== -1) {
						this.#runs.splice(index, 1);
						if (this.#at > index) this.#at--;
						// the runs either side of it are of one origin now, one
						// stretch of entries to the browser: the later one's
						// agent took the earlier one's entries as its first
						// document's (its first look lists them)
						const before = this.#runs[index - 1];
						if (before && before.origin === this.#runs[index]?.origin) {
							this.#runs.splice(index - 1, 1);
							if (this.#at >= index) this.#at--;
						}
					}
					this.#expect();
					this.#changed();
				});
			}
			if (previous || run.state === FRESH) this.#hostNavigation = false;
			this.#expect();
			try {
				// (and how many of the frame's entries are in other runs: its
				// document's history.length counts them)
				await this.#ask(run, {
					kind: 'sync',
					across: entriesAcross(this.#runs, this.#runs.indexOf(run)),
				});
			} finally {
				// (told whatever the agent said: a late answer tells the
				// buttons again)
				deliver();
			}
		});
	}
	/** what every agent was last told of the frame's runs (#expect) */
	#expected = '';
	/**
	 * Tell every agent (and this realm, for a site shown without the pool)
	 * where the frame is in its runs: the frame's next document, of any of
	 * their origins, counts the other slots' entries from its first script
	 * (history.ts expectRuns)
	 */
	#expect() {
		const op = runsExpectation(this.#runs, this.#at);
		const key = JSON.stringify(op);
		if (!op || key === this.#expected) return;
		this.#expected = key;
		const index = this.#index();
		const win = window[index] as Window | undefined;
		if (!win) return;
		answerRun(win, 0, op, helperNames(this.controller.config).client).catch(
			() => {},
		);
		this.controller.siteTell(index, op);
	}
	/** which run a report from `origin` is of: a step under way, the current run, the one before or after it (the page's own step past its run), else a new one after the current */
	#place(
		origin: string,
		info: NavigateInfo,
		type: string | null,
	): { run: SiteRun; previous: SiteRun | null } {
		const runs = this.#runs;
		const current = runs[this.#at];
		const step = this.#stepping;
		// a run whose slot is left out since is shown from this page's
		// origin: a report from here of a step to it is that run's, which
		// this realm answers from now on (its agent and its states are gone)
		const of = (run: SiteRun | undefined): run is SiteRun => {
			if (!run) return false;
			if (run.origin === origin) return true;
			if (origin !== location.origin) return false;
			run.origin = origin;
			run.state = FRESH;
			run.known = false;
			return true;
		};
		if (step !== null && of(runs[step])) {
			this.#stepping = null;
			this.#at = step;
			runs[step].url = info.url;
			return { run: runs[step], previous: null };
		}
		// (a step to another origin stays under way through a late report of
		// the document it leaves)
		if (current?.origin === origin) {
			current.url = info.url;
			return { run: current, previous: null };
		}
		this.#stepping = null;
		// (a traversal is one, whatever URL the run had last)
		for (const offset of [-1, 1]) {
			const run = runs[this.#at + offset];
			if (
				(run?.origin === origin ||
					(origin === location.origin && run?.url === info.url)) &&
				(run.url === info.url || type === 'traverse') &&
				of(run)
			) {
				this.#at += offset;
				run.url = info.url;
				return { run, previous: null };
			}
		}
		runs.splice(this.#at + 1);
		const run: SiteRun = {
			id: ++runIds,
			origin,
			url: info.url,
			state: FRESH,
			known: false,
			at: ++siteClock,
			count: 1,
			index: 0,
		};
		this.#touched = run.at;
		runs.push(run);
		this.#at = runs.length - 1;
		return { run, previous: current ?? null };
	}
	#enqueue(task: () => Promise<unknown>) {
		this.#queue = this.#queue.then(task).catch(() => {});
	}
	/** ask the agent of the run's origin; `wait`: give up after SITE_ANSWER_MS (a step waits for its commit) */
	async #ask(
		run: SiteRun,
		op: SiteHistoryOp,
		wait = true,
	): Promise<SiteHistoryAnswer | null> {
		const asked = Promise.resolve()
			.then(() =>
				this.controller.siteHistory(run.origin, this.#index(), run.id, op),
			)
			.catch(() => null)
			.then((answer) => {
				if (answer?.state) this.#update(run, answer.state);
				return answer;
			});
		if (!wait) return asked;
		let late = false;
		const answer = await Promise.race([
			asked,
			new Promise<null>((resolve) =>
				setTimeout(() => {
					late = true;
					resolve(null);
				}, SITE_ANSWER_MS),
			),
		]);
		// an agent slower than that (a slot's first start) is heard when it
		// answers, and the buttons follow
		if (late) asked.then(() => this.#changed());
		return answer;
	}
	#update(run: SiteRun, state: RunState) {
		if (run.known && state.touched !== run.state.touched)
			this.#touched = ++siteClock;
		run.state = state;
		run.known = true;
		// a document's activation is still awaited: ask again once it is not
		if (state.undecided && !this.#recheck) {
			this.#recheck = true;
			setTimeout(() => {
				this.#recheck = false;
				this.#enqueue(async () => {
					const current = this.#runs[this.#at];
					if (!current) return;
					await this.#ask(current, { kind: 'sync' });
					this.#changed();
				});
			}, SITE_RECHECK_MS);
		}
	}
	/** the buttons may have changed with no report of the frame's: tell the host when they did */
	#changed() {
		// (the same document: a step or go() under way still waits for the
		// next one's report)
		const info = this.historyChanged(false);
		if (info) this.controller.frameNavigated(info, this);
	}
	/** @internal the site pool: a document in a frame of the page (`source`) reported that its history moved */
	siteNested(source: Window, entry: ReportedEntry | null) {
		const top = this.element.contentWindow;
		const path = top && framePath(top, source);
		if (!path) return;
		this.#enqueue(async () => {
			const run = this.#runs[this.#at];
			if (!run) return;
			await this.#ask(run, { kind: 'nested', path, entry });
			this.#changed();
		});
	}
	/** @internal the site pool: a document of the frame (or of a frame in its page, `nested`) reported its first user activation */
	siteActivated(token: string, nested: boolean) {
		this.#enqueue(async () => {
			const run = this.#runs[this.#at];
			if (run) await this.#ask(run, { kind: 'activated', token, nested });
		});
	}
	/** the site pool: this frame's index in the page's `frames`, which the agents count too */
	#index(): number {
		const win = this.element.contentWindow;
		for (let i = 0; i < window.length; i++) if (window[i] === win) return i;
		return -1;
	}
	/** the site pool: the state of the frame's history Back or Forward goes to (the nearest one Chrome's would not pass over), null when there is none */
	#target(direction: Direction): { run: number; state: number } | null {
		const runs = this.#runs;
		const delta = direction === 'back' ? -1 : 1;
		let run = this.#at;
		let state = (runs[run]?.state.index ?? 0) + delta;
		while (run >= 0 && run < runs.length) {
			const skips = runs[run].state.skips;
			for (; state >= 0 && state < skips.length; state += delta)
				if (!skips[state]) return { run, state };
			run += delta;
			state = delta < 0 ? (runs[run]?.state.skips.length ?? 0) - 1 : 0;
		}
		return null;
	}
	/** the site pool: how many steps of the joint session history the state is from the frame's first */
	#position(run: number, state: number): number {
		let position = state;
		for (let i = 0; i < run; i++) position += this.#runs[i].state.skips.length;
		return position;
	}
	/** the site pool: whether another frame of the host changed the joint session history since `at` */
	#crossed(at: number): boolean {
		return this.controller.frames.some(
			(frame) => frame !== this && frame.#touched > at,
		);
	}
	/** the site pool: step the frame's history, within its run through the agent of its slot, else to another run */
	async #siteStep(direction: Direction): Promise<boolean> {
		await this.#queue;
		await this.#leaving;
		const current = this.#runs[this.#at];
		if (!current) return false;
		let target = this.#target(direction);
		// within the run (or the agent never answered, and may still have
		// somewhere to go): the agent's, whose answer has the run's state
		// as it is now; a step it does not take may be one to another run
		if (!target || target.run === this.#at) {
			if (target === null && current.known) return false;
			if ((await this.#ask(current, { kind: direction }, false))?.done)
				return true;
			target = this.#target(direction);
			if (!target || target.run === this.#at) return false;
		}
		const to = this.#runs[target.run];
		const from = Math.min(target.run, this.#at);
		const between = this.#runs.slice(from, Math.max(target.run, this.#at) + 1);
		const reported = this.#nextReport();
		this.#stepping = target.run;
		this.#allowSlots();
		// the browser's own traversal, from the frame's document, when every
		// step between is one of the joint history's and no other frame
		// changed it since (Back would then move that frame, and Forward
		// finds the entries gone)
		if (
			between.every((run) => run.known && run.state.exact) &&
			!this.#crossed(this.#runs[from].at)
		) {
			const delta =
				this.#position(target.run, target.state) -
				this.#position(this.#at, current.state.index);
			const answer = await this.#ask(current, { kind: 'go', delta }, false);
			if (answer?.done) {
				this.#touched = ++siteClock;
				await reported;
				return true;
			}
		}
		// else a navigation that replaces: the frame's history keeps its
		// length, as a traversal would
		const win = this.element.contentWindow;
		if (!win) {
			this.#stepping = null;
			return false;
		}
		// (the run's agent takes the next document for the state, at the
		// address it had)
		const arrive = await this.#ask(to, { kind: 'arrive', state: target.state });
		let url = arrive?.url;
		if (!url?.startsWith(`${to.origin}/`)) {
			const routed = new URL(await this.controller.route(to.url));
			const origin = (await this.controller.siteOrigin(to.url)) ?? to.origin;
			url = `${origin}${routed.pathname}${routed.search}${routed.hash}`;
		}
		this.#touched = ++siteClock;
		win.location.replace(url);
		await reported;
		const landed = new URL(url).origin;
		if (landed !== location.origin) this.#bounced(landed);
		return true;
	}
	/** @internal */
	report(info: NavigateInfo, settles = true) {
		// a document out of this realm's reach (./apart.ts): what its history
		// can do is the agent's to say, asked now and told when it differs
		const apart = this.apartPath();
		if (!apart) this.#apartHistory = null;
		// where the frame's history can go is the frame's, nested frames
		// included, not what the page's own navigable says
		const canGoBack = this.canGoBack;
		const canGoForward = this.canGoForward;
		if (canGoBack !== null) info.canGoBack = canGoBack;
		if (canGoForward !== null) info.canGoForward = canGoForward;
		this.lastNavigate = info;
		if (settles) {
			for (const resolve of this.#awaitingReport) resolve();
			this.#awaitingReport.clear();
		}
		this.dispatchEvent(new CustomEvent('navigate', { detail: info }));
		if (apart && !this.#askingApart) void this.apartChanged(apart);
	}
	/**
	 * @internal The frame's path from the controller's window when its
	 * document is out of this realm's reach though of its origin (a
	 * Document-Isolation-Policy of the proxy's: ./apart.ts), else null
	 */
	apartPath(): number[] | null {
		if (this.controller.siteMode || !this.#reportedApart) return null;
		const win = this.element.contentWindow;
		return win && outOfReach(win) ? framePath(window, win) : null;
	}
	/** the frame's last report came from a document out of this realm's reach (an error page, which is too, never reports) */
	#reportedApart = false;
	/** @internal the window the frame's document reported from */
	reportedFrom(source: Window | null) {
		this.#reportedApart = !!source && outOfReach(source);
	}
	/** what the agent last said of the history of the frame's document out of reach */
	#apartHistory: { back: boolean | null; forward: boolean | null } | null =
		null;
	#askingApart = false;
	/**
	 * @internal ask the agent what the history of the frame's document out of
	 * reach can do, and tell the host when that changed
	 */
	async apartChanged(path = this.apartPath()): Promise<void> {
		if (!path) return;
		const info = await this.controller.apartInfo(path);
		if (!info) return;
		this.#apartHistory = { back: info.canGoBack, forward: info.canGoForward };
		this.#askingApart = true;
		try {
			const changed = this.historyChanged(false);
			if (changed) this.controller.frameNavigated(changed, this);
		} finally {
			this.#askingApart = false;
		}
	}
	/** @internal the frame's window, its history told how to read its documents */
	historyWindow(): Window | null {
		const win = this.element.contentWindow;
		const name = helperNames(this.controller.config).client;
		if (win)
			bindHistory(
				win,
				(target) => clientView(target, name),
				earlierWindows(win, name),
			);
		return win;
	}
	/**
	 * @internal A document in a frame of the page reported: the last report
	 * again, with the history state it changed, or null when it did not
	 */
	historyChanged(settles = true): NavigateInfo | null {
		const last = this.lastNavigate;
		if (!last) return null;
		if (
			this.canGoBack === last.canGoBack &&
			this.canGoForward === last.canGoForward
		)
			return null;
		const info = { ...last };
		this.report(info, settles);
		return info;
	}
	/** hosts waiting for the next report (go, reload) */
	#awaitingReport = new Set<() => void>();
	/** resolves on the next report, REPORT_GRACE_MS after the frame's load event without one, or after NAVIGATION_WAIT_MS */
	#nextReport(): Promise<void> {
		return new Promise((resolve) => {
			let grace: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				clearTimeout(timer);
				clearTimeout(grace);
				this.#awaitingReport.delete(done);
				this.element.removeEventListener('load', onLoad);
				resolve();
			};
			// the report crosses message ports and usually lands a few
			// milliseconds after the frame's load event; a document that never
			// reports (an image, a download, a blocked response) resolves
			// REPORT_GRACE_MS after that event
			const onLoad = () => {
				if (grace === undefined) grace = setTimeout(done, REPORT_GRACE_MS);
			};
			const timer = setTimeout(done, NAVIGATION_WAIT_MS);
			this.element.addEventListener('load', onLoad);
			this.#awaitingReport.add(done);
		});
	}
	/** the last title the page reported, else the document's */
	get title(): string | null {
		if (this.lastNavigate) return this.lastNavigate.title;
		try {
			return this.element.contentDocument?.title ?? null;
		} catch {
			return null;
		}
	}
	/**
	 * Navigate the frame. Resolves when the new document first reports (url,
	 * title, history state), REPORT_GRACE_MS after the frame's load event when
	 * the document is one that never reports, NAVIGATION_WAIT_MS at the most.
	 * Listen for the frame's `load` before calling when you need that event.
	 */
	async go(url: string): Promise<void> {
		this.controller.reportViewport(
			this.element.clientWidth,
			this.element.clientHeight,
		);
		let routed = await this.controller.route(url);
		// the site pool: the route on the origin of the URL's site, whose
		// worker is up by now
		const origin = await this.controller.siteOrigin(url);
		if (origin) {
			const path = new URL(routed);
			routed = `${origin}${path.pathname}${path.search}${path.hash}`;
			await this.controller.siteViewport(
				origin,
				this.element.clientWidth,
				this.element.clientHeight,
			);
		}
		// In a cross-origin isolated page a frame navigated as it is inserted
		// keeps its initial document's window, and with it that document's
		// 5 microsecond clock, whatever the new document is (measured): the
		// frame is navigated once it is in the document (or, one that is not
		// put there within CONNECTED_LIMIT_MS, as it was asked to be)
		if (globalThis.crossOriginIsolated === true) await connected(this.element);
		// where the frame is, for its first document's first script
		await this.controller.measureGeometry();
		// waited for from here: until the frame is navigated nothing of the
		// wait holds it, and the load of the about:blank its insertion made
		// is not taken for the new document's
		const reported = this.#nextReport();
		noteBrowserNavigation(this.historyWindow());
		// (the document it leaves may be out of this realm's reach: ./apart.ts)
		const apart = this.apartPath();
		if (apart) await this.controller.apartCommand(apart, 'typed');
		if (origin) this.#allowSlots();
		// the site pool: the run that shows the URL's origin takes the next
		// document for the host's, else the next run starts with it
		const run = this.#runs[this.#at];
		if (this.controller.siteMode) {
			if (run && run.origin === (origin ?? location.origin))
				await this.#ask(run, { kind: 'typed' });
			else this.#hostNavigation = true;
		}
		const before = this.element.contentDocument;
		this.element.src = routed;
		await this.#arrival(routed, reported, before);
		if (origin) this.#bounced(origin);
	}
	/**
	 * Wait for the navigation the frame was just sent on (`reported`), and
	 * send it once more when a newer service worker takes over before the
	 * frame shows anything of it. Chrome stops the old worker then, and a
	 * navigation that worker was handed in that moment is never answered,
	 * nor sent to the network or the new worker: the frame kept its old
	 * document for good (measured, the first visit after a deploy). Sent
	 * again, it waits for the new worker, whose revive window holds it until
	 * this controller has shaken hands with it.
	 */
	async #arrival(
		routed: string,
		reported: Promise<void>,
		before: Document | null,
	): Promise<void> {
		await arrival(
			this.element,
			routed,
			reported,
			(listener) => this.controller.onHandover(listener),
			() => this.#nextReport(),
			before,
		);
	}
	/**
	 * The site pool: a navigation sent to the slot `origin` reported from
	 * this page's origin, which the slot's worker does when its agent is
	 * gone; the hub leaves that slot out from now on
	 */
	#bounced(origin: string) {
		if (this.#runs[this.#at]?.origin === location.origin)
			this.controller.siteLeftOut(origin);
	}
	/**
	 * Step the frame's history as a tab's Back and Forward do: its own
	 * entries and those of the frames in it, never the page that embeds the
	 * frame or another frame of that page (src/controller/history.ts).
	 * Resolves false when there is no entry in that direction, so a host can
	 * show its own "nothing to go back to" state.
	 */
	async back(): Promise<boolean> {
		if (this.controller.siteMode) return this.#siteStep('back');
		return this.#step('back');
	}
	async forward(): Promise<boolean> {
		if (this.controller.siteMode) return this.#siteStep('forward');
		return this.#step('forward');
	}
	async #step(direction: Direction): Promise<boolean> {
		// a document out of this realm's reach is stepped by the agent
		const apart = this.apartPath();
		if (apart)
			return (await this.controller.apartCommand(apart, direction)) === true;
		const win = this.historyWindow();
		return win ? traverse(win, direction) : false;
	}
	/** whether the frame's history (nested frames included) has an entry before/after the current one; null when the browser cannot tell */
	get canGoBack(): boolean | null {
		if (this.controller.siteMode)
			return (
				this.#target('back') !== null ||
				(!this.#runs[this.#at]?.known && this.#own.back)
			);
		// (a document out of reach: what the agent said, else the page's)
		if (this.apartPath()) return this.#apartHistory?.back ?? null;
		return canTraverse(this.historyWindow(), 'back');
	}
	get canGoForward(): boolean | null {
		if (this.controller.siteMode)
			return (
				this.#target('forward') !== null ||
				(!this.#runs[this.#at]?.known && this.#own.forward)
			);
		if (this.apartPath()) return this.#apartHistory?.forward ?? null;
		return canTraverse(this.historyWindow(), 'forward');
	}
	/** reload the frame; resolves when the reloaded document first reports (false when there was no document to reload) */
	async reload(): Promise<boolean> {
		const win = this.element.contentWindow;
		if (!win) return false;
		const run = this.#runs[this.#at];
		if (this.controller.siteMode && run) {
			// another origin's location cannot be reloaded from here: its agent can
			const reported = this.#nextReport();
			const answer = await this.#ask(run, { kind: 'reload' }, false);
			if (answer === null && run.origin !== location.origin) {
				// the slot is left out since (its agent is gone): the document
				// again, from this page's origin
				const url = this.lastNavigate?.url;
				if (!url) return false;
				const routed = new URL(await this.controller.route(url));
				const to = (await this.controller.siteOrigin(url)) ?? location.origin;
				win.location.replace(
					`${to}${routed.pathname}${routed.search}${routed.hash}`,
				);
			} else if (!answer?.done) return false;
			await reported;
			return true;
		}
		const reported = this.#nextReport();
		// a document out of this realm's reach: its location reloads only
		// from its own cluster
		const apart = this.apartPath();
		if (apart) {
			if ((await this.controller.apartCommand(apart, 'reload')) !== true)
				return false;
		} else {
			noteBrowserNavigation(this.historyWindow());
			win.location.reload();
		}
		await reported;
		return true;
	}
	/** the URL the frame is currently showing, if it is a proxied page */
	get url(): string | null {
		// the site pool: the page is of another origin, and says where it is
		if (this.controller.siteMode) return this.lastNavigate?.url ?? null;
		// proxied pages are same-origin; their inject client exposes the real location
		try {
			const win = this.element.contentWindow as
				(Window & Record<string, { url?: { toString(): string } }>) | null;
			return (
				win?.[helperNames(this.controller.config).client]?.url?.toString() ??
				null
			);
		} catch {
			// a document out of this realm's reach (./apart.ts) says where it
			// is in its reports
			return this.apartPath() ? (this.lastNavigate?.url ?? null) : null;
		}
	}
}

export default StompController;
