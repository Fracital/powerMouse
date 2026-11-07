import type { Assets, Config, ConfigCodec } from '../config';
import type { HelperNames } from '../helperNames';
import type { HookErrorInfo, InitHooks } from '../hooks';
import type { CookieCommand, CookieResult, RequestInfo, RequestRule } from '../transport/messages';
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
    /** the host wants a RequestInfo per request (RemoteControllerInit.onRequest) */
    requestLog?: boolean;
    /** unparseable scripts fail instead of running raw (RemoteControllerInit.allowInvalidJs) */
    allowInvalidJs?: boolean;
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
}
export interface FrameInfo {
    url: string | null;
    title: string | null;
    /** whether the frame's own history has an entry before/after the current one; null when the browser cannot tell */
    canGoBack: boolean | null;
    canGoForward: boolean | null;
}
export type FrameCommand = 'back' | 'forward' | 'reload';
/** rpc id on the host <-> controller-frame postMessage channel */
export declare const REMOTE_RPC = "stomp-remote";
/** implemented by the controller frame, called by the host */
export type FrameBound = {
    init: [ControllerFrameInit, {
        config: Config;
        stale: StaleInfo | null;
    }];
    route: [string, string];
    /** the real URL a routed one stands for, null for a non-route (see StompController.unroute) */
    unroute: [string, string | null];
    setTransport: [TransportDescriptor];
    /** frames are addressed by their index in the host window's `frames` list */
    frameInfo: [number, FrameInfo];
    /** resolves to whether the command was carried out (false: nothing to go back/forward to) */
    frameCommand: [{
        index: number;
        command: FrameCommand;
    }, boolean];
    clearCache: [];
    cookies: [CookieCommand, CookieResult];
    /** replace the request rules */
    rules: [RequestRule[]];
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
    /** a host hook threw in a proxied realm, or a hook URL could not be fetched */
    hookError: [HookErrorInfo];
};
