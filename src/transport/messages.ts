import type {
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import type { AdblockInit, SiteShields } from '../blocker/types';
import type { Config } from '../config';
import type { IsolationEngine } from '../isolation';
import type {
	PasskeyCommand,
	PasskeyInfo,
	PasskeyOp,
	PasskeyPrompt,
} from '../passkeys/types';
import type { PortBody } from './bodyPort';
import type { Http3DescriptorOptions } from './construct';
import type { TransportNote } from './transportLog';
import type { CarrierInfo, WispWebTransportOptions } from './wispWebTransport';

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
/**
 * SW -> every client: SW (re)started, controllers must re-send
 * CONTROLLER_INIT. It names the worker (ReviveMessage), so a controller
 * that worker has already registered knows the revive is not for it
 */
export const SW_REVIVE = '$stomp$swRevive';
export interface ReviveMessage {
	/** this run of the worker: new every time the browser starts it */
	instance?: string;
}
/**
 * controller -> SW, with every call it makes over its port: nothing to do.
 * A worker the browser stopped hears nothing on a port; this message starts
 * it, and it then asks for the handshake the call is made again after
 */
export const SW_WAKE = '$stomp$swWake';
/**
 * How often a controller sends SW_WAKE with nothing to ask, so the worker
 * is not stopped under it: the browser stops a service worker no event has
 * reached for 30 seconds, and a message is an event. The time is kept by a
 * worker (the transport's, or one started for the time alone): a hidden
 * tab's own timers run once a minute after five minutes, a worker's keep
 * theirs.
 */
export const KEEPALIVE_MS = 20000;
/**
 * A proxied page -> its controller, as an event dispatched on the windows
 * around the page (the type is this name followed by the controller's
 * address, which only the two of them know): the page has waited
 * SYNC_KICK_MS inside one of its own tasks for the worker's answer to a
 * synchronous ask. A controller on the page's thread hears nothing else
 * until that task ends, the worker's revive included; see
 * StompController's #standIn.
 */
export const SW_KICK = '$stomp$swKick';
/**
 * SW -> controller, on the first port of a `standby` CONTROLLER_INIT the
 * worker turns down because it has the controller registered already, right
 * before it closes the offer's ports: the run of the worker that declined
 * (ReviveMessage.instance), which is up
 */
export const STANDBY_DECLINED = '$stomp$standbyDeclined';
export interface StandbyDeclined {
	instance: string;
}
/** how long a synchronous ask waits for its answer before the page tells its controller */
export const SYNC_KICK_MS = 300;
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
/**
 * A page tells the worker which of its images still loading it laid out in
 * its viewport (their URLs, as the page asked for them): Chrome raises such
 * an image's request to a fetch's urgency, so one still waiting for a
 * connection goes before the scripts and images out of sight
 * (src/transport/socketPool.ts raise)
 */
export const IMAGES_SEEN = '$stomp$seen';
/**
 * The worker tells a document, on the channel the document opened for its
 * load grants (src/inject/dom/loadGrants.ts), that a request for one of its
 * images waits for a connection: only then does the document watch which
 * of its images it lays out in its viewport (IMAGES_SEEN), as only then
 * does the order of its requests depend on it
 */
export const IMAGES_WAITING = '$stomp$imagesWaiting';
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
 * SW -> proxied page, on that channel: the answer to a granted
 * `webidentity no-cors` load (a FedCM endpoint the browser reads from its
 * own process, with no CORS check: the well-known file, the config, the
 * accounts list, the client metadata). The worker reads its body and posts
 * it here, keyed by the request's token, and the request itself is
 * answered with no body: the inject reads it from its own channel, where
 * no promise or Response of the page's realm ever holds it
 */
export const IDENTITY_READ = '$stomp$identityRead';
export interface IdentityReadMessage {
	token: string;
	status: number;
	/** the body's text, or null when it was too long to read */
	body: string | null;
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
 * `$csp=`, which names that route among its worker sources). Given a URL
 * instead of a blob, the worker says whether a fetch of it succeeds: a
 * worker from the route has no policy of the page's, and asks for a
 * document whose policy refuses blob: requests (src/csp.ts).
 */
export const SEALER_SOURCE =
	"onmessage=function(e){var d=e.data;typeof d[1]=='string'?fetch(d[1]).then(function(){postMessage([d[0],'1'])},function(){postMessage([d[0],''])}):postMessage([d[0],URL.createObjectURL(d[1])])}";
export const SEALER_ROUTE = 'sealer';
/**
 * The service worker's route under an address that answers a POST with
 * its body, as the type its last segment names: what the inject's XHR
 * module makes a response document of where the document's policy refuses
 * a data: URL (src/csp.ts)
 */
export const ECHO_ROUTE = 'echo';
/**
 * The service worker's route under an address where a document announces,
 * with a POST of `{ url, activated, opaque }` (url: the real destination),
 * that it is about to navigate another window from that window's realm
 * (src/server/navigationHints.ts NavigationInitiator). The request itself
 * says who it is (its client) and its referrer policy.
 */
export const INITIATOR_ROUTE = 'initiator';
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
 * A Server-Timing metric the worker adds, with OPAQUE_MARKER, to the last
 * hop of a no-cors redirect chain that ended at another origin than the
 * request's own: a worker's importScripts() mutes such a script natively,
 * and not one whose chain came back to the worker's origin (measured on
 * Chrome 157; a document mutes both). The inject reads it
 * (ImportScripts) and the page never sees it.
 */
