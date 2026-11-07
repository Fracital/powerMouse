import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { Assets, Config, ConfigCodec } from '../config';
import { type HelperNames } from '../helperNames';
import { type HookErrorInfo, type InitHooks } from '../hooks';
import { urlLike } from '../StompURL';
import type { RequestRule } from '../transport/messages';
import { CookieRecord, NavigateInfo, RequestInfo } from '../transport/messages';
import type { StaleInfo, TransportDescriptor } from './messages';
export { default as SearchBuilder } from '../bootstrapper/SearchBuilder';
export type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
export type { Config, ConfigCodec } from '../config';
export { RemoteController, RemoteFrame, DEFAULT_SANDBOX } from './remote';
export type { RemoteControllerInit } from './remote';
export type { TransportDescriptor, FrameInfo } from './messages';
export type { NavigateInfo, CookieRecord, RequestInfo, } from '../transport/messages';
export interface ControllerInit {
    /**
     * The registered Stomp service worker, or its registration (from
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
     * passed again replaces the earlier controller. A host that keeps tabs
     * stores one id per tab (sessionStorage) and passes it back, so the tab's
     * history entries, reloads and copied links keep resolving.
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
    /**
     * Called once per proxied request with what the service worker saw: real
     * URL, method, destination, status, time, whether the cache answered, the
     * size, an error, and the Frame it belongs to when known. Nothing is
     * built or sent when unset.
     */
    onRequest?: (info: RequestEvent) => void;
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
     * Request rules, run in the service worker on the real URL: block, answer
     * with a status, redirect, or edit request and response headers; the
     * first matching rule wins. `setRules()` replaces them later.
     */
    rules?: RequestRule[];
    /**
     * The served file names, when the host renamed them (see Assets): the
     * inject bundles the worker names in its shell. A same-origin host
     * registers the worker itself, so `serviceWorker` only documents its choice.
     */
    assets?: Assets;
    /**
     * The four global names the rewriter and the inject bundles use (see
     * HelperNames): a deployment's own, when the host set them. Each must be
     * an identifier no plain window has; the controller throws a TypeError
     * otherwise. Defaults: `$s$j`, `$s$L`, `$s$N`, `$P$s`.
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
    /** a host hook threw in a proxied realm (or a hook URL failed); also the `hookerror` CustomEvent */
    onHookError?: (info: HookErrorInfo, frame: Frame | null) => void;
    /**
     * The host's own page for a document the proxy failed to produce (the
     * transport could not reach the origin, the worker's timeout, a routing
     * error, a blocked rule, the refusal to proxy its own origin): a URL on
     * this origin, resolved against the page. Served under the frame's routed
     * URL with the failure's status, never cached, with
     * `globalThis.stompError = { url, status, error, kind }` in its head;
     * `location.reload()` retries. Without it the built-in pages answer.
     */
    errorPage?: string;
    /**
     * sandbox flags for proxied frames, default `DEFAULT_SANDBOX`. Same-origin
     * frames are not a security boundary, but without a sandbox the browser
     * lets `<a target="_top">`, `<form target="_parent">` and
     * `window.open(url, '_top')` navigate the host page. `null` disables it.
     */
    sandbox?: string | null;
}
/** a RequestInfo with the frame it belongs to, when the page reported its client id */
export interface RequestEvent extends RequestInfo {
    frame: Frame | null;
}
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
/** a navigate report posted by a proxied page, else null */
export declare function navigateReport(data: unknown): NavigateInfo | null;
/** a hook error report posted by a proxied page, else null */
export declare function hookErrorReport(data: unknown): HookErrorInfo | null;
/** the URL of an open request posted by a proxied page, else null */
export declare function openRequest(data: unknown): string | null;
/** how long go() and reload() wait for the new document's first report before resolving anyway */
export declare const NAVIGATION_WAIT_MS = 30000;
/** how long after the frame's load event they wait for a report that may never come (a document nothing injected) */
export declare const REPORT_GRACE_MS = 1000;
/** how long register() and the constructor wait for a worker to activate before going on with what there is */
export declare const REGISTER_WAIT_MS = 30000;
/** resolves once the worker is activated; rejects when it becomes redundant */
export declare function activated(worker: ServiceWorker): Promise<ServiceWorker>;
export type { StaleInfo };
/** the build this controller bundle came from (version plus commit, or the package version); `controller.build` carries it too */
export { BUILD } from '../version';
export type { Assets } from '../config';
export { DEFAULT_ASSETS } from '../config';
export type { HelperNames } from '../helperNames';
export type { HookContext, HookErrorInfo, HookScript, InitHooks, } from '../hooks';
export { DEFAULT_NAMES } from '../helperNames';
export type { RequestRule, RequestRuleAction, RequestRuleMatch, } from '../transport/messages';
/**
 * Owns the transport and registers itself with the service worker.
 * Proxied content lives in frames created by `createFrame()`.
 */
