import type {
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import type { AdblockInit } from '../blocker/types';
import type { Config } from '../config';
import type { PortBody } from './bodyPort';
import type { Http3DescriptorOptions } from './construct';

// postMessage keys (controller <-> service worker <-> proxied contexts)

/**
 * controller -> SW, with [port] or [port, transportPort]: register a
 * controller at `directory` (its address, the scope plus its id); the
 * transport is served on the second port when the controller's transport
 * worker hosts it, else on the rpc port itself
 */
export const CONTROLLER_INIT = '$stomp$controllerInit';
/** proxied page -> SW, with [port]: ask the controller at `directory` (the page's address) to serve a transport on this port */
export const INIT_REMOTE_TRANSPORT = '$stomp$initRemoteTransport';
/** SW -> every client: SW (re)started, controllers must re-send CONTROLLER_INIT */
export const SW_REVIVE = '$stomp$swRevive';
/**
 * @internal page -> SW: re-point the client the worker checks a controller
 * against before serving a document at its address (the suites stand in
 * for a host tab in the back/forward cache with it; nothing else sends it)
 */
/**
 * controller -> SW: the controller's tab is going away (a `pagehide` that is
 * not into the back/forward cache), so the worker forgets the controller now;
 * Chrome does not fire the port's `close` event for a document that is gone.
 * Honoured only from the client that registered the controller.
 */
export const CONTROLLER_CLOSE = '$stomp$controllerClose';
export interface ControllerCloseMessage {
	/** the controller's address */
	directory: string;
}
export const CONTROLLER_CLIENT = '$stomp$controllerClient';
export interface ControllerClientMessage {
	/** the controller's address */
	directory: string;
	/** the service worker client id to check from now on; the sender's own when omitted */
	client?: string;
}
/** a page tells the worker it aborted a request (the id it sent in ABORT_HEADER) */
export const ABORT_REQUEST = '$stomp$abort';
/** the request header a page adds so the worker can match an abort to the request; never forwarded */
export const ABORT_HEADER = 'x-stomp-abort';
/**
 * On a request the inject makes for a page's load (the copy of an element's
 * or a stylesheet's subresource in a document no service worker controls):
 * the token of a grant the inject announced for exactly this request on its
 * client's load channel (LOAD_CHANNEL). The worker takes the grant once,
 * judges the request as the load the grant names and strips the header; a
 * value that names no grant of the requesting client for this URL changes
 * nothing, and the request is the page's own
 */
export const LOAD_HEADER = 'x-stomp-load';
/**
 * proxied page -> SW, with [port]: the channel on which this client's inject
 * announces the loads it is about to copy (src/server/loadGrants.ts), opened
 * before any of the page's script runs; the worker takes one per client
 */
export const LOAD_CHANNEL = '$stomp$loadChannel';
export interface LoadChannelMessage {
	/** the sender's controller address */
	directory: string;
	/** the nonce the worker challenged this client with (SW_REVIVE's `load`), when it did */
	answer?: string;
}
/**
 * On that channel: one load the client is about to request. `load` is
 * `<destination> <mode>`, the Sec-Fetch-Dest and Sec-Fetch-Mode of the load
 * the request stands for (subresource values only, never a navigation's
 * but an object's or embed's), or `copy` (a load the worker takes no
 * metadata from) or `download`
 */
export interface LoadGrantMessage {
	/** 22 random characters of base64url: the LOAD_HEADER of the request */
	token: string;
	/** the routed URL the request will ask for */
	url: string;
	load: string;
}
/**
 * On the answer to a granted load whose response the page may not read (a
 * no-cors load of another origin, or one that came through another origin):
 * the inject keeps its copy where no realm of the page can fetch it. Only
 * a granted request's answer carries it, and no page reads that answer
 */
export const OPAQUE_COPY_HEADER = 'x-stomp-copy';
/**
 * The worker that makes a sealed copy's URL (src/inject/dom/sealedCopies.ts):
 * its script, made a blob: URL by the inject, and the route under the
 * controller's address where the service worker answers the same script
 * for a document whose policy refuses a blob: worker (the blocker's
 * `$csp=`, which names that route among its worker sources)
 */
export const SEALER_SOURCE =
	'onmessage=function(e){postMessage([e.data[0],URL.createObjectURL(e.data[1])])}';
export const SEALER_ROUTE = 'sealer';
/**
 * A Server-Timing metric the worker adds to a response of another origin
 * whose Timing-Allow-Origin lets the page see its timing: every route is
 * same-origin to the browser, so only the worker knows. The inject's
 * resource timing reads it and never shows it (ResourceTiming module)
 */
export const TAO_MARKER = 'stomp-tao';
/**
 * A Server-Timing metric the worker adds to a load (an image, a video) its
 * page's emulated service worker answered with an opaque response: the URL
 * is the page's own, the data another origin's, so a canvas that draws it is
 * tainted (CanvasTaint reads it; the page never sees it)
 */
export const OPAQUE_MARKER = 'stomp-opaque';
/**
 * A Server-Timing metric the worker adds to a cors response of another
 * origin whose own Server-Timing the browser needs for resource timing (its
 * Timing-Allow-Origin names the page) but the page may not read as a
 * header (no Access-Control-Expose-Headers names it): the inject shows the
 * response without the header
 */
export const TIMING_ONLY_MARKER = 'stomp-timing-only';
/**
 * A Server-Timing metric the worker adds to the answer of an
 * XMLHttpRequest: the inject makes it with fetch(), so the browser names
 * its resource timing entry's initiator `fetch`; the page reads
 * `xmlhttprequest`
 */
export const XHR_MARKER = 'stomp-xhr';
/**
 * How the worker answered a load, as resource timing tells them apart
 * natively (measured in Chrome 152 and 156; `transferSize`, `deliveryType`,
 * `nextHopProtocol`):
 *  - `network`: the body and 300 bytes, "", the protocol
 *  - `memory`: the renderer's memory cache (the worker's MemoryCache, and a
 *    document asking again for what it was just given): 0, "cache", the
 *    protocol the resource came over
 *  - `cache`: the HTTP cache, fresh: 0, "cache", ""
 *  - `memory-revalidated`: a resource the renderer has, confirmed by the
 *    origin with a 304: 300, "", the protocol
 *  - `revalidated`: an HTTP cache entry confirmed with a 304: 300, "cache", ""
 */
export type Delivery =
	'network' | 'memory' | 'cache' | 'memory-revalidated' | 'revalidated';
/**
 * A Server-Timing metric the worker adds to an answer it gave from a cache
 * of its own (the HTTP cache, the memory cache) without asking the network:
 * the entry's `transferSize` is 0 and its `deliveryType` "cache", as the
 * browser's own cache hit reads natively
 */
export const CACHED_MARKER = 'stomp-cached';
/**
 * A Server-Timing metric the worker adds to an answer from its HTTP cache
 * that the origin confirmed with a 304: the entry's `transferSize` is 300
 * (the headers' stand-in, no body), as a revalidated entry reads natively
 */
export const REVALIDATED_MARKER = 'stomp-revalidated';
/**
 * A Server-Timing metric the worker adds, with one of the two above, to an
 * answer that natively is the renderer's memory cache's rather than the
 * HTTP cache's (Delivery: `memory`, `memory-revalidated`)
 */
export const MEMORY_MARKER = 'stomp-memory';
/**
 * A Server-Timing metric on a script response the rewrite cache keeps and
 * hands out again as it is (the store's own Response, which Chrome keeps
 * the compiled code with): it cannot say how the load it answers was
 * delivered, so the worker tells the inject apart from it (KEPT_LOAD,
 * src/server/keptLoads.ts)
 */
export const KEPT_MARKER = 'stomp-kept';
/** every Server-Timing metric of the worker's own, which the page never sees */
export const PROXY_METRICS: readonly string[] = [
	TAO_MARKER,
	OPAQUE_MARKER,
	TIMING_ONLY_MARKER,
	XHR_MARKER,
	CACHED_MARKER,
	REVALIDATED_MARKER,
	MEMORY_MARKER,
	KEPT_MARKER,
];
/**
 * On the answer of a page's emulated service worker: `<type> <url>`, the
 * response's type (basic, cors, opaque) and URL as the worker's Response
 * had them. To the browser every route is same-origin and the URL is the
 * request's; the inject's fetch shows the page the worker's type and URL
 * and never this header. The worker deletes it from every other response
 */
export const RESPONSE_TYPE_HEADER = 'x-stomp-response';
/**
 * On a request a page's fetch or XMLHttpRequest makes from a document the
 * page sandboxed without allow-same-origin (an opaque origin natively, the
 * site's through the proxy): the worker judges it as the browser judges an
 * opaque origin's request (Origin: null, cross-site, no same-origin
 * credentials) and strips it. A page that sets it on a request of its own
 * only takes privileges from itself
 */
export const OPAQUE_HEADER = 'x-stomp-opaque';
/**
 * On an XMLHttpRequest with credentials (open()'s user and password, or the
 * URL's): `user:password`, each percent-encoded as in a URL. The worker
 * answers the site's Basic challenge with them, as the browser would
 * (src/server/httpAuth.ts), and strips it
 */
export const CREDENTIALS_HEADER = 'x-stomp-credentials';
/**
 * set by the inject on an XMLHttpRequest that has upload listeners: the
 * CORS-preflight flag, which makes a cross-origin request go after a
 * preflight whatever its method and headers (dropped by the worker)
 */
export const PREFLIGHT_HEADER = 'x-stomp-preflight';
/**
 * SW -> the client that made a request (or, for a navigation, its parent):
 * the console notices Chrome prints for mixed content (src/mixedContent.ts),
 * which the inject writes in Chrome's words
 */
export const MIXED_CONTENT_NOTICE = '$stomp$mixedContent';
/**
 * SW -> the window that asked for a script the rewrite cache's kept
 * response answered: [the routed URL, when (ms since the epoch), how it
 * was delivered] (src/server/keptLoads.ts), which the response itself
 * cannot say (KEPT_MARKER)
 */
export const KEPT_LOAD = '$stomp$keptLoad';
/** [when (ms since the epoch), how] */
export type KeptLoad = [at: number, delivery: Delivery];
/**
 * A document's service worker client id. SW -> a document on about:srcdoc
 * that made a request the host's log reports: it has no URL of its own to
 * ask for it (`whoami`), and tells the host like any other document. And a
 * document in a frame of a proxied page -> the real top window, with
 * FRAME_MOVED all it tells the host (the page itself says it with its
 * navigate reports)
 */
export const CLIENT_ID = '$stomp$clientId';
/**
 * A document in a frame of a proxied page -> the real top window: its
 * history moved (it loaded, pushState or replaceState, popstate,
 * hashchange), with its client id once it has one, else null. A step of a
 * frame in the page is a step of the frame's history, which a tab's Back
 * takes first: the host reads the frame's buttons again
 * (src/controller/history.ts)
 */
export const FRAME_MOVED = '$stomp$frameMoved';
/** SW -> every window: the cookie jar changed for `domain` (every host when empty); pages drop their document.cookie cache */
export const COOKIES_CHANGED = '$stomp$cookiesChanged';
export interface CookiesChange {
	domain: string;
}
/** proxied page -> dedicated worker, with [port]: the worker's transport port */
export const TRANSPORT_INIT = '$stomp$transportInit';
/**
 * The compiled wasm modules by Assets key (`rewriter: 'wasm'`), from the
 * context that starts a dedicated worker to the worker, which is in its
 * agent cluster: a field of the worker's first message (the one that
 * carries TRANSPORT_INIT, when a transport could be had) when that context
 * holds them, so they are in the worker's queue before anything the page
 * posts. When they are still on their way to that context the field is
 * `true` and the message's last port is one they follow on, in a message
 * of this field alone (null there: they never came). A shared worker is
 * another agent cluster and is sent none of it.
 */
export const WORKER_MODULES = '$stomp$workerModules';
/**
 * a proxied page asking the host application to open a URL in a new tab
 * (`window.open`, `target="_blank"`); posted to the real top window, only
 * when the host opted in with `onOpen` (config `openTab`)
 */
export const OPEN_TAB = '$stomp$open';
/**
 * the service worker telling every window that a proxied origin's storage
 * changed, so the other documents of that origin can fire `storage` events
 */
export const STORAGE_EVENT = '$stomp$storageEvent';
/**
 * a proxied page telling the host application where it is now (on load,
 * pushState / replaceState, hashchange, popstate and title changes); posted
 * to the real top window, the host matches the source to one of its frames
 */
/**
 * a proxied page telling the host application that a host hook threw
 * (src/hooks.ts); posted to the real top window like a navigate report
 */
export const HOOK_ERROR = '$stomp$hookError';
export const NAVIGATE = '$stomp$navigate';

export interface NavigateInfo {
	/** the real URL the page shows */
	url: string;
	title: string;
	/** whether the frame's own history has an entry in that direction; null without the Navigation API */
	canGoBack: boolean | null;
	canGoForward: boolean | null;
	/**
	 * the page's icon as the page declared it, resolved against the page's
	 * real URL: the first `<link rel="icon">` (or `shortcut icon`), else the
	 * first `apple-touch-icon`, else null (a host may try /favicon.ico then);
	 * re-reported when the page changes it
	 */
	icon: string | null;
	/** the page's service worker client id, once it learned it (`whoami`) */
	client?: string;
}
/**
 * global set by the bootstrap of a worker started from a blob: URL: the
 * URL of the page that made it, which is what its relative URLs mean
 */
export const WORKER_BASE = '$stomp$workerBase';
/**
 * global set by the same bootstrap: the storage partition of the context
 * that started it (src/partition.ts), which a routed worker reads from its
 * route instead
 */
export const WORKER_PARTITION = '$stomp$workerPartition';
/**
 * global of a document's streamed shell (modifyHTMLStreamed): the page's
 * markup, sent before the worker's prewritten table, taken (and deleted)
 * by the script that loads it once the table follows
 */
export const SHELL_MARKUP = '$stomp$shellMarkup';
/**
 * dedicated worker -> its Worker object: where an uncaught error the browser
 * located inside the inject really comes from (the page's call site), sent
 * before the browser's report of it, which follows on the same queue
 */
export const WORKER_ERROR = '$stomp$workerError';
/**
 * proxied page -> SW, with [replyPort]: a call of the page's emulated
 * `navigator.serviceWorker` (docs/service-workers.md); the reply on the port
 * is `{ value }` or `{ error: { name, message } }`
 */
export const SW_API = '$stomp$swApi';
export interface ServiceWorkerApiMessage {
	/** the sender's controller address */
	directory: string;
	method: string;
	args: unknown;
}
/** SW -> proxied documents: an emulated registration changed, a message from an emulated worker, a new controller */
export const SW_EVENT = '$stomp$swEvent';
/** controller -> an emulated service worker, with [port]: its port to STomp's service worker */
export const SW_PORT = '$stomp$swPort';
/** rpc id on the port between STomp's service worker and an emulated worker */
export const SW_RPC = '$stomp$swRpc';
/** global the HTML shell sets before the client is made: the emulated registration that controls the new document */
export const SW_CONTROL = '$stomp$swControl';
/**
 * page -> SW: markup to serve once as an inline document (src/server/inline.ts)
 * at the controller address `directory`, under `token`
 */
export const INLINE_DOCUMENT = '$stomp$inlineDocument';
/**
 * A page minted a blob: URL (the browser's form, `blob:<proxy origin>/...`):
 * the worker records it under the real origin of the document that said so,
 * which it reads from that document's own routed URL, so a blob: worker's
 * requests are judged as its creator's (Sec-Fetch-Site, credentials,
 * SameSite) rather than as the target's own
 */
export const BLOB_MINTED = '$stomp$blobMinted';
export interface BlobMintedMessage {
	directory: string;
	url: string;
}

/**
 * A document is about to navigate (the Navigation API's navigate event, a
 * new document only). A navigation can reach the worker
 * with no referrer and no client (one from an about:blank document, or
 * under a no-referrer policy), which it would take for one the user started
 * from the host: Sec-Fetch-Site `none`, Sec-Fetch-User `?1`. The worker
 * takes the initiator's origin from the sending document's own routed URL,
 * never from the message, so a document can only vouch for navigations of
 * its own origin; a forged `activated` gains at most Sec-Fetch-User on one
 * of those.
 */
export const NAVIGATION_HINT = '$stomp$navigationHint';
export interface NavigationHintMessage {
	directory: string;
	/** where the navigation goes, as the page sees it (the real URL; a routed one is decoded) */
	url: string;
	/** the document had transient user activation when the navigation began */
	activated: boolean;
	/** an iframe's navigation: the element's allow attribute (its container policy) */
	allow?: string;
}
/**
 * What a proxied document (or the controller) sees that its requests'
 * client hints carry (src/server/clientHints.ts): the worker has no window
 * to read the pixel ratio, the viewport or the media preferences from. A
 * top-level document also names the hints of the Accept-CH metas its
 * script inserted. The worker files a
 * document's report under the sender's client id, never one it names.
 */
export const CLIENT_HINTS = '$stomp$clientHints';
export interface ClientHintsReport {
	directory: string;
	dpr: number;
	colorScheme: 'light' | 'dark';
	reducedMotion: 'no-preference' | 'reduce';
	reducedTransparency: 'no-preference' | 'reduce';
	/** the document's innerWidth and innerHeight */
	viewport?: [number, number];
	/** from the controller: `viewport` is a host frame's, about to navigate */
	top?: boolean;
	/** hints an Accept-CH meta the page's script inserted named */
	accept?: string[];
}
/**
 * A proxied document asks about its site's permissions
 * (src/server/permissions.ts), with a port for the answer. The worker takes
 * the site (the proxied top's real origin) and the document's policy from
 * the sender's own routed URL and client, never from the message.
 */
export const PERMISSION = '$stomp$permission';
export type PermissionState = 'granted' | 'denied' | 'prompt';
export type PermissionMessage = { directory: string } & PermissionOp;
export type PermissionOp =
	| {
			/** the site's state of every simulated permission, and the document's policy */
			op: 'states';
	  }
	| {
			/** the page asks for `name`; `real` is the proxy origin's own state */
			op: 'request';
			name: string;
			real: PermissionState;
	  }
	| {
			/** how the browser's own prompt the worker handed over ended */
			op: 'result';
			name: string;
			token: string;
			state: PermissionState;
	  }
	| {
			/** the salt of the document's origin, for the device ids it reads */
			op: 'deviceSalt';
	  }
	| {
			/**
			 * what Chrome answers getUserMedia(`constraints`) before the policy
			 * and the permission (the controller's mediaVerdict)
			 */
			op: 'media';
			constraints: unknown;
	  };
/** the error a getUserMedia request ends in, as its fields */
export interface MediaVerdict {
	name: string;
	message: string;
	/** an OverconstrainedError's */
	constraint?: string;
}
export interface PermissionStates {
	site: string;
	states: Record<string, PermissionState>;
	/** the policy-controlled features the document may use, when the worker knows the document */
	features: Record<string, boolean> | null;
}
/**
 * The worker's answer to a request: `granted` (call the browser's API),
 * `browser` (the site has not decided and neither has the browser: call it,
 * its prompt decides, and say how it ended with `token`), `denied`,
 * `dismissed` (the host's prompt was closed without an answer) or
 * `blocked` (the browser denies the proxy origin)
 */
export type PermissionDecision =
	| { decision: 'granted' | 'denied' | 'dismissed' | 'blocked' }
	| { decision: 'browser'; token: string };
/** what the worker asks the host about a site's request (StompController onPermissionRequest) */
export interface PermissionRequestInfo {
	/** the site's real origin (the proxied top's) */
	origin: string;
	/** the permission's name, as permissions.query names it */
	permission: string;
	/** the requesting document's service worker client id */
	client?: string;
}
/**
 * A routed document vouches for an about:srcdoc document under it: a token
 * the srcdoc document made, which the worker binds to the routed document's
 * real origin and partition (read from its own routed URL, never from the
 * message) and the srcdoc document's client then claims (SRCDOC_CLAIM),
 * before any of its page's script runs. A srcdoc document's URL names no
 * origin, and under a no-referrer policy its requests carry no Referer
 * either: without this the worker judges them as an opaque origin's.
 */
export const SRCDOC_VOUCH = '$stomp$srcdocVouch';
/**
 * an about:srcdoc client presents the token its ancestor vouched for; an
 * empty token says none vouches for it (an opaque document)
 */
export const SRCDOC_CLAIM = '$stomp$srcdocClaim';

export interface SrcdocMessage {
	directory: string;
	token: string;
}

export interface InlineDocumentMessage {
	directory: string;
	token: string;
	markup: string;
	url: string;
}

/**
 * The BroadcastChannel (by its native, unpartitioned name, which no page can
 * open) on which every inject bundle of the browser shares the host
 * candidates its peer connections showed a page, so a remote candidate one
 * proxied page hands another is recognised as this browser's own
 * (docs/webrtc.md)
 */
export const WEBRTC_CHANNEL = '$stomp$webrtc';
export type WebRTCChannelMessage =
	/** a name a page was shown, and the address it stands for when it is not the browser's own mDNS name */
	| { kind: 'name'; name: string; address?: string }
	/** a new bundle asks the others to tell it every name again */
	| { kind: 'sync' };

export interface StorageChange {
	store: string;
	origin: string;
	/** null when the store was cleared */
	key: string | null;
	oldValue: string | null;
	newValue: string | null;
	/** the document that made the change, which must not hear about it */
	sender?: string;
	/** that document's URL, for StorageEvent.url */
	url?: string;
}

export interface ControllerInitMessage {
	directory: string;
	config: Config;
	/** the controller bundle's build id (src/version.ts) */
	build: string;
	/**
	 * The controller's rewrite workers: the last `ports` ports of the
	 * handshake are theirs, one each; a rewrite that has no answer within
	 * `timeout` ms is made in the service worker instead
	 */
	rewritePool?: { ports: number; timeout: number };
	/**
	 * The wasm modules the controller loaded (`rewriter: 'wasm'`), by Assets
	 * key, for the service worker's thread (src/wasm/thread.ts). Their bytes,
	 * not the compiled modules: a service worker is an agent cluster of its
	 * own, and a message holding a WebAssembly.Module never reaches it. A
	 * load that finishes after the handshake sends CONTROLLER_MODULES.
	 */
	modules?: Record<string, ArrayBuffer>;
	/** the built-in blocker: its lists (its module is `modules.blocker`) (docs/adblock.md) */
	adblock?: AdblockInit;
}

/** controller -> SW: the wasm modules' bytes, when they were not loaded at the handshake */
export const CONTROLLER_MODULES = '$stomp$controllerModules';
export interface ControllerModulesMessage {
	directory: string;
	modules: Record<string, ArrayBuffer>;
}

/** the message that hands a rewrite worker a port to serve (the service worker holds the other end) */
export const REWRITE_PORT = '$stomp$rewritePort';
/** controller -> rewrite worker: the compiled wasm modules by Assets key (src/wasm/thread.ts); the worker answers with the names it holds */
export const REWRITE_MODULES = '$stomp$rewriteModules';
export interface InitRemoteTransportMessage {
	directory: string;
	/**
	 * the blob: URL the worker this port is for starts from (its bootstrap):
	 * no request for it reaches the service worker, which names the worker's
	 * creator in the host's request log by it (RequestInfo.owner)
	 */
	worker?: string;
}

/**
 * page -> SW, with [port]: the controller of `directory` answers on the
 * port with the wasm modules it compiled (PAGE_MODULES). A proxied top asks
 * once, for the rewriter library it shares with its frames
 * (src/inject/rewriter.ts): the page and the controller are one agent
 * cluster, so the compiled module itself reaches it, which a library realm
 * can only instantiate.
 */
export const INIT_PAGE_MODULES = '$stomp$initPageModules';
export interface InitPageModulesMessage {
	directory: string;
}
/** controller -> page, on that port: the compiled modules by Assets key */
export const PAGE_MODULES = '$stomp$pageModules';

// RPC descriptions. Each is [args, return] or [args].

/** rpc id shared by the controller<->SW port */
export const CONTROLLER_RPC = 'stomp';
/** rpc id shared by every transport port */
export const TRANSPORT_RPC = 'transport';

/** implemented by the SW, called by the controller */
/**
 * A request rule, run in the service worker on the real URL after the
 * worker rebuilt Referer, Origin and cookies, before the cache. `url` is a
 * URLPattern string (`https://*.example.com/ads/*`); a rule whose pattern
 * cannot be compiled is skipped with one console warning. The first matching
 * rule wins. `null` deletes a header.
 */
export interface RequestRuleMatch {
	url?: string;
	method?: string[];
	destination?: string[];
	site?: ('same-origin' | 'same-site' | 'cross-site' | 'none')[];
}
export interface RequestRuleAction {
	requestHeaders?: Record<string, string | null>;
	responseHeaders?: Record<string, string | null>;
	/** answer with a 307 to this real URL (routed) */
	redirect?: string;
	/** answer with this status and an empty body, never going upstream */
	status?: number;
}
export interface RequestRule {
	match: RequestRuleMatch;
	/** `block`: a 403 with an empty body */
	action: 'block' | RequestRuleAction;
}

/**
 * How a host page that shows a proxied page again was itself loaded, as the
 * cache mode the navigations that restore it take: `no-cache` after a
 * reload, `reload` after a hard one (src/controller/hostReload.ts)
 */
export type HostReload = 'no-cache' | 'reload';
export type SWbound = {
	/** replace the request rules */
	rules: [RequestRule[]];
	/** the host page was reloaded: the pages it restores are (HostReload) */
	hostReload: [HostReload];
	/** resolve a URL against the controller's config into a routed (proxied) URL */
	route: [string, string];
	/** the real URL a routed one stands for (the controller's codec); null for anything that is not a route */
	unroute: [string, string | null];
	/** drop every entry of the HTTP cache */
	clearCache: [];
	/** the wasm modules the service worker's thread holds, by Assets key (src/wasm/thread.ts) */
	modules: [undefined, string[]];
	/**
	 * the public suffix list the service worker's sites are answered from:
	 * the commit and date its suffix module names (src/wasm/suffix.ts), null
	 * while tldts answers
	 */
	suffixList: [undefined, { commit: string; date: string } | null];
	/** the host reading, importing or wiping the cookie jar */
	cookies: [CookieCommand, CookieResult];
	/**
	 * whether the built-in blocker's lists block a WebSocket to `url` opened
	 * under `source` (the Origin its handshake carries, '' when it has none):
	 * the controller asks from its handshake hook, since a socket never passes
	 * the service worker (docs/adblock.md). False while no engine answers.
	 */
	socket: [{ url: string; source: string }, boolean];
	/**
	 * which of these clients no longer exist: the controller forgets the
	 * frame it kept for each (the request log's attribution)
	 */
	goneClients: [string[], string[]];
};

/** a cookie as the jar stores it, for export and import by the host */
export interface CookieRecord {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** ISO date, or null for a session cookie */
	expires: string | null;
	secure: boolean;
	httpOnly: boolean;
	sameSite: 'lax' | 'strict' | 'none';
	/** set without a Domain attribute: sent to that host only */
	hostOnly: boolean;
}

export type CookieCommand =
	/** `initiator`: the origin asking (a WebSocket handshake), so SameSite applies; absent means the host, which gets everything */
	| { op: 'get'; url: string; initiator?: string }
	| { op: 'set'; url: string; setCookie: string | string[] }
	| { op: 'list'; origin?: string }
	| { op: 'clear'; origin?: string };

export type CookieResult = string | CookieRecord[] | undefined;

/** a failure the proxy produced: the transport could not reach the origin, the worker's timeout, a routing error, a blocked rule, the refusal to proxy its own origin */
/** `controller`: the address names a controller that is gone and no live one of its codec can take over */
export type RequestErrorKind =
	'transport' | 'timeout' | 'routing' | 'blocked' | 'refused' | 'controller';

/** one completed (or failed) proxied request, for the host's request log */
export interface RequestInfo {
	/** the real URL */
	url: string;
	method: string;
	/** the request's destination; `fetch` for fetch, XHR and beacons (the browser's empty string) */
	destination: string;
	/** 0 when the transport failed; see `error` */
	status: number;
	/** wall time in the service worker, from routing to the response headers */
	ms: number;
	/** answered from the HTTP cache without a request */
	cached: boolean;
	/** answered from the HTTP cache once the origin had confirmed its entry (a 304 to a conditional request) */
	revalidated?: boolean;
	/** a script's rewritten output: from the rewrite cache, made now and kept, or made now and not kept (the response may not be kept) */
	rewriteCache?: 'hit' | 'miss' | 'skip';
	/** where a script made now was rewritten: one of the controller's rewrite workers, several of them (a large bundle split across them), or the service worker itself */
	rewriteIn?: 'pool' | 'pool split' | 'service-worker';
	/** under `rewriter: 'wasm'`, a stylesheet that had something to route: whether the scanner module rewrote it (`wasm`) or css-tree did (`js`: the service worker does not hold the module yet); the output is the same. A script made now: whether the wasm rewriter rewrote it (`wasm`) or the JavaScript rewriter did (`js`: the module declined the script, its thread does not hold the module yet, or the script was split across the rewrite workers); the same rewrite, written into the script's own text by the module and printed anew by the JavaScript rewriter */
	rewriteBy?: 'wasm' | 'js';
	/** Content-Length of the response, when known */
	bytes: number | null;
	error?: string;
	/** what failed, when the proxy itself produced the failure (see ControllerInit.errorPage) */
	kind?: RequestErrorKind;
	/** the service worker client that made it; the controller maps it to a frame */
	client?: string;
	/**
	 * when a worker made it: the document that made the worker (through the
	 * workers between them), whose frame the request belongs to
	 */
	owner?: string;
	/** the index, in the host's `rules`, of the rule that applied */
	rule?: number;
}

/** what the service worker knows about the client that made a request */
export interface RouteContext {
	clientId?: string;
	/** the fetch event's own client id (empty for a navigation) */
	requestClientId?: string;
	/** the client a navigation or a worker script creates */
	resultingClientId?: string;
	/** FetchEvent.isReload */
	isReload?: boolean;
	/** extends the fetch event's lifetime (an update check after a navigation) */
	waitUntil?: (promise: Promise<unknown>) => void;
	/** a request the worker makes itself (an emulated worker's script) skips the HTTP cache */
	bypassCache?: boolean;
	/** a request the worker makes itself never goes to an emulated service worker */
	internal?: boolean;
	/**
	 * a request the worker makes itself under CORS, as the client's own (a
	 * background fetch's download); any other one it makes is a no-cors load
	 */
	cors?: boolean;
}

/** implemented by the controller, called by the SW */
export type Controllerbound = {
	ready: [{ build: string }];
	/** another controller registered with this one's id; the worker closes the port right after */
	replaced: [];
	initRemoteTransport: [MessagePort];
	/** a proxied top asks for the compiled wasm modules, answered on the port (PAGE_MODULES) */
	pageModules: [MessagePort];
	/** a proxied request completed; only sent when the host asked (config.requestLog) */
	request: [RequestInfo];
	/**
	 * start a page's emulated service worker (docs/service-workers.md): a
	 * dedicated Worker at `url` (its `sw:` route); answers with the port the
	 * worker talks to STomp's service worker over
	 */
	startServiceWorker: [
		{ id: string; url: string; type: 'classic' | 'module' },
		MessagePort,
	];
	/** terminate the emulated worker started under `id` */
	stopServiceWorker: [{ id: string }];
	/**
	 * a site asks for a permission the proxy origin already has: the host
	 * asks the user (true grants, false denies, null: no answer)
	 */
	permission: [PermissionRequestInfo, boolean | null];
	/**
	 * what the browser answers getUserMedia(constraints) before its policy
	 * and permission checks (src/controller/mediaVerdict.ts); null: none
	 */
	mediaVerdict: [unknown, MediaVerdict | null];
};

/** a transport's response on its way to a RemoteTransport: a streamed body travels on a port of its own (bodyPort.ts) */
export type WireResponse =
	| TransferrableResponse
	| (Omit<TransferrableResponse, 'body'> & { body: PortBody });

/** implemented by the transport host, called by RemoteTransport */
export type TransportToHost = {
	request: [
		{
			remote: string;
			method: string;
			body: BodyInit | null;
			headers: RawHeaders;
		},
		WireResponse,
	];
	connect: [
		{
			url: string;
			protocols: string[];
			requestHeaders: RawHeaders;
			port: MessagePort;
		},
		(
			| { result: 'success'; protocol: string; extensions: string }
			| { result: 'failure'; error: string }
		),
	];
};

/** implemented by RemoteTransport, called by the host */
export type HostToTransport = {
	ready: [];
};

/** rpc id on the controller <-> transport worker channel (the Worker's own) */
export const TRANSPORT_WORKER_RPC = 'stomp-transport-worker';

/** what the transport worker constructs: a module URL and constructor arguments */
export interface TransportModule {
	module: string;
	options?: unknown[];
	/** TransportDescriptor.http3 */
	http3?: boolean | Http3DescriptorOptions;
}

/** implemented by the transport worker (src/transport/worker.ts), called by the controller */
export type WorkerBound = {
	/** import the module and construct the transport; rejects with the import or constructor error */
	init: [TransportModule];
	/** replace the transport; in-flight requests finish on the old one */
	setTransport: [TransportModule];
	/** serve the transport to the RemoteTransport on this port (the service worker's, a page's, the host's) */
	serve: [MessagePort];
};

/**
 * The message of the error a WebSocket handshake hook rejects with to refuse
 * the socket (serveTransport's `decorate`, and WorkerToController.decorate,
 * whose rejection crosses the rpc by its message): the connection fails
 * before anything is opened on the transport. Any other rejection, and a
 * hook that stalls, leave the handshake as the page sent it.
 */
export const HANDSHAKE_REFUSED = '$stomp$handshakeRefused';

/** implemented by the controller, called by the transport worker */
export type WorkerToController = {
	/** the headers a WebSocket handshake goes out with (the controller adds the jar's Cookie); rejects with HANDSHAKE_REFUSED to refuse the socket */
	decorate: [{ url: string; headers: RawHeaders }, RawHeaders];
};

export type WebSocketMessage =
	| { type: 'data'; data: WebSocketDataType }
	| { type: 'close'; code: number; reason: string };

const portPostMessage = MessagePort.prototype.postMessage as (
	this: MessagePort,
	message: unknown,
	transfer: Transferable[],
) => void;

/** postMessage on a port using the pristine prototype method (pages may hook postMessage) */
export function postToPort(
	port: MessagePort,
	message: unknown,
	transfer: Transferable[] = [],
) {
	portPostMessage.call(port, message, transfer);
}

export function transferablesOf(value: unknown): Transferable[] {
	if (value instanceof ArrayBuffer || value instanceof ReadableStream)
		return [value];
	return [];
}