export const AWAY_MARKER = 'stomp-away';
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
/**
 * A Server-Timing metric the worker adds to a document whose navigation
 * went through link routes (src/visited.ts): its duration is how many of
 * the navigation's redirects were the worker's own. The inject takes them
 * off the document's navigation timing (`redirectCount`)
 */
export const HOPS_MARKER = 'stomp-hops';
/**
 * A Server-Timing metric the worker adds to a load whose redirect chain
 * went through another origin that did not let the page see its timing (no
 * Timing-Allow-Origin naming it): the entry is restricted whatever origin
 * its name (the chain's first URL) and its last hop are of, as natively
 */
export const TIMING_DENIED_MARKER = 'stomp-tao-denied';
/**
 * A Server-Timing metric the worker adds to another origin's answer to a
 * cors request (a fetch, an XMLHttpRequest, an element with `crossorigin`):
 * its status and content type are the page's to read in resource timing,
 * which a no-cors load's are not
 */
export const CORS_MARKER = 'stomp-cors';
/**
 * A Server-Timing metric with the sizes the origin's body had: its
 * duration is the bytes it came as (`encodedBodySize`: the origin's
 * Content-Length, or the decoded size of a body without a
 * Content-Encoding) and its description, when there is one, the bytes of
 * the body the worker rewrote (`decodedBodySize`). The browser counts the
 * bytes the worker answers with: the rewritten text, the decoded body
 */
export const SIZE_MARKER = 'stomp-size';
/**
 * A Server-Timing metric the worker adds to a load a style sheet of
 * another origin made, when the page loaded that sheet without cors: the
 * browser reports no resource timing entry for it (the sheet's content is
 * not the page's to learn), so the inject shows none
 */
export const UNREPORTED_MARKER = 'stomp-unreported';
/**
 * A Server-Timing metric whose description is the Content-Encoding of
 * another origin's cors answer whose timing the page may see: the header
 * itself is not one the page may read, so the browser is not given it, and
 * the entry's `contentEncoding` is read from here
 */
export const ENCODING_MARKER = 'stomp-encoding';
/**
 * A Server-Timing metric on the script a page starts a dedicated worker
 * with: the page's entry for it has neither an interim response's time
 * nor its final headers' (measured natively), unlike every other load's
 */
export const WORKER_SCRIPT_MARKER = 'stomp-worker-script';
/**
 * A site's own Server-Timing metric named like the worker's marks (one
 * that starts with `stomp-`) reaches the browser as `stomp-!<rest>`, a name
 * no mark has: the worker escapes the origin's header before it adds a mark
 * (escapeSiteMetrics, src/server/rewrites.ts), and the inject shows the page
 * the name the site gave (siteMetrics: a metric's name, a header's value).
 * Only a metric's name is touched, not a quoted description's text.
 */
export const siteMetrics = (value: string) =>
	value.replace(
		/("(?:[^"\\]|\\.)*")|((?:^|,)\s*stomp-)!/g,
		(all, quoted, start) => quoted ?? start,
	);
/**
 * A Server-Timing metric whose description names the header values with
 * bytes past 0x7F, each as `<name>:<the bytes, escape()d>` and the next
 * after a space. Chrome reads a header as a byte string, but it encodes a
 * service worker's Response headers as UTF-8 again (its Headers hold no
 * character past U+00FF, so the worker cannot hand it the text either): a
 * page read c3 83 c2 a9 for the c3 a9 a server sent. The inject shows a
 * fetch or an XMLHttpRequest these bytes instead (and Content-Disposition
 * as the site sent it, which the worker rewrites for the browser's own
 * reading: filterHeaders.ts browserBytes)
 */
export const BYTES_MARKER = 'stomp-bytes';
/**
 * A Server-Timing metric the worker adds to an answer whose Set-Cookie
 * headers (its own, or a redirect's on the way) changed the jar: its
 * description is the hosts they were set from, space-separated. Natively
 * the jar has a response's cookies before the page sees the response, so a
 * page that tells another window of it (a popup's fetch, then postMessage)
 * has that window read them in document.cookie. The worker's broadcast of
 * the change (COOKIES_CHANGED) is a message of its own, which the page's
 * message could overtake: the inject that hands the page the response
 * stamps the sites' cookie versions first (src/inject/dom/modules/Cookies.ts)
 */
