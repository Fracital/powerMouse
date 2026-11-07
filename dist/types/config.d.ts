import GenericCodec from './Codecs';
import type { HelperNames } from './helperNames';
import type { ResolvedHooks } from './hooks';
export declare type ConfigCodec = 'generic' | 'xor' | 'aes' | 'base64';
export interface Config {
    codec: ConfigCodec;
    /**
     * pathname this controller's routes live under: the scope plus the
     * controller's id, e.g. `/stomp/k7qx2m/` (its address in the service
     * worker; every routed URL starts with it)
     */
    directory: string;
    /**
     * pathname of the directory the service worker is scoped to and the
     * bundles are served from, e.g. `/stomp/`; shared by every controller of
     * that scope, and the only thing the asset URLs are built from
     */
    scope: string;
    /**
     * Origins allowed to embed proxied documents, emitted as a
     * `Content-Security-Policy: frame-ancestors` header. Set by the controller
     * frame in origin-isolation mode so only the host application can frame
     * the proxy origin. Absent in same-origin mode.
     */
    frameAncestors?: string[];
    /**
     * The host application handles `window.open` and `target="_blank"`
     * (`onOpen` on the controller): pages post the URL to it instead of
     * opening a popup, and `window.open` returns null like a popup blocker.
     */
    openTab?: boolean;
    /**
     * HTTP cache in the service worker, on unless `false`: GET/HEAD responses
     * with explicit freshness are served from a Cache API store and
     * revalidated with ETag / Last-Modified when stale.
     */
    cache?: boolean;
    /**
     * A script the rewriter cannot parse runs as it was (default). `false`
     * makes it fail instead, with a SyntaxError naming the rewriter error, so
     * a broken rewrite is loud while developing.
     */
    allowInvalidJs?: boolean;
    /** the served file names, when the host renamed them (see Assets) */
    assets?: Assets;
    /**
     * The four global names the rewriter and the inject bundles use (see
     * HelperNames): a deployment's own, when the host set them. Each must be
     * an identifier no plain window has; the controller throws a TypeError
     * otherwise. Defaults: `$s$j`, `$s$L`, `$s$N`, `$P$s`.
     */
    names?: Partial<HelperNames>;
    /**
     * Host code run in every proxied realm, as resolved text (see
     * src/hooks.ts; the controllers take `init.hooks` with sources or URLs
     * and put the text here).
     */
    hooks?: ResolvedHooks;
    /**
     * The host's own page for a document the proxy failed to produce (a
     * transport failure, the timeout, a routing error, a blocked rule, the
     * refusal to proxy its own origin): a path on the service worker's origin,
     * which in origin-isolation mode is the proxy host, not the host page's.
     * Served with the failure's status and `globalThis.stompError`
     * (`{ url, status, error, kind }`), never cached. Without it the built-in
     * pages answer.
     */
    errorPage?: string;
}
export interface ParsedConfig extends Omit<Config, 'codec'> {
    codec: GenericCodec;
}
export declare function parseConfig(config: Config, codecKey: string): ParsedConfig;
export declare function generateConfigCodecKey(codec: ConfigCodec): string;
export declare function codecType(codec: GenericCodec): ConfigCodec;
/**
 * The files `dist/` ships, by the names the host serves them under in its
 * `directory`. Every name defaults to the file's own; a host that renames
 * them (so no served URL carries the package name) says so here, and the
 * worker, the controllers and the shell build their URLs from these.
 */
export interface Assets {
    serviceWorker?: string;
    injectDocument?: string;
    injectWorker?: string;
    controllerFrame?: string;
    /** the script controllerFrame.html loads; told to the frame through `?script=` */
    controllerFrameScript?: string;
    /** the dedicated Worker that hosts a transport given as a descriptor */
    transportWorker?: string;
}
export declare const DEFAULT_ASSETS: Required<Assets>;
/** a served file's name: the host's, else the default */
export declare function assetName(assets: Assets | undefined, key: keyof Assets): string;
