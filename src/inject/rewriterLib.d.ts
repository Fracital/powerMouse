// The light rewriter library (src/rewriterLight.ts) as the worker bundle
// carries it: build.js bundles it on its own and hands it over as this
// module, a function that evaluates the library when called. Its text is the
// library's alone, so it can be evaluated in another realm too
// (src/inject/dom/rewriterRealm.ts). A document bundle does not carry it (a
// frame uses its top's and evaluates none): its top's shell loads the asset
// `rewriterLib` instead, the same function (src/inject/rewriter.ts).
declare module 'stomp:rewriter-lib' {
	import type { RewriterLib } from '../rewriterLight';

	/**
	 * Evaluate the library. `realm`: the globals it reads (src/libGlobals.ts),
	 * by name; missing ones are taken from the realm it runs in. Null in the
	 * document bundle, which carries none: its light library is the asset the
	 * shell loaded (src/inject/rewriter.ts lightFactory).
	 */
	const rewriterLib: ((realm?: Record<string, unknown>) => RewriterLib) | null;
	export default rewriterLib;
}