export const JAR_MARKER = 'stomp-jar';
/** every Server-Timing metric of the worker's own, which the page never sees */
export const PROXY_METRICS: readonly string[] = [
	TAO_MARKER,
	TIMING_DENIED_MARKER,
	CORS_MARKER,
	SIZE_MARKER,
	UNREPORTED_MARKER,
	ENCODING_MARKER,
	WORKER_SCRIPT_MARKER,
	OPAQUE_MARKER,
	AWAY_MARKER,
	TIMING_ONLY_MARKER,
	XHR_MARKER,
	CACHED_MARKER,
	REVALIDATED_MARKER,
	MEMORY_MARKER,
	KEPT_MARKER,
	HOPS_MARKER,
	BYTES_MARKER,
	JAR_MARKER,
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
 * set by the inject on an asynchronous XMLHttpRequest with a timeout: the
 * timeout in ms, which the worker keeps on its own clock from when the
 * request reached it (dropped by the worker). Chrome keeps the timeout in
 * its network service, so a long task on the page's thread never makes an
 * answer that came in time lose to it. The worker's answer to a request
 * past it carries the header with the request's ABORT_HEADER id, and the
 * page fires the timeout.
 */
export const TIMEOUT_HEADER = 'x-stomp-timeout';
/**
 * SW -> the client that made a request (or, for a navigation, its parent):
 * the console notices Chrome prints for mixed content (src/mixedContent.ts),
 * which the inject writes in Chrome's words
 */
export const MIXED_CONTENT_NOTICE = '$stomp$mixedContent';
/**
 * The service worker tells a document of a request it let through that a
 * report-only policy of the page's refuses (src/server/contentPolicies.ts):
 * `[directive, url]`, for the inject to report as the browser would have.
 * A navigation's later hop adds what the report names (`blocked`), how
 * many times the browser fires it, and whether the policy is the parent's
 * of the document told (a frame's, which told the worker of its own
 * navigation): `[directive, url, blocked, times, parent]`.
 */
export const CSP_REPORT = '$stomp$cspReport';
/**
 * The global the shell names its document's script policy in for the
 * client it makes (src/csp.ts ScriptFacts), taken and deleted by the client
 */
export const CSP_FACTS = '$stomp$cspFacts';
/**
 * The global a blob: worker's bootstrap names the policies it inherits in
 * for the client it makes (src/csp.ts WorkerPolicies), taken and deleted
 * by the client
 */
export const CSP_WORKER = '$stomp$cspWorker';
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
/**
 * Beside FRAME_MOVED under a site pool: the document's current entry of the
 * browser's session history ({ key, id, url }, the url its route), which the
 * agent of its page's slot cannot read when the document is another slot's
 * (src/controller/history.ts)
 */
export const FRAME_ENTRY = '$stomp$frameEntry';
/** SW -> every window: the cookie jar changed for `domain` (every host when empty); pages drop their document.cookie cache */
export const COOKIES_CHANGED = '$stomp$cookiesChanged';
/**
 * The BroadcastChannel of the host origin's cookie jar database: whoever
 * writes it (a scope's service worker, the site pool's jar server) posts
 * there once the write is done, and a service worker that keeps what it
 * read of the jar (KeptJar, src/server/Cookies.ts) forgets it
 */
export const JAR_WRITES = '$stomp$jarWrites';
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
 * the service worker telling the document that sent one of its ordered
 * storage operations (a beacon, which has no answer the page reads) that it
 * is done: its `sender` (the realm's sequence of operations on a store),
 * its `seq`, and whether it was lost
 */
export const STORAGE_LANDED = '$stomp$storageLanded';
export interface StorageLanded {
	sender: string;
	seq: number;
	/** not applied: the worker emptied its key */
	lost?: boolean;
}
/**
 * Clear-Site-Data "storage": the service worker asking every window to drop
 * a storage key's directory of the legacy file system (its `key`), which it
 * cannot reach itself, and waiting for the first to say it is gone (its
 * `id`, in LEGACY_FS_CLEARED)
 */
export const LEGACY_FS_CLEAR = '$stomp$legacyFSClear';
/** a window telling the service worker a LEGACY_FS_CLEAR is done (its id) */
export const LEGACY_FS_CLEARED = '$stomp$legacyFSCleared';
export interface LegacyFileSystemClear {
	key: string;
	id: string;
}
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
/**
 * Beside NAVIGATE under a site pool: how the browser navigated to the
 * document (navigation.activation.navigationType: push, replace, traverse,
 * reload), which tells the hub whether a document of another slot took a
 * new entry or the last one's (src/controller/index.ts Frame)
 */
export const NAVIGATION_TYPE = '$stomp$navigationType';
/**
 * Beside NAVIGATE under a site pool: `[index, length]` of the document's
 * entry in the stretch of the frame's history the browser lists it (the
 * Navigation API's entries, its own slot's), from which the hub counts the
 * frame's entries in every slot (`historyAcross` in src/inject/dom/Client.ts)
 */
export const HISTORY_RUN = '$stomp$historyRun';
/**
 * a proxied document telling the host it got its first user activation (a
 * click or a key), posted like a navigate report with the document's token
 * (its client's historyActivation.token), for Chrome's history intervention
 * (src/controller/history.ts): the click may navigate it away before the
 * host could read it. In same-origin mode the frame's element has a
 * function under this name, which the document calls instead
 */
export const ACTIVATED = '$stomp$activated';

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
 * the route under a controller's address a document's shell reads the rest
 * of its markup from as it arrives (`markup-<token>`, DocumentClient
 * loadHTMLStream): each piece is `<length>\n<JSON [markup, prewritten
 * table or null, the document's byte count with the last piece, else -1]>`.
 * No page URL corresponds to it
 */
export const MARKUP_ROUTE = 'markup';
/**
 * the type of the empty script element that ends an HTML shell, after the
 * script that loads the page (DocumentClient.loadHTML): no script runs from
 * it, but the parser performs a microtask checkpoint at its end tag, where
 * the client writes the page before the shell can finish loading
 */
export const SHELL_END = 'text/x-stomp-shell-end';
/**
 * dedicated worker -> its Worker object: where an uncaught error the browser
 * located inside the inject really comes from (the page's call site), sent
 * before the browser's report of it, which follows on the same queue
 */
export const WORKER_ERROR = '$stomp$workerError';
/**
 * WORKER_ERROR keyed by a controller's `globalName`: a STomp the page runs
 * (proxy-ception) sends its own, which this one's Worker hook lets through
 */
export const workerErrorKey = (globalName: string) =>
	`${WORKER_ERROR}:${globalName}`;
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

/**
 * A frame's document cancelled a navigation of its own context to another
 * origin, which its parent makes again in a fresh browsing context
 * (src/inject/dom/freshContext.ts): the request comes from the parent's
 * element, with the parent's URL for its referrer and the parent's policy.
 * The document says so first with a POST to this route under its address,
 * whose body is the routed URL the fresh context asks for. The worker takes
 * the request's own client (its routed URL) as the navigation's referrer
 * and initiator, and the request's referrer policy as the navigation's:
 * the browser gives a request of the document that document's policy, or
 * the one the request names, which is the link's or the form's own
 * (`referrerpolicy`, `rel=noreferrer`). Nothing the body says is either.
 * It is answered before the frame goes, so the worker knows in time.
 */
export const FRESH_RETURN_ROUTE = 'fresh';
export interface NavigationHintMessage {
	directory: string;
	/** where the navigation goes, as the page sees it (the real URL; a routed one is decoded) */
	url: string;
	/** the document had transient user activation when the navigation began */
	activated: boolean;
	/** an iframe's navigation: the element's allow attribute (its container policy) */
	allow?: string;
	/** the nested route marker of the navigating document's frame (false at the top level): where a link route's document belongs */
	nested?: string | false;
	/**
	 * Whether the document that navigates is the routed one that sends
	 * this: not for a document a page wrote itself (about:srcdoc,
	 * about:blank, blob:), whose navigation's referrer is the address of
	 * another document, in another frame
	 */
	own?: boolean;
	/**
	 * The page's policies that judge the navigation's later hops (a form's
	 * form-action, a frame's parent's frame-src; src/csp.ts HopPolicy), and
	 * a frame's real ancestors' origins, nearest first (the frame-ancestors
	 * of the document it ends in). `parent`: the policies are the parent's,
	 * and the frame that navigates sends them. `required`: the policy the
	 * frame's csp attribute requires of that document (CSP Embedded
	 * Enforcement)
	 */
	csp?: {
		policies: [string, string[], 'enforce' | 'report', string][];
		ancestors?: string[];
		parent?: boolean;
		required?: string;
	};
	/**
	 * A top-level navigation's opener policy facts (src/coop.ts
	 * OpenerFacts): the active document's, or for a popup's first
	 * navigation its creator's
	 */
	coop?: [boolean, string, string, string];
	/**
	 * the hint is another site's document carrying `coop` for a window no
	 * worker controls: nothing else of it is the initiator's
	 */
	coopOnly?: boolean;
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
	  }
	| {
			/** the devices of `kind` the site was granted (src/server/permissions.ts deviceGrants) */
			op: 'devices';
			kind: DeviceKind;
	  }
	| {
			/** the site chose `key` in the browser's chooser; `services`: a Bluetooth device's */
			op: 'grant';
			kind: DeviceKind;
			key: string;
			services?: string[];
	  }
	| {
			/** the site forgets `key`; answers whether another site still holds it */
			op: 'forget';
			kind: DeviceKind;
			key: string;
	  }
	| {
			/**
			 * what the browser keeps of FedCM sign-ins for the document and
			 * the provider of `idp` (an origin): an IdentityState
			 */
			op: 'identity';
			idp: string;
	  }
	| {
			/**
			 * a FedCM sign-in ended (src/server/identityStates.ts): `signedIn`
			 * with `account` (chosen in the chooser, or `auto`); `closed`: the
			 * user closed the chooser; `prevent`: preventSilentAccess();
			 * `disconnected`: `account` was disconnected
			 */
			op: 'identityDone';
			idp: string;
			how: 'chosen' | 'auto' | 'closed' | 'prevent' | 'disconnected';
			account?: string;
	  }
	| {
			/**
			 * the account chooser, which the host's page draws: the index
			 * picked, IDENTITY_CLOSED or IDENTITY_GONE
			 */
			op: 'identityChooser';
			idp: string;
			accounts: IdentityChooserAccount[];
	  };
/** what the browser keeps of a site's FedCM sign-ins with one provider (PermissionOp `identity`) */
export interface IdentityState {
	/** the accounts signed in with before, the latest first */
	accounts: string[];
	/** no auto re-authentication now: one was made lately, or preventSilentAccess() */
	quiet: boolean;
	/** the user closed a chooser of this site lately: every request fails */
	cooldown: boolean;
	/** Config.fedcmTesting: no delays */
	testing: boolean;
}
/** an account the chooser shows (IdentityChooserRequest) */
export interface IdentityChooserAccount {
	name: string;
	email: string;
	/** a new account: the chooser says what is shared, and the links */
	signUp: boolean;
	privacyPolicy?: string;
	termsOfService?: string;
}
/** the account chooser of a document's FedCM request, for the host's page to draw */
export interface IdentityChooserRequest {
	/** the document that asks (the frame the chooser is drawn over) */
	client: string;
	/** the relying party's top-level host and the provider's, as Chrome's title names them */
	site: string;
	idp: string;
	accounts: IdentityChooserAccount[];
}
/** the chooser's answer when the user closed it */
export const IDENTITY_CLOSED = -1;
/** the chooser's answer when the document went away first */
export const IDENTITY_GONE = -2;
/** the device APIs whose grants each site keeps */
export type DeviceKind = 'usb' | 'hid' | 'serial' | 'bluetooth';
/** a device a site was granted: the key the inject made of it, and a Bluetooth device's services */
export interface DeviceGrant {
	key: string;
	services: string[];
}
/**
 * The service worker's route under an address where a worker of a proxied
 * site asks what a document asks with PERMISSION (a worker has no
 * navigator.serviceWorker to post to): a POST of the PermissionOp with
 * `site`, the worker's top-level origin as its route names it. Only
 * `states`, `devices` and `forget`.
 */
export const PERMISSION_ROUTE = 'permission';
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
 * A proxied document's WebAuthn ceremony (docs/passkeys.md), with the port
 * its answer comes on. The worker takes the document's origin and its
 * top's from the sender's own routed URL and client, checks the relying
 * party id against them, asks the controller's host to have the user
 * confirm, and makes or signs with the key it holds: the page gets only
 * the answer, on its port.
 */
export const PASSKEY = '$stomp$passkey';
export type PasskeyMessage = { directory: string } & PasskeyOp;
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
	/**
	 * a document the page made in a Blob the inject never read (a slice, a
	 * Blob of Blobs, a Response's): the Blob, or the browser's blob: URL of
	 * one another realm minted, read by the worker in place of the markup
	 */
	blob?: Blob | string;
	/** that Blob's document is cross-origin isolated, as its creator is (it inherits the creator's embedder policy) */
	isolated?: boolean;
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
	/** dropped by Clear-Site-Data: the documents read it again, and no storage event fires */
	quiet?: boolean;
}

export interface ControllerInitMessage {
	directory: string;
	config: Config;
	/** the controller bundle's build id (src/version.ts) */
	build: string;
	/**
	 * An offer for a worker that does not know this controller (one the
	 * browser stopped): a worker that has it registered declines it
	 * (STANDBY_DECLINED), closes the ports and keeps the channel it has
	 */
	standby?: boolean;
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
	/**
	 * The site pool (ControllerInit.sitePool): the codec key of the host's own
	 * worker, which every slot's worker takes, so a route decodes on every
	 * slot's origin
	 */
	codecKey?: string;
	/**
	 * the site pool: this worker's origin is a slot. The handshake's third
	 * port (after the rpc's and the transport's) asks the host's cookie jar
	 * (src/server/jarDB.ts), the fourth the hub's worker's blocker: a slot's
	 * worker builds no engine of its own (src/server/remoteBlocker.ts)
	 */
	slot?: boolean;
	/**
	 * the site pool: how many slots it has. Their workers run in one
	 * process, so what a worker keeps in memory between documents (the
	 * memory cache, MemoryCache.share, and the rewriter instance's memory)
	 * is shared out between them
	 */
	slots?: number;
	/**
	 * the site pool: this worker's controller is the hub (its origin is no
	 * slot): a navigation to a document of a site whose slot is up leaves
	 * for that slot, as from a slot's worker
	 */
	pooled?: boolean;
	/**
	 * the StompController instance's own random name, the same in each of
	 * its handshakes: a worker that has a registration at the address with
	 * this name (from the same client) is hearing that controller again over
	 * a new channel, and lets the old one finish what is in flight on it
	 * rather than replace it
	 */
	token?: string;
}

/**
 * The site pool: what the worker of the slot a navigation leaves knew of
 * it, handed to the worker of the slot it goes to before the browser is sent
 * there (the browser narrows the referrer to the first slot's origin across
 * the real redirect, and the first worker's memory is its own). Paths are
 * the routed URL's path and query, the same on every slot's origin.
 */
export interface SiteArrival {
	/** the routed path the navigation arrives at */
	path: string;
	/** the routed path of the document that started it (its referrer), when known */
	referrer?: string;
	/** the navigation's referrer policy */
	policy?: string;
	/** the navigation hint the document that started it sent (navigationHints.ts) */
	hint?: unknown;
	/** the redirect chain so far, when the navigation is a hop of one (rewrites.ts RedirectHop) */
	hop?: unknown;
	/**
	 * what the documents that started the navigation told of it
	 * (navigationHints.ts NavigationChain): the page policies that judge its
	 * later hops (a form's form-action, a frame's parent's frame-src: each
	 * with whether it is the parent's), a frame's real ancestors and the
	 * policy its csp attribute requires, and a top-level navigation's
	 * opener policy facts (src/coop.ts), kept by the real URL the chain
	 * began at
	 */
	chain?: {
		start: string;
		policies: [unknown, boolean][];
		ancestors?: string[];
		required?: string;
		coop?: unknown;
		/** the hop that arrives was judged by them already (the first slot's worker told the documents of it) */
		judged?: boolean;
	};
	/**
	 * Visited links (src/visited.ts, src/server/visitedHops.ts): `hop`, the
	 * visit the navigation makes, when it began at a link route; `back`, for
	 * a link route of a context this slot shows that another slot's worker
	 * sent the navigation through, where the browser goes on to from there
	 */
	visited?: { hop?: unknown; back?: string };
	/** what the first worker knew of the navigation's parent and main frame (src/server/siteContext.ts) */
	context?: SiteContext;
	/**
	 * the document that started the navigation from another window's realm
	 * (src/server/navigationHints.ts NavigationInitiator, its referrer the
	 * routed path)
	 */
	initiator?: unknown;
}

/**
 * The site pool: what a frame's navigation needs of the documents above it,
 * which the worker of the slot it goes to never served (its parent and its
 * main frame are another slot's): their client hints documents (each with
 * its permissions policy and the features it may use) and the main frame's
 * accepted hints and viewport (src/server/clientHints.ts departingHints),
 * and whether the parent upgrades insecure requests
 */
export interface SiteContext {
	hints?: {
		parent?: unknown;
		top?: unknown;
		accepted?: unknown;
		viewport?: unknown;
	};
	upgradeInsecure?: boolean;
}

/** controller -> SW: the wasm modules' bytes, when they were not loaded at the handshake */
export const CONTROLLER_MODULES = '$stomp$controllerModules';
/**
 * the hub's controller of a site pool -> its own SW: answer
 * the blocker questions of a slot's worker on the port it carries
 * (src/server/remoteBlocker.ts)
 */
export const BLOCKER_SERVE = '$stomp$blockerServe';
export interface BlockerServeMessage {
	directory: string;
}
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
	/**
	 * the controller shook hands again over another channel: this one
	 * answers what is in flight on it, then the worker closes it
	 */
	retire: [];
	/** resolve a URL against the controller's config into a routed (proxied) URL */
	route: [string, string];
	/** the host navigates a frame of its own to this routed URL now (a typed address): no document's hint is coming */
	typed: [string];
	/** the real URL a routed one stands for (the controller's codec); null for anything that is not a route */
	unroute: [string, string | null];
	/** drop every entry of the HTTP cache */
	clearCache: [];
	/**
	 * the site pool: forget the device ids of every origin of this origin's
	 * host (of every origin without one), as a cleared jar does in the hub's
	 * worker (the ids are each slot's own)
	 */
	forgetDeviceIds: [string | undefined];
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
	 * clear a site's virtualized storage on the proxy origin (localStorage,
	 * sessionStorage, IndexedDB, Cache Storage): the "Forget me when I close
	 * this site" shield, once its last tab closes (src/server/Storage.ts)
	 */
	forgetStorage: [string];
	/** the host reading or forgetting the passkeys this worker holds (docs/passkeys.md) */
	passkeys: [PasskeyCommand, PasskeyInfo[] | boolean | null];
	/**
	 * whether the built-in blocker's lists block a WebSocket to `url` opened
	 * under `source` (the Origin its handshake carries, '' when it has none):
	 * the controller asks from its handshake hook, since a socket never passes
	 * the service worker (docs/adblock.md). False while no engine answers.
	 */
	socket: [
		{
			url: string;
			source: string;
			/** a WebTransport session (an https URL) rather than a WebSocket */
			type?: 'webtransport';
		},
		boolean,
	];
	/**
	 * which of these clients no longer exist: the controller forgets the
	 * frame it kept for each (the request log's attribution)
	 */
	goneClients: [string[], string[]];
	/**
	 * the per-site shields (the demo's content-blocker UI): the whole
	 * host-keyed allowlist, which the worker's server consults before each
	 * privacy layer runs for a host (src/server/shields.ts). Replaces what
	 * it held, and travels with every handshake as the rules do. `seed` is the
	 * controller's persisted anti-fingerprint farbling seed (src/controller/id.ts),
	 * so a site's noise is stable across this worker restarting; a plain array is
	 * accepted too (a caller that sends no seed).
	 */
	shields: [{ list: SiteShields[]; seed?: number } | SiteShields[]];
	/**
	 * change the built-in blocker's lists at runtime (the demo's Filter Lists
	 * editor, docs/adblock.md): the controller re-resolves the `AdblockInit` and
	 * the worker rebuilds the engine in place, serving the old lists until the
	 * new ones compile. `refresh` re-fetches even unchanged lists ("Update
	 * lists"). Travels with every handshake too, as the init's `adblock` does
	 */
	adblock: [{ init: AdblockInit; refresh?: boolean }];
	/** the site pool: the key of this worker's codec (the host's, for every slot's worker) */
	codecKey: [undefined, string];
	/** the site pool: the site of a URL, by this worker's public suffix list */
	siteOf: [string, string];
	/** the site pool: a navigation from another slot's worker is on its way here */
	arrive: [SiteArrival];
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
	/** `initiator`: the origin asking (a WebSocket handshake), so SameSite applies; absent means the host, which gets everything. `partitionKey`: the asking context is in that top-level site's partition (SOCKET_PARTITION). `header`: the Cookie field's bytes (Cookies.ts header()) rather than the text document.cookie reads */
	| {
			op: 'get';
			url: string;
			initiator?: string;
			partitionKey?: string;
			header?: boolean;
	  }
	| { op: 'set'; url: string; setCookie: string | string[] }
	| { op: 'list'; origin?: string }
	| { op: 'clear'; origin?: string };

