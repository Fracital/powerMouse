// The light rewriter library (src/rewriterLight.ts) as the inject bundles
// carry it: build.js bundles it on its own and hands it to them as this
// module, a function that evaluates the library when called. Its text is
// the library's alone, so it can be evaluated in another realm too
// (src/inject/dom/rewriterRealm.ts). The rewriter library itself
// (src/rewriterLib.ts) is in no bundle: it is the asset `rewriterLib`, a
// function of the same shape, which the light library is handed when a
// call needs it (src/inject/rewriter.ts).
declare module 'stomp:rewriter-lib' {
	import type { RewriterLib } from '../rewriterLib';

	/**
	 * Evaluate the library. `realm`: the globals it reads (src/libGlobals.ts),
	 * by name; missing ones are taken from the realm it runs in.
	 */
	export default function rewriterLib(
		realm?: Record<string, unknown>,
	): RewriterLib;
}
