import type {
	AdblockApplied,
	AdblockList,
	AdblockOptions,
	SiteShields,
} from '../blocker/types';
import type { Assets, Config, ConfigCodec, HostGeometry } from '../config';
import type { HelperNames } from '../helperNames';
import type { HookErrorInfo, InitHooks } from '../hooks';
import type {
	PasskeyCommand,
	PasskeyInfo,
	PasskeyPrompt,
	PasskeysConfig,
} from '../passkeys/types';
import type { Http3DescriptorOptions } from '../transport/construct';
import type {
	CookieCommand,
	CookieResult,
	HostReload,
	IdentityChooserRequest,
	PermissionRequestInfo,
	RequestInfo,
	RequestRule,
} from '../transport/messages';
import type { ShardsOption } from '../transport/ShardedTransport';
import type { TransportNote } from '../transport/transportLog';
import type {
	CarrierInfo,
	WispWebTransportOptions,
} from '../transport/wispWebTransport';
import type { SiteHistoryAnswer, SiteHistoryOp } from './history';
import type { SitePoolInit } from './sitePool';

/**
 * A transport described rather than constructed: what `StompController` hosts
 * in its transport worker, and what crosses the host/controller-frame
 * boundary (the frame instantiates it on the proxy origin).
 */
export interface TransportDescriptor {
	/** ES module URL (on the proxy origin, for the controller frame) whose default export is a ProxyTransport class */
	module: string;
	/** constructor arguments */
	options?: unknown[];
	/**
	 * Where the controller runs it: `worker` (default) starts it in a dedicated
	 * Worker (`transportWorker.js`), off the host page's thread, so a proxied
	 * frame's synchronous XHR no longer deadlocks on the network; `page`
	 * imports and constructs it in the controller's own page, as a
	 * ProxyTransport instance would be.
	 */
	host?: 'worker' | 'page';
	/**
	 * HTTP/3 over QUIC for origins that offer it (Alt-Svc, an HTTPS record
	 * when `dns` is set, or `force`), over the transport's wisp UDP streams;
	 * off unless set. `true` takes the defaults. Needs a transport with
	 * `client.connect_udp` (epoxy) and a wisp server that relays UDP; without
	 * either, every request goes over the transport as before. docs/http3.md.
	 */
	http3?: boolean | Http3DescriptorOptions;
	/**
	 * Wisp over the relay's WebTransport session (holyWisp's WebTransport
	 * listener) instead of its WebSocket, when the relay offers one (a wss:
	 * wisp URL dialed as https:, or what `/webtransport.json` on its origin
	 * names) and it is up in time (`timeoutMs`); the WebSocket otherwise (UDP
	 * blocked, no listener, a certificate that does not match), which a
	 * relay not met before has opened beside the session. Off unless set; epoxy only (it
	 * takes the session as its wisp transport). The controller's `carrier`
	 * says which. docs/webtransport.md.
	 */
	webTransport?: boolean | WispWebTransportOptions;
	/**
	 * How many threads the transport's TLS may run on (`host: 'worker'`,
	 * epoxy with a `wisp` URL). The transport worker runs the module itself,
	 * and starts more instances in workers of its own only when it cannot
	 * keep up with downloads from more servers than it has threads, each
	 * origin's connections on one of them, over the one wisp connection;
	 * while a worker runs, the transport worker takes no new origin (every
	 * worker's bodies go through it), and a worker that carried nothing for
	 * 30 s closes. A number is the most threads, the transport worker's
	 * counted (1: the transport worker alone, as before); `{ max, start }`
	 * says how many run from the start too. Default: workers for half the
	 * cores the browser reports, at most 4, beside the transport worker's
	 * own thread; none from the start.
	 */
	shards?: ShardsOption;
}