export type CookieResult = string | CookieRecord[] | undefined;

/** a failure the proxy produced: the transport could not reach the origin, the worker's timeout, a routing error, a blocked rule */
/** `controller`: the address names a controller that is gone and no live one of its codec can take over */
export type RequestErrorKind =
	'transport' | 'timeout' | 'routing' | 'blocked' | 'controller';

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
	/**
	 * the worker took the handshake: sent at once, before the server it
	 * creates for the controller is up (`ready`), with the worker's name for
	 * this run of it (ReviveMessage.instance)
	 */
	hello: [{ instance: string }];
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
	/**
	 * what the browser makes of cross-origin isolation where engines differ
	 * (src/isolation.ts IsolationEngine), asked of it by frames of the
	 * controller's document (src/controller/isolationProbe.ts); null: it
	 * could not tell
	 */
	isolationEngine: [undefined, IsolationEngine | null];
	/**
	 * a proxied site's WebAuthn ceremony, checked by the worker, for the
	 * host to ask the user about: its answer (PasskeyAnswer) or null. The
	 * port hears PASSKEY_CANCEL when the page gives up
	 * (src/passkeys/authenticator.ts)
	 */
	passkeyPrompt: [{ request: PasskeyPrompt; port: MessagePort }, unknown];
	/**
	 * the site pool: whether the focus is in the page of the frame the
	 * document `client` is in (a ceremony's focus check, whose top may be a
	 * document of another slot)
	 */
	passkeyFocused: [string, boolean];
	/**
	 * a proxied site's FedCM account chooser, which the host's page draws
	 * over the document's frame: the index of the account picked,
	 * IDENTITY_CLOSED or IDENTITY_GONE. The port closes when the document
	 * goes away
	 */
	identityChooser: [
		{ request: IdentityChooserRequest; port: MessagePort },
		number,
	];
	/**
	 * the site pool: the slot `site` is shown from (its origin), given one
	 * now when it has none; null without a pool
	 */
	siteSlot: [string, string | null];
	/**
	 * a slot of the site pool: a new port to the hub's worker's blocker
	 * (the one before closed or went silent); null when there is none
	 */
	blockerPort: [undefined, MessagePort | null];
	/**
	 * the site pool: a navigation leaves for `site`, which another slot
	 * shows; the controller makes sure that slot's worker is up, hands it
	 * `arrival` and answers with its origin (null: the navigation stays
	 * where it is)
	 */
	crossSite: [{ site: string; arrival: SiteArrival }, string | null];
	/**
	 * the site pool, to the hub: the slot of `site` sent a navigation back
	 * to the hub's origin (its agent is gone); the hub leaves it out
	 */
	siteHomed: [string, boolean];
};

