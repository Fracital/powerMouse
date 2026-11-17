// web-platform-tests fetch/api/cors (test/wpt/fetch/api/cors): the CORS
// checks, preflights and response filtering the proxy does in the browser's
// place, in a page and in a dedicated worker, measured against the native
// run. One page at a time: the cookie cases share the jar.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-fetch-cors', {
	roots: ['fetch/api/cors'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker'],
});
