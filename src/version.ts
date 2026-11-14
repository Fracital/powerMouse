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
 * The name the light rewriter library asset assigns its factory to (build.js
 * writes the file as `__stompRewriterLight=function(__stompRealm){...};`).
 * Loaded by a top's shell it is a global for the moment between that script
 * and the inject bundle, which takes it and deletes the name
 * (src/inject/rewriter.ts); evaluated by a copy it is the parameter of the
 * function that evaluates the text (src/rewriterLight.ts).
 */
export const LIGHT_FACTORY = '__stompRewriterLight';
