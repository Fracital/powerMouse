// web-platform-tests workers/, the top-level tests (test/wpt/workers/*):
// starting a worker and talking to it, error events, timers, blob: and
// data: URL workers, nested workers, shared workers, measured against the
// native run. One page at a time: shared workers are found by script URL
// and name across the pages of a browser.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-workers-basics', {
	roots: ['workers'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker', 'sharedworker'],
	skip: [
		// the directories below workers/ are the other wpt-workers-* suites
		/^\/workers\/[^/]+\//,
		// what a worker's scope shows it: wpt-workers-scope
		/^\/workers\/(WorkerLocation|Worker-location|WorkerNavigator|WorkerGlobalScope|importscripts_)/,
		// natively flaky: the shared worker subtest passes in a full run and
		// fails when the page runs alone (onerror fires for a runtime error)
		/^\/workers\/abrupt-completion\.html$/,
	],
});
