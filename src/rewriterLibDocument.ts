// The rewriter library of the document inject (src/rewriterLib.ts): scripts,
// stylesheets and the public suffix list. The list is asked through
// src/suffix.ts, as in the service worker: of the suffix module once this
// copy holds it (a proxied top's library is handed the controller's
// modules, `adopt`), of tldts until then and wherever no module arrives.
import { modifyCSS } from './rewriteCSS';
import { library } from './rewriterLib';
import { getDomain, getPublicSuffix } from './suffix';
import { suffixListPin } from './wasm/suffix';

export const api = library({
	// in the scanner module when this copy holds it (a page of a host with
	// `rewriter: 'wasm'` is handed it), by css-tree otherwise: the same text
	modifyCSS: (text, url, context) => modifyCSS(text, url, context, {}),
	getDomain: (host) => getDomain(host),
	getPublicSuffix: (host, icann) => getPublicSuffix(host, !icann),
	suffixList: () => {
		const pin = suffixListPin();
		return pin ? `${pin.commit} ${pin.date}` : '';
	},
});
