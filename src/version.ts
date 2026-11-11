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
 * What the rewriter library asset is asked for by, after a `?`: the hash of
 * the file this build made (build.js), so the URL of another build's is
 * another URL and a host may let browsers keep the file for good. A
 * worker's synchronous request for it must not wait for a revalidation.
 */
export const LIBRARY: string =
	(process.env.STOMP_LIBRARY as string | undefined) || BUILD;

/**
 * The name the rewriter library asset assigns its factory to (build.js
 * writes the file as `__stompRewriterLib=function(__stompRealm){...};`).
 * Loaded by a top's shell it is a global for the moment between that
 * script and the inject bundle, which takes it and deletes the name
 * (src/inject/rewriter.ts); evaluated by a library it is the parameter of
 * the function that evaluates the text (src/rewriterLight.ts).
 */
export const LIBRARY_FACTORY = '__stompRewriterLib';
