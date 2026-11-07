/**
 * The four global names the rewriter and the inject bundles rendezvous on:
 * the access API object every rewritten script calls (`$s$j.get(...)`), the
 * client on the window (`$P$s.apply()`), and the two marker keys on the
 * `location` and `eval` stand-ins, plus the global the worker writes into
 * the host's error page. A deployment can choose its own (see
 * ControllerInit.names); the rewriter reads them from the config every
 * request carries, and the inject bundle from the config the shell hands
 * `createClient`, so one document and its scripts always agree. The
 * bootstrap name `createClient` is not one of them: the bundle deletes it
 * before any page script runs.
 */
export interface HelperNames {
    /** the access API on every global (default `$s$j`) */
    access: string;
    /** the stand-in marker on `location` and `eval` (default `$s$L`) */
    globalProxy: string;
    /** the stand-in's name marker, and the key of a Stomp message envelope (default `$s$N`) */
    globalName: string;
    /** the client on the window and on workers (default `$P$s`) */
    client: string;
    /**
     * the global the worker writes into the host's error page (`errorPage`)
     * with the failure (`{ url, status, error, kind }`); default `stompError`.
     * A host whose build renames identifiers in its vendored pages sets it to
     * what its page reads
     */
    error: string;
}
export declare const DEFAULT_NAMES: Readonly<HelperNames>;
/** the names a config asks for, the defaults for the rest */
export declare function helperNames(config?: object | null): HelperNames;
/**
 * Throws a TypeError when a names option cannot be used: an unknown key, a
 * value that is not an identifier, a reserved or special word, two names
 * alike, or a name a plain window already has (`taken`: the host passes
 * `Object.getOwnPropertyNames(globalThis)`, so a proxied page cannot tell a
 * helper from a global it expects).
 */
export declare function validateNames(names: Partial<HelperNames> | undefined, taken?: Iterable<string>): void;
