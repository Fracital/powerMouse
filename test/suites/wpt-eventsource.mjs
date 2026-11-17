// web-platform-tests eventsource (test/wpt/eventsource), all but the stream
// format tests (wpt-eventsource-format): EventSource in a window, a dedicated
// worker and a shared worker (the constructor, the events, reconnection,
// redirects, CORS and credentials, the request's headers), measured against
// the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-eventsource', {
	roots: ['eventsource'],
	// the reconnection tests keep their state in cookies, and every page
	// starts by emptying the jar
	concurrency: 1,
	globals: ['window', 'dedicatedworker', 'sharedworker'],
	skip: [/^\/eventsource\/format-/],
});