/** a transport's response on its way to a RemoteTransport: a streamed body travels on a port of its own (bodyPort.ts) */
export type WireResponse =
	| TransferrableResponse
	| (Omit<TransferrableResponse, 'body'> & { body: PortBody });

/**
 * A raw stream over wisp (a UDP stream to one remote, one datagram per
 * message; a TCP or TLS connection, one chunk per message) on a port of its
 * own, for the WebRTC worker (docs/webrtc-over-wisp.md). `data` carries an
 * ArrayBuffer, transferred; `close` ends it from either side.
 */
export type StreamMessage =
	{ type: 'data'; data: ArrayBuffer } | { type: 'close'; reason?: string };

/**
 * A page's WebTransport session on a port of its own
 * (docs/webtransport.md). `id` names a stream: the page numbers the ones
 * it opens from 1 up, the host the server's from -1 down. Buffers are
 * transferred. The page asks for each chunk it reads (`p`) and the host
 * acknowledges each one written once QUIC took it (`a`), so the browser's
 * backpressure is QUIC's flow control on both sides.
 */
export type WebTransportMessage =
	// page -> host
	/** a datagram to send */
	| { t: 'd'; b: ArrayBuffer }
	/** open a stream (bidirectional unless `uni`) */
	| { t: 'o'; id: number; uni?: boolean }
	/** write a chunk to a stream; acknowledged with `a` */
	| { t: 'w'; id: number; b: ArrayBuffer }
	/** finish a stream's sending side; acknowledged with `a` */
	| { t: 'f'; id: number }
	/** reset a stream's sending side (`r`) or stop its receiving side (`s`) with a WebTransport code */
	| { t: 'r' | 's'; id: number; code: number }
	/** the page's reader took every chunk of this stream it was sent (the host reads ahead of it at most 256 KiB) */
	| { t: 'p'; id: number }
	/** close the session */
	| { t: 'c'; code: number; reason: string }
	// host -> page
	/** a write or a finish of this stream is done (`a`); the stream the page opened is open (`n`) */
	| { t: 'a' | 'n'; id: number }
	/** a stream the server opened */
	| { t: 'i'; id: number; uni?: boolean }
	/** a chunk of a stream as it arrived, or (no `b`) its end */
	| { t: 'b'; id: number; b?: ArrayBuffer }
	/**
	 * a stream failed: its sending side (`w`, STOP_SENDING) or its
	 * receiving side (RESET_STREAM), with the peer's WebTransport code (0
	 * for one that is no WebTransport code), or none (the session is gone)
	 */
	| { t: 'e'; id: number; w?: boolean; code?: number }
	/** a datagram that arrived */
	| { t: 'D'; b: ArrayBuffer }
	/** the session ended cleanly: the server's close, or the page's own */
	| { t: 'Z'; code: number; reason: string }
	/** the session's connection was lost */
	| { t: 'L' };

