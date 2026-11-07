import type { Assets, Config, ConfigCodec } from '../config';
import { type HelperNames } from '../helperNames';
import { type HookErrorInfo, type InitHooks } from '../hooks';
import type { NavigateInfo, RequestInfo, RequestRule } from '../transport/messages';
import { CookieJar } from './index';
import { StaleInfo, TransportDescriptor } from './messages';
export interface RemoteControllerInit {
    /** origin that serves dist/ and the proxied content, e.g. https://proxy.example.com */
    proxyOrigin: string;
    /** pathname of dist/ on that origin, default `/stomp/` */
    directory?: string;
    /**
     * the controller's id (see ControllerInit.id): minted here when omitted and
     * handed to the controller frame, so the host knows the address its frames
     * load from and can store it per tab
     */
    id?: string;
    /**
     * the transport, described: the controller frame instantiates it on the
     * proxy origin, in its transport worker unless `host: 'page'`
     */
    transport: TransportDescriptor;
    codec?: ConfigCodec;
    /**
     * sandbox flags for proxied frames. The default keeps scripts, forms,
     * popups, modals and downloads and deliberately omits top navigation so a
     * page can never navigate the host.
     */
    sandbox?: string;
    /** how often (ms) to refresh url/title of frames; 0 disables */
    pollInterval?: number;
    /**
     * Called when a proxied page wants a new tab (`window.open`, a link with
     * `target="_blank"` or a name, a modifier click). The page's `window.open`
     * then returns null, like a popup blocker. Without it, popups open
     * natively as bare proxied tabs.
     */
    onOpen?: (url: string, frame: RemoteFrame) => void;
    /**
     * Called whenever a proxied page reports where it is (load, pushState,
     * hashchange, title change); the same information arrives as a
     * `navigate` CustomEvent on the RemoteFrame (`event.detail`). The poll
     * (`pollInterval`) stays as a fallback and can be disabled with 0.
     */
    onNavigate?: (info: NavigateInfo, frame: RemoteFrame) => void;
    /** HTTP cache in the service worker, on by default; `false` turns it off (see StompController) */
    cache?: boolean;
    /** a script the rewriter cannot parse fails instead of running raw when `false` (see StompController) */
    allowInvalidJs?: boolean;
    /** request rules run in the service worker (see StompController) */
    rules?: RequestRule[];
    /** the served file names, when the host renamed them (see StompController) */
    assets?: Assets;
    /** the deployment's helper names (see StompController.names) */
    names?: Partial<HelperNames>;
    /** host code for every proxied realm (see StompController.hooks); a `{ url }` must be readable from the proxy origin, where the controller frame fetches it */
    hooks?: InitHooks;
    /** a host hook threw in a proxied realm, or a hook URL failed (see StompController) */
    onHookError?: (info: HookErrorInfo) => void;
    /**
     * The host's own page for a document the proxy failed to produce (see
     * StompController): a path on the proxy origin, where the worker runs,
     * so in this mode the page must be served from the proxy host.
     */
    errorPage?: string;
    /** one report per proxied request, with the RemoteFrame when known (see StompController.onRequest) */
    onRequest?: (info: RemoteRequestEvent) => void;
}
/** a RequestInfo with the frame it belongs to, when the page reported its client id */
export interface RemoteRequestEvent extends RequestInfo {
    frame: RemoteFrame | null;
}
export declare const DEFAULT_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";
/**
 * Events, as on StompController: `navigate`, `open`, `request` alongside the
 * callbacks; `stale` (detail: StaleInfo) when the
 * controller frame's service worker is another build than its controller
 * and could not be replaced in time, `rebind` once the builds agree again.
 */
export declare class RemoteController extends EventTarget {
    #private;
    proxyOrigin: string;
    /** the scope on the proxy origin; the controller's address is `config.directory` */
    directory: string;
    /** the controller's id (ControllerInit.id), known before the frame answers */
    id: string;
    /** the build this host-side bundle came from (see StompController.build); the controller frame's is `config.build` once it answered */
    readonly build: string;
    config?: Config;
    /** the inner controller's `stale` (see StompController); null while the builds agree */
    stale: StaleInfo | null;
    frames: RemoteFrame[];
    isReady: boolean;
    readonly element: HTMLIFrameElement;
    constructor(init: RemoteControllerInit);
    wait(): Promise<void>;
    route(url: string): Promise<string>;
    /** the real URL a routed one stands for, null for a non-route (see StompController.unroute) */
    unroute(url: string): Promise<string | null>;
    /** replace the request rules (see StompController.setRules) */
    setRules(rules: RequestRule[]): Promise<void>;
    /** drop every entry of the service worker's HTTP cache */
    clearCache(): Promise<void>;
    /** the cookie jar, for the host application only (see StompController.cookies) */
    readonly cookies: CookieJar;
    setTransport(transport: TransportDescriptor): Promise<void>;
    createFrame(element?: HTMLIFrameElement): RemoteFrame;
}
/**
 * A proxied frame on the proxy origin. Dispatches `navigate` (CustomEvent,
 * `detail` is a NavigateInfo) whenever the page reports a new URL, title or
 * history state; the fields below follow the reports and the poll.
 */
export declare class RemoteFrame extends EventTarget {
    #private;
    controller: RemoteController;
    element: HTMLIFrameElement;
    /** last known real URL of the page, from the page's reports and the poll */
    url: string | null;
    /** last known document title */
    title: string | null;
    /** last known: whether the frame's own history has an entry before/after the current one; null when unknown */
    canGoBack: boolean | null;
    canGoForward: boolean | null;
    constructor(controller: RemoteController, element: HTMLIFrameElement, sandbox: string);
    /** navigate the frame; resolves when the new document first reports (see Frame.go) */
    go(url: string): Promise<void>;
    /**
     * Step the frame's own history, relayed through the controller frame.
     * Resolves false when there is no entry in that direction (the frame's
     * history is never allowed to walk the host page).
     */
    back(): Promise<boolean>;
    forward(): Promise<boolean>;
    /** reload the frame; resolves when the reloaded document first reports (false when there was nothing to reload) */
    reload(): Promise<boolean>;
    /** fetch the current url/title from the controller frame */
    refresh(): Promise<void>;
}
