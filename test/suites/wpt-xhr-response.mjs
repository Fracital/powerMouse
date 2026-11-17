// web-platform-tests xhr, the response share (test/wpt/lists/xhr.mjs):
// what XMLHttpRequest reads back (status, headers, responseType, responseXML, overrideMimeType, decoding),
// measured against the native run.
import { runWpt } from '../wpt.mjs';
import { otherThan, skipped } from '../wpt/lists/xhr.mjs';

await runWpt('wpt-xhr-response', {
	roots: ['xhr'],
	concurrency: 3,
	globals: ['window', 'dedicatedworker'],
	skip: [otherThan('response'), ...skipped],
});
