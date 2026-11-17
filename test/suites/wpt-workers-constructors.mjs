// web-platform-tests workers/constructors, baseurl and multi-globals
// (test/wpt/workers): how the Worker and SharedWorker constructors take
// their arguments, which URL a script URL resolves against and what a
// worker's own requests resolve against, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-workers-constructors', {
	roots: ['workers/constructors', 'workers/baseurl', 'workers/multi-globals'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker', 'sharedworker'],
});