/**
 * Events: `stale` (detail: StaleInfo) when the handshake met a service worker
 * of another build that could not be replaced in time, `rebind` (detail:
 * `{ build }`) when a later handshake agrees again, and `transporthost`
 * (detail: `{ host: 'page', error }`) when the transport worker could not
 * host a descriptor and the page took over.
 */
export declare class StompController extends EventTarget {
    #private;
    config: Config;
    /**
     * set while the service worker serving this controller is another build
     * than the controller (a deploy the browser has not finished installing);
     * null once the builds agree
     */
    stale: StaleInfo | null;
    /** the directory the host gave: the service worker's scope and the asset base (`config.scope`) */
    directory: URL;
    /** this controller's id; its address is `config.directory` (`directory` + id + `/`) */
    id: string;
    /** the build this controller bundle came from (STOMP_BUILD: version plus commit, or the package version); the worker's build is `config.build`, and `stale` says when the two differ */
    readonly build: string;
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
    frames: Frame[];
    isReady: boolean;
    /** every hook error so far (a hook that threw, a hook URL that failed), newest last; also `hookerror` events */
    readonly hookErrors: HookErrorInfo[];
    private lastHandshake;
    /**
     * Register the Stomp service worker served from `directory` (the
     * constructor's default when omitted: the directory of the current script)
     * and resolve once it is activated. The registration goes straight into
     * `serviceworker` of the constructor.
     */
    static register(directory?: urlLike, options?: {
        /** the served file names, when the host renamed them */
        assets?: Assets;
        /** passed to `navigator.serviceWorker.register`; `none` by default */
        updateViaCache?: ServiceWorkerUpdateViaCache;
    }): Promise<ServiceWorkerRegistration>;
    constructor(init: ControllerInit);
    /**
     * Talk to another service worker from now on (default: the registration's
     * active worker) and shake hands again; the next ready answer settles
     * `wait()` as usual. Hosts that update the worker themselves call this
     * instead of reaching into the controller.
     */
    rebind(worker?: ServiceWorker): Promise<void>;
    /** resolves once the service worker has created a server for this controller */
    wait(): Promise<void>;
    /**
     * Hot-swap the transport; in-flight requests finish on the old one. The
     * argument matches `transportHost`: a TransportDescriptor for a
     * worker-hosted transport (the worker imports and constructs it), a
     * ProxyTransport instance for a page-hosted one; the other kind is a
     * TypeError.
     */
    setTransport(transport: ProxyTransport | TransportDescriptor): Promise<void>;
    /** replace the request rules the service worker applies (see ControllerInit.rules) */
    setRules(rules: RequestRule[]): Promise<void>;
    /** drop every entry of the service worker's HTTP cache */
    clearCache(): Promise<void>;
    /**
     * The cookie jar, for the host application only (pages never reach this
     * port): read what the proxy would send, import Set-Cookie headers,
     * export records, or wipe an origin.
     */
    readonly cookies: CookieJar;
    /** the proxied URL a frame should navigate to in order to load `url` */
    route(url: string): Promise<string>;
    /**
     * The real URL a routed one stands for (the inverse of `route()`, with
     * this controller's codec), or null for anything that is not a route: a
     * host reading a routed URL off a frame or a report never has to parse
     * one itself.
     */
    unroute(url: string): Promise<string | null>;
    createFrame(element?: HTMLIFrameElement): Frame;
}
/**
 * A proxied frame. Dispatches `navigate` (CustomEvent, `detail` is a
 * NavigateInfo) whenever the page reports a new URL, title or history state.
 */
export declare class Frame extends EventTarget {
    #private;
    controller: StompController;
    element: HTMLIFrameElement;
    /** the last report from the page, if any */
    lastNavigate: NavigateInfo | null;
    constructor(controller: StompController, element: HTMLIFrameElement, sandbox?: string | null);
    /** the last title the page reported, else the document's */
    get title(): string | null;
    /**
     * Navigate the frame. Resolves when the new document first reports (url,
     * title, history state), REPORT_GRACE_MS after the frame's load event when
     * the document is one that never reports, NAVIGATION_WAIT_MS at the most.
     * Listen for the frame's `load` before calling when you need that event.
     */
    go(url: string): Promise<void>;
    /**
     * Step the frame's own history (proxied pages are same-origin, so it is
     * reachable). Resolves false when there is no entry in that direction, so
     * a host can show its own "nothing to go back to" state instead of
     * letting history.back() walk the page that embeds the frame.
     */
    back(): Promise<boolean>;
    forward(): Promise<boolean>;
    /** whether the frame's own history has an entry before/after the current one; null when the browser cannot tell */
    get canGoBack(): boolean | null;
    get canGoForward(): boolean | null;
    /** reload the frame; resolves when the reloaded document first reports (false when there was no document to reload) */
    reload(): Promise<boolean>;
    /** the URL the frame is currently showing, if it is a proxied page */
    get url(): string | null;
}
export default StompController;
