// The light rewriter library of the document inject (src/rewriterLight.ts).
// Stylesheets and the public suffix list are still answered here: by the
// scanner and suffix modules once this copy holds them (a proxied top's
// library is handed the controller's modules, `adopt`), by css-tree and
// tldts until then and wherever no module arrives. A part that is not
// given here is the rewriter library's, loaded like for a script.
import { modifyCSS, type StyleRewrittenBy } from './rewriteCSS';
import { library } from './rewriterLight';
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
