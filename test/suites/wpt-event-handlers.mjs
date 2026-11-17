// web-platform-tests html/webappapis/scripting/events
// (test/wpt/html/webappapis): event handler attributes, whose code the
// rewriter rewrites, onerror and the body and window forwarding, measured
// against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-event-handlers', {
	roots: ['html/webappapis/scripting/events'],
	concurrency: 2,
	globals: ['window', 'dedicatedworker'],
	skip: [
		// proxied, which of its subtests fail changes from run to run: the
		// popup's shell erases the listeners the opener set on it, and the
		// test's own timeout decides which subtest reports first (README,
		// html and dom; BACKLOG, wpt-event-handlers)
		/\/compile-event-handler-settings-objects\.html$/,
	],
});