/** implemented by the transport host, called by RemoteTransport */
export type TransportToHost = {
	/** a wisp UDP stream to `host:port` on `port`; fails when the transport has no UDP (libcurl) or the server refuses it */
	udp: [
		{ host: string; port: number; stream: MessagePort },
		{ result: 'success' } | { result: 'failure'; error: string },
	];
	/** a wisp TCP stream to `host:port` (TLS through the transport's own stack when `tls`) on `port` */
	tcp: [
		{ host: string; port: number; tls: boolean; stream: MessagePort },
		{ result: 'success' } | { result: 'failure'; error: string },
	];
	/**
	 * a WebTransport session to `url` (https) for a page of `origin`, served
	 * on `port` (WebTransportMessage) once it is up. `hashes` are the
	 * SHA-256 values of the page's serverCertificateHashes. Fails when the
	 * transport has no UDP or no WebTransport client, the content blocker
	 * refuses it, or the handshake fails
	 */
	webtransport: [
		{
			url: string;
			origin: string;
			protocols: string[];
			/** the page's own (Chrome 157 on): checked, lower case, sorted */
			headers: [string, string][];
			hashes: ArrayBuffer[];
			port: MessagePort;
		},
		(
			| { result: 'success'; protocol: string; maxDatagramSize: number }
			| { result: 'failure'; error: string }
		),
	];
	/**
	 * a request waiting for a connection (named in its REQUEST_QUEUE field):
	 * cancelled (the page gave it up) or raised (an image the page laid out
	 * in its viewport)
	 */
	requeue: [{ id: string; op: 'cancel' | 'raise' }, void];
	/**
	 * serve the transport on `port` too, as this port is served: a worker
	 * hands its own workers one this way (no worker can ask a service
	 * worker for one, Chrome 157 gives it no container)
	 */
	serve: [MessagePort, void];
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
	/** the request the worker named `id` (an image's) waits for a connection (socketPool.ts) */
	waiting: [string];
};

