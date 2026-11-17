// web-platform-tests xhr, the events share (test/wpt/lists/xhr.mjs):
// XMLHttpRequest's events and their order (abort, timeout, progress, upload, the synchronous cases),
// measured against the native run.
import { runWpt } from '../wpt.mjs';
import { otherThan, skipped } from '../wpt/lists/xhr.mjs';

await runWpt('wpt-xhr-events', {
	roots: ['xhr'],
	concurrency: 3,
	globals: ['window', 'dedicatedworker'],
	skip: [otherThan('events'), ...skipped],
});
