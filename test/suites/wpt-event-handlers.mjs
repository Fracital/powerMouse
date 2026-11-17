// web-platform-tests html/webappapis/scripting/events
// (test/wpt/html/webappapis): event handler attributes, whose code the
// rewriter rewrites, onerror and the body and window forwarding, measured
// against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-event-handlers', {
	roots: ['html/webappapis/scripting/events'],
	concurrency: 2,
	globals: ['window', 'dedicatedworker'],
});
