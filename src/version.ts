// The build this bundle came from, baked in by esbuild's define: STOMP_BUILD
// (version plus git sha or timestamp, when build.js provides it) or the
// package version. Every bundle carries it; the service worker, the
// controller and the inject bundles compare theirs, because a deploy that
// replaces one without the others fails in ways that look like anything else.
// esbuild replaces these at build time (build.js `define`); there is no
// Node here, so the name is declared for the type checker only
declare const process: { env: Record<string, string | undefined> };

export const BUILD: string =
	(process.env.STOMP_BUILD as string | undefined) ??
	(process.env.STOMP_VERSION as string | undefined) ??
	'dev';

/**
 * The identity of the rewriter this build ships: a digest of the bytes that
 * decide what a rewrite produces (the wasm core, the codec module, and the
 * light rewriter library), baked in by esbuild's define (build.js) under a
 * production build. It changes when the rewriter changes and stays the same
 * across a deploy that only touched something else (the demo, the infra),
 * unlike BUILD, which is the commit and changes every deploy. The rewrite
 * cache is made and kept under it (src/server/rewriteCache.ts): a revisit
 * after a rewriter-unchanged deploy comes back warm, and output from a build
 * whose rewriter differs is never served. Empty under a dev build, which has
 * no generation baked in (its rewriter can change without the commit
 * changing): the cache then falls back to BUILD and is dropped on every
 * activation, as it was before.
 */
export const REWRITE_GENERATION: string =
	(process.env.STOMP_REWRITE_GENERATION as string | undefined) || '';

/**
 * What the light rewriter library asset is asked for by, after a `?`: the
 * hash of the file this build made (build.js), so the URL of another build's
 * is another URL and a host may let browsers keep the file for good. A
 * synchronous request for it must not wait for a revalidation.
 */
export const LIBRARY: string =
	(process.env.STOMP_LIBRARY as string | undefined) || BUILD;

/**
 * What the rewriter's wasm core module is asked for by, after a `?`: the
 * hash of the module this build ships (build.js), as the library is (LIBRARY).
 * A top whose first task rewrites before the controller's compiled module
 * arrives fetches it with a synchronous request (src/inject/rewriter.ts
 * provideModule), which must not wait for a revalidation either.
 */
export const CORE: string =
	(process.env.STOMP_CORE as string | undefined) || BUILD;

/**
 * The name the light rewriter library asset assigns its factory to (build.js
 * writes the file as
 * `__stompRewriterLight=function(__stompRealm,__stompLibApi){...};`).
 * Loaded by a top's shell it is a global for the moment between that script
 * and the inject bundle, which takes it and deletes the name
 * (src/inject/rewriter.ts); evaluated by a copy it is the parameter of the
 * function that evaluates the text (src/rewriterLight.ts).
 */
export const LIGHT_FACTORY = '__stompRewriterLight';

/**
 * The name the document bundle's deferred parts assign their function to
 * (src/inject/dom/deferredParts.ts): a statement of the light rewriter
 * library's file, `__stompDeferred=function(__stompShared,__stompPart){...};`,
 * which runs the group of parts that has the part named (build.js
 * partsStatement). Taken and deleted as LIGHT_FACTORY is
 * (src/inject/rewriter.ts).
 */
export const DEFERRED_FACTORY = '__stompDeferred';

/**
 * The name the WebAuthn client of STomp's passkey provider assigns its
 * function to (src/inject/dom/passkeysPart.ts): a statement of its own after
 * the deferred parts', `__stompPasskeys=function(__stompShared){...};`
 * (build.js), so a frame that evaluates the deferred parts compiles none of
 * it. Taken and deleted as LIGHT_FACTORY is (src/inject/rewriter.ts).
 */
export const PASSKEYS_FACTORY = '__stompPasskeys';

/**
 * The name the gates of a document's gesture-gated calls assign their
 * function to (src/inject/dom/activationPart.ts): a statement of its own
 * after the passkey provider's, `__stompActivation=function(__stompShared){...};`
 * (build.js), so a frame that gets an activation only through the proxy
 * compiles none of the deferred parts for it. Taken and deleted as
 * LIGHT_FACTORY is (src/inject/rewriter.ts).
 */
export const ACTIVATION_FACTORY = '__stompActivation';
