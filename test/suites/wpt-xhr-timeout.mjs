// web-platform-tests xhr, the timeout share (test/wpt/lists/xhr.mjs):
// XMLHttpRequest's timeout in documents and workers (set before and after
// send, overridden, reused, with abort), measured against the native run.
import { runWpt } from '../wpt.mjs';
import { otherThan, skipped } from '../wpt/lists/xhr.mjs';

await runWpt('wpt-xhr-timeout', {
	roots: ['xhr'],
	concurrency: 3,
	globals: ['window', 'dedicatedworker'],
	skip: [otherThan('timeout'), ...skipped],
});
