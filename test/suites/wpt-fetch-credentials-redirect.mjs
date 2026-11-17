// web-platform-tests fetch/api/credentials and fetch/api/redirect
// (test/wpt/fetch/api): cookies and Authorization per credentials mode, and
// what a redirect does to the method, the body, the Origin, the Referer and
// the response, in a page and in a dedicated worker, measured against the
// native run. One page at a time: the cookie cases share the jar.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-fetch-credentials-redirect', {
	roots: ['fetch/api/credentials', 'fetch/api/redirect'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker'],
});
