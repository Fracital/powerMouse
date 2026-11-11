// The rewriter library (src/rewriterLib.ts) as the asset `rewriterLib`
// (build.js): scripts, stylesheets and the public suffix list, for
// documents and workers alike. No bundle carries it. The list is asked
// through src/suffix.ts, as in the service worker: of the suffix module
// once this copy holds it (a proxied top's library is handed the
// controller's modules, `adopt`), of tldts until then and wherever no
// module arrives.
import { modifyCSS, type StyleRewrittenBy } from './rewriteCSS';
import { library } from './rewriterLib';
import { getDomain, getPublicSuffix } from './suffix';
import { suffixListPin } from './wasm/suffix';

/** the stylesheets and style attributes this copy rewrote in the module, and in JavaScript */
const styles = { wasm: 0, js: 0 };

export const api = {
	...library({
		// in the scanner module when this copy holds it (a page of a host with
		// `rewriter: 'wasm'` is handed it), by css-tree otherwise: the same text
		modifyCSS: (text, url, context) => {
			const told: StyleRewrittenBy = {};
			const output = modifyCSS(text, url, context, told);
			if (told.by) styles[told.by]++;
			return output;
		},
		getDomain: (host) => getDomain(host),
		getPublicSuffix: (host, icann) => getPublicSuffix(host, !icann),
		suffixList: () => {
			const pin = suffixListPin();
			return pin ? `${pin.commit} ${pin.date}` : '';
		},
	}),
	/**
	 * How many of this copy's CSS rewrites the module made and how many
	 * css-tree did, as `<wasm> <js>`: the two write the same text, so
	 * nothing else says which ran (css-inject-backend suite)
	 */
	styleRewrites(): string {
		return `${styles.wasm} ${styles.js}`;
	},
};
