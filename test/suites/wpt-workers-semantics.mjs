// web-platform-tests workers/interfaces/WorkerUtils and workers/semantics
// (test/wpt/workers): importScripts (arguments, errors, scripts of another
// origin), the worker's navigator and timers, script decoding, XHR in a
// worker, error reporting, several workers at once and a worker's page
// navigating away, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-workers-semantics', {
	roots: ['workers/interfaces/WorkerUtils', 'workers/semantics'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker', 'sharedworker'],
});
