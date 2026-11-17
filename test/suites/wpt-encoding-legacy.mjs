// web-platform-tests encoding/ (test/wpt/encoding), the document half: pages
// in a legacy encoding, which the proxy decodes and serves again as UTF-8.
// What the page reads back (document.characterSet, the text of a decoded
// frame) and what it sends (a link's query, a submitted form) is measured
// against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-encoding-legacy', {
	roots: ['encoding'],
	concurrency: 2,
	skip: [
		// the API tests are wpt-encoding-api
		/^\/encoding\/.*\.any\./,
		/^\/encoding\/streams\//,
		// a bounded sample of each index: its first and last thousand pointers
		// decoded
		/-decode\.html\?(?!1-1000$|\d+-last$)/,
		// and the last, short variant of what a link and a form encode. The
		// proxy serves every document as UTF-8 and encodes a query as UTF-8
		// too, so each subtest of these pages is one more entry on the
		// expected list from the same cause (41,000 of them with a thousand
		// per page and index)
		/-encode-(form|href)\.html\?(?!\d+-last$)/,
	],
});