/** rpc id on the controller <-> transport worker channel (the Worker's own) */
export const TRANSPORT_WORKER_RPC = 'stomp-transport-worker';

/** what the transport worker constructs: a module URL and constructor arguments */
export interface TransportModule {
	module: string;
	options?: unknown[];
	/** TransportDescriptor.http3 */
	http3?: boolean | Http3DescriptorOptions;
	/** TransportDescriptor.webTransport */
	webTransport?: boolean | WispWebTransportOptions;
}

/** implemented by the transport worker (src/transport/worker.ts), called by the controller */
export type WorkerBound = {
	/** the verbose mode (transportLog.ts) on or off, sent before `init` */
	debugTransport: [boolean];
	/** import the module and construct the transport; rejects with the import or constructor error */
	init: [TransportModule];
	/** replace the transport; in-flight requests finish on the old one */
	setTransport: [TransportModule];
	/** serve the transport to the RemoteTransport on this port (the service worker's, a page's, the host's) */
	serve: [MessagePort];
	/**
	 * serve as `serve` does, and ask `decorate` (an RpcHelper port speaking
	 * WorkerToController) for the handshake headers instead of the
	 * controller (the site pool: a slot's controller answers)
	 */
	serveDecorated: [{ port: MessagePort; decorate: MessagePort }];
	/** the site pool: answer a slot's worker's cookie jar requests on this port (jarServer.ts) */
	serveJar: [MessagePort];
	/** the site pool: the host changed the jar for a domain ('' for all); every slot's worker hears */
	jarChanged: [string];
	/** the controller's page is back from the back/forward cache: Chrome closed the wisp WebSocket (RevivingTransport) */
	connectionLost: [];
};

