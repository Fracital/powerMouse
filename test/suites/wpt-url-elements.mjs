// web-platform-tests url/ (test/wpt/url), the document half: the URL parser
// as anchors, areas and <base> reach it through the proxy's attribute
// hooks, and what navigation, XHR, sendBeacon and window.open make of a URL
// that does not parse, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-url-elements', {
	roots: ['url'],
	concurrency: 2,
	// the .any.js tests are wpt-url
	skip: [/^\/url\/.*\.any\./],
});