export interface ControllerFrameInit {
	codec?: ConfigCodec;
	/** the scope (RemoteControllerInit.directory); the controller's address is this plus `id` */
	directory: string;
	/** the controller's id, minted or checked by the host-side RemoteController */
	id: string;
	transport: TransportDescriptor;
	/** the host handles `window.open` / `_blank` (RemoteControllerInit.onOpen) */
	openTab?: boolean;
	/** HTTP cache in the service worker, off when false (RemoteControllerInit.cache) */
	cache?: boolean;
	/** the host page was reloaded, and how (hostReload.ts) */
	hostReload?: HostReload;
	/** the host wants a RequestInfo per request (RemoteControllerInit.onRequest) */
	requestLog?: boolean;
	/** the transport's verbose mode, as the host's origin asked for it (RemoteControllerInit.debugTransport) */
	debugTransport?: boolean;
	/** the host asks the user about a site's permission (RemoteControllerInit.onPermissionRequest) */
	permissionPrompt?: boolean;
	/** the host asks the user about passkeys for proxied sites (RemoteControllerInit.passkeys): what pages are told of them */
	passkeys?: PasskeysConfig;
	/** FedCM requests end without Chrome's delays (RemoteControllerInit.fedcmTesting) */
	fedcmTesting?: boolean;
	/** unparseable scripts fail instead of running raw (RemoteControllerInit.allowInvalidJs) */
	allowInvalidJs?: boolean;
	/** the window membrane off when false (RemoteControllerInit.membrane) */
	membrane?: boolean;
	/** emulated service workers off when false (RemoteControllerInit.serviceWorkers) */
	serviceWorkers?: boolean;
	/** @internal RemoteControllerInit.serviceWorkerTimeout */
	serviceWorkerTimeout?: number;
	/** @internal RemoteControllerInit.serviceWorkerEventDelay */
	serviceWorkerEventDelay?: number;
	/** how many rewrite workers the controller starts (RemoteControllerInit.rewriteWorkers) */
	rewriteWorkers?: number;
	/** ms the service worker waits on a rewrite worker (RemoteControllerInit.rewriteTimeout) */
	rewriteTimeout?: number;
	/** request rules (RemoteControllerInit.rules) */
	rules?: RequestRule[];
	/** the served file names (RemoteControllerInit.assets) */
	assets?: Assets;
	/** the deployment's helper names (RemoteControllerInit.names) */
	names?: Partial<HelperNames>;
	/** host code for every proxied realm (RemoteControllerInit.hooks), resolved by the controller frame */
	hooks?: InitHooks;
	/** the host's error page, a path on the proxy origin (RemoteControllerInit.errorPage) */
	errorPage?: string;
	/** the built-in blocker (RemoteControllerInit.adblock) */
	adblock?: boolean | AdblockOptions;
	/** filter lists to start the blocker with in place of the defaults (RemoteControllerInit.adblockLists) */
	adblockLists?: (string | AdblockList)[];
	/** the site pool, the controller frame its hub (RemoteControllerInit.sitePool) */
	sitePool?: SitePoolInit | false;
}

/**
 * a frame of the host addressed by its index in the host window's `frames`
 * list, with the slot of the site pool its document last reported from
 * (the agent of that origin reads and steps it)
 */
export type FrameAddress = number | { index: number; origin?: string };

export interface FrameInfo {
	url: string | null;
	title: string | null;
	/** whether the frame's own history has an entry before/after the current one; null when the browser cannot tell */
	canGoBack: boolean | null;
	canGoForward: boolean | null;
}

/** `typed`: the frame's next document comes from the host (see noteBrowserNavigation) */
export type FrameCommand = 'back' | 'forward' | 'reload' | 'typed';

/** rpc id on the host <-> controller-frame postMessage channel */
export const REMOTE_RPC = 'stomp-remote';

/**
 * The `name` of the error RemoteController.wait() rejects with when the
 * browser keeps the controller frame from storage, so it cannot register the
 * service worker: the proxy origin is another site than the host, and the
 * browser blocks third-party cookies (Brave and incognito windows by default,
 * a setting in Chrome). RPC errors carry only a message, so the
 * frame's message starts with it.
 */
export const STORAGE_BLOCKED = 'StorageBlockedError';

