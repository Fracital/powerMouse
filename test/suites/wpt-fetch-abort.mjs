// web-platform-tests fetch/api/abort (test/wpt/fetch/api/abort): an
// AbortSignal on fetch() and on a Request, down to the connection closing,
// in a page and in a dedicated worker, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-fetch-abort', {
	roots: ['fetch/api/abort'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker'],
});
