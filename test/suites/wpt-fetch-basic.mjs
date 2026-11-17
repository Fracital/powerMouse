// web-platform-tests fetch/api/basic (test/wpt/fetch/api/basic): what
// fetch() sends and gets for each scheme, method, body, mode and status, in
// a page and in a dedicated worker, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-fetch-basic', {
	roots: ['fetch/api/basic'],
	concurrency: 2,
	globals: ['window', 'dedicatedworker'],
});
