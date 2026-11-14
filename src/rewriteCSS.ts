// The CSS rewriter: every url(), @import and image-set/src() string in a
// stylesheet routed through the proxy. The rewrite is the wasm scanner
// (rust/rwcss, a member of the core module, src/wasm/scanner.ts); a thread
// that holds no module yet compiles the bytes it holds synchronously
// (src/wasm/thread.ts), so a server thread always has it, and a page's
// library asks again once the module is in (src/inject/rewriter.ts). The
// url()s of a raw value are also routed by a regex (cssURLs), which needs no
// parser and answers a single value faster than a call into the module.
import { LAZY_CONTEXTS, MAY_ROUTE } from './cssURL';
import { rewriteCSSValueURLs as rewriteValueURLsInJS } from './cssURLs';
import { provideRewriters } from './rewriters';
import StompURL from './StompURL';
import {
	rewriteStyles,
	rewriteValueURLs,
	rewritingStyles,
} from './wasm/scanner';

export { restoreCSSValueURLs, routeCSS } from './cssURLs';

/**
 * Told the rewrite was the wasm scanner (the only CSS rewriter now); left
 * unset when there was nothing to look into. The request log's style
 * `rewriteBy`.
 */
export interface StyleRewrittenBy {
	by?: 'wasm';
}

/**
 * Route every url() in a raw CSS value. The regex (cssURLs) is the faster of
 * the two on a single value (2.9 against 3.7 microseconds, the module's
 * call-and-return costing 0.6 before anything is answered), so the callers
 * of this build do not pass `told`; one that does gets the module where the
 * thread holds it, with the same answer.
 */
export function rewriteCSSValueURLs(
	value: string,
	url: StompURL,
	told?: StyleRewrittenBy,
): string {
	if (told && value.includes('url(')) {
		const output = rewriteValueURLs(value, url);
		told.by = 'wasm';
		if (output !== null) return output;
	}
	return rewriteValueURLsInJS(value, url);
}

/**
 * The stylesheet (or declaration list) at `url` with every URL routed, by
 * the wasm scanner. A lazy context with nothing that could route is returned
 * as it was. When the thread holds no module (a page's library before it has
 * arrived), the url()s of the raw text are still routed by the regex and the
 * rest is left as written; the caller asks again once the module is in.
 */
export function modifyCSS(
	script: string,
	url: StompURL,
	context = 'stylesheet',
	/** told the scanner module made the rewrite; the output is the same with it and without */
	told?: StyleRewrittenBy,
): string {
	const lazy = LAZY_CONTEXTS.includes(context);
	if (lazy && !MAY_ROUTE.test(script)) return script;
	const output = rewriteStyles(script, url, context);
	if (told) told.by = 'wasm';
	if (output !== null) return output;
	return rewriteValueURLsInJS(script, url);
}

// a stylesheet inside a stylesheet (the data: URL of an @import, which
// routeCSS rewrites through the registry) asks for the scanner when the
// sheet around it was the scanner's
provideRewriters({
	modifyCSS: (script, url, context) =>
		modifyCSS(script, url, context, rewritingStyles() ? {} : undefined),
});