/** implemented by the controller frame, called by the host */
export type FrameBound = {
	init: [
		ControllerFrameInit,
		{
			config: Config;
			stale: StaleInfo | null;
			/** the inner controller's `carrier`, as it is when it is ready */
			carrier?: CarrierInfo | null;
			/** the site pool's slots, whose documents report too (none without a pool) */
			sites?: string[];
		},
	];
	route: [string, string];
	/** the slot of the site pool a URL's site is shown from, once it is up; null: the proxy origin */
	siteOrigin: [string, string | null];
	/**
	 * the size of a host frame about to navigate (StompController.reportViewport),
	 * to the slot's worker when a third element names the slot it goes to
	 * (StompController.siteViewport)
	 */
	viewport: [[number, number] | [number, number, string], null];
	/** the real URL a routed one stands for, null for a non-route (see StompController.unroute) */
	unroute: [string, string | null];
	/** a search engine's completions (StompController.suggest), without the signal, which stays with the host */
	suggest: [
		{ text: string; engine?: string; endpoint?: string; limit?: number },
		string[],
	];
	setTransport: [TransportDescriptor];
	/** frames are addressed by their index in the host window's `frames` list */
	frameInfo: [FrameAddress, FrameInfo];
	/** the host's browser window as its frames' documents see it (HOST_GEOMETRY, ./geometry.ts) */
	geometry: [HostGeometry, null];
	frameActivated: [
		{ index: number; token: string; nested: boolean; origin?: string },
		null,
	];
	/**
	 * the site pool: an op on run `run` of the frame's history, for the
	 * agent of the slot `origin` (or the controller frame, for its own
	 * origin) to answer (history.ts answerRun, RemoteFrame's SiteRuns)
	 */
	frameHistory: [
		{ index: number; origin: string; run: number; op: SiteHistoryOp },
		SiteHistoryAnswer | null,
	];
	/** resolves to whether the command was carried out (false: nothing to go back/forward to) */
	frameCommand: [
		{
			index: number;
			command: FrameCommand;
			origin?: string;
			/** `typed`: the route the host navigates the frame to next */
			routed?: string;
		},
		boolean,
	];
	clearCache: [];
	cookies: [CookieCommand, CookieResult];
	/** clear a site's virtualized storage (the "Forget me on close" shield) */
	forgetStorage: [string];
	/** the service worker's passkeys, for the host (RemoteController.passkeys) */
	passkeys: [PasskeyCommand, PasskeyInfo[] | boolean | null];
	/** replace the request rules */
	rules: [RequestRule[]];
	/** replace the per-site shields (forwarded to the inner controller) */
	shields: [SiteShields[]];
	/** replace the blocker's filter lists at runtime (StompController.setAdblockLists) */
	adblock: [{ lists: (string | AdblockList)[] }, AdblockApplied];
	/** re-fetch and recompile the blocker's current lists (StompController.refreshAdblockLists) */
	adblockRefresh: [undefined, AdblockApplied];
	/** which of these service worker clients no longer exist (the host's ClientFrames) */
	goneClients: [string[], string[]];
};

/** the two builds in a mismatch, as the host sees them on `controller.stale` */
export interface StaleInfo {
	controller: string;
	worker: string;
}

/** implemented by the host, called by the controller frame */
export type HostBound = {
	ready: [];
	/** a proxied request completed (only when the host asked for the log) */
	request: [RequestInfo];
	/** the inner controller's `stale` changed: the builds, or null once they agree again */
	stale: [StaleInfo | null];
	/** the inner controller's transport chose its carrier (StompController.carrier) */
	carrier: [CarrierInfo];
	/** a note of the inner controller's transport, for the host's console (transportLog.ts) */
	transportNote: [TransportNote];
	/** a host hook threw in a proxied realm, or a hook URL could not be fetched */
	hookError: [HookErrorInfo];
	/** the document `client` is a page isolated natively shown without isolation (NavigateInfo.isolation) */
	isolationWanted: [string];
	/** a site asks for a permission the proxy origin holds for another (see StompController.onPermissionRequest) */
	permission: [PermissionRequestInfo, boolean | null];
	/**
	 * a proxied site's WebAuthn ceremony, checked by the service worker, for
	 * the user to confirm: the host's answer or null; the port hears
	 * PASSKEY_CANCEL when the page gives up (RemoteControllerInit.passkeys)
	 */
	passkeyPrompt: [{ request: PasskeyPrompt; port: MessagePort }, unknown];
	/** the site pool: whether the focus is in the frame that shows the document `client` (a ceremony's focus check) */
	passkeyFocused: [string, boolean];
	/**
	 * a proxied site's FedCM account chooser, drawn by the host's page over
	 * the document's frame: the index picked, IDENTITY_CLOSED or
	 * IDENTITY_GONE; the port closes when the document goes away, and a
	 * message on it says the request ended (its signal aborted)
	 */
	identityChooser: [
		{ request: IdentityChooserRequest; port: MessagePort },
		number,
	];
};
