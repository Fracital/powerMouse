// The light rewriter library of the document inject (src/rewriterLight.ts).
// Stylesheets and the public suffix list are answered here only by the
// scanner and suffix modules, once this copy holds them (a proxied top's
// library is handed the controller's modules, `adopt`). css-tree and tldts
// are not in this file: until the modules arrive, and wherever none does,
// a stylesheet and a host are the rewriter library's, loaded like for a
// script (docs/rust-plan.md, phase 2 step 4).
import { LAZY_CONTEXTS, MAY_ROUTE } from './cssURL';
import { library } from './rewriterLight';
import { rewriteStyles } from './wasm/scanner';
import { domainOf, publicSuffixOf, suffixListPin } from './wasm/suffix';

/** the stylesheets and style attributes this copy rewrote in the module, and the ones the rewriter library's css-tree did */
const styles = { wasm: 0, js: 0 };
/** the stylesheet in hand is one the module was asked for and did not rewrite */
let left = false;

export const api = {
	...library({
		modifyCSS: (text, url, context = 'stylesheet') => {
			left = false;
			// (a context the module does not rewrite is css-tree's, uncounted,
			// as in src/rewriteCSS.ts)
			if (!LAZY_CONTEXTS.includes(context)) return undefined;
			// as modifyCSS itself: nothing in it to route
			if (!MAY_ROUTE.test(text)) return text;
			const output = rewriteStyles(text, url, context);
			if (output === null) {
				left = true;
				return undefined;
			}
			styles.wasm++;
			return output;
		},
		styledByLibrary: () => {
			if (left) styles.js++;
			left = false;
		},
		getDomain: (host) => domainOf(host, false),
		getPublicSuffix: (host, icann) => publicSuffixOf(host, !icann),
		suffixList: () => {
			const pin = suffixListPin();
			return pin ? `${pin.commit} ${pin.date}` : '';
		},
	}),
	/**
	 * How many of this copy's CSS rewrites the module made and how many
	 * css-tree did (in the rewriter library, for this copy), as
	 * `<wasm> <js>`: the two write the same text, so nothing else says
	 * which ran (css-inject-backend suite)
	 */
	styleRewrites(): string {
		return `${styles.wasm} ${styles.js}`;
	},
};
