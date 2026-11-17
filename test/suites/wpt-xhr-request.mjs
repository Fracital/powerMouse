// web-platform-tests xhr, the request share (test/wpt/lists/xhr.mjs):
// what XMLHttpRequest sends (open, send bodies and their Content-Type, setRequestHeader) and xhr/formdata,
// measured against the native run.
import { runWpt } from '../wpt.mjs';
import { otherThan, skipped } from '../wpt/lists/xhr.mjs';

await runWpt('wpt-xhr-request', {
	roots: ['xhr'],
	concurrency: 3,
	globals: ['window', 'dedicatedworker'],
	skip: [otherThan('request'), ...skipped],
});
