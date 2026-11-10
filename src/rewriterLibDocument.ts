// The rewriter library of the document inject (src/rewriterLib.ts): scripts,
// stylesheets and the public suffix list
import { getDomain, getPublicSuffix } from 'tldts';
import { modifyCSS } from './rewriteCSS';
import { library } from './rewriterLib';

export const api = library({
	modifyCSS,
	getDomain,
	getPublicSuffix: (host, icann) =>
		getPublicSuffix(host, { allowPrivateDomains: !icann }),
});