/**
 * The message of the error a WebSocket handshake hook rejects with to refuse
 * the socket (serveTransport's `decorate`, and WorkerToController.decorate,
 * whose rejection crosses the rpc by its message): the connection fails
 * before anything is opened on the transport. Any other rejection, and a
 * hook that stalls, leave the handshake as the page sent it.
 */
export const HANDSHAKE_REFUSED = '$stomp$handshakeRefused';

/**
 * The header the inject adds to a WebSocket handshake of a context in a
 * partition, naming its top-level site (src/partition.ts partitionSite):
 * the controller's decorate hook reads it for the jar (that context's
 * Partitioned cookies, and no SameSite=Lax or Strict ones, as natively),
 * and serveTransport removes it, so it never goes out
 */
export const SOCKET_PARTITION = '$stomp$partition';

/** implemented by the controller, called by the transport worker */
export type WorkerToController = {
	/** the headers a WebSocket handshake goes out with (the controller adds the jar's Cookie); rejects with HANDSHAKE_REFUSED to refuse the socket */
	decorate: [{ url: string; headers: RawHeaders }, RawHeaders];
	/** whether a page of `origin` may open a WebTransport session to `url` (false: the built-in blocker's lists refuse it) */
	admit: [{ url: string; origin: string }, boolean];
	/** KEEPALIVE_MS went by: the controller keeps the service worker running */
	tick: [];
	/** the transport chose what its wisp connection rides (wispWebTransport.ts watchCarrier) */
	carrier: [CarrierInfo];
	/** a line for the host's console (transportLog.ts) */
	transportNote: [TransportNote];
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
