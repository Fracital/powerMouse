// web-platform-tests encoding/ (test/wpt/encoding), the document half: pages
// in a legacy encoding, which the proxy decodes and serves again in that
// encoding (src/server/charset.ts encodeShell).
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
		// and of what a form encodes, its first thousand pointers and its
		// last, short variant (each variant submits its thousand characters
		// through frames, chunk by chunk); what a link encodes runs whole
		/-encode-form\.html\?(?!1-1000$|\d+-last$)/,
	],
});
