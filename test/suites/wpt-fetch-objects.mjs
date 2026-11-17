// web-platform-tests fetch/api/headers, request and response
// (test/wpt/fetch/api): the Headers, Request and Response objects a page and
// a dedicated worker hold (the inject wraps all three), measured against the
// native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-fetch-objects', {
	roots: ['fetch/api/headers', 'fetch/api/request', 'fetch/api/response'],
	concurrency: 2,
	globals: ['window', 'dedicatedworker'],
	// through the proxy the first blocked port hangs until the harness gives
	// up, and which case it is differs between runs (the backlog says why)
	skip: [/request-bad-port/],
});
