// web-platform-tests eventsource (test/wpt/eventsource), the stream format
// tests: the fields, the byte order mark, the MIME type, Last-Event-ID and
// the retry time of an event stream, in a window and in a dedicated worker,
// measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-eventsource-format', {
	roots: ['eventsource'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker'],
	skip: [/^\/eventsource\/(?!format-)/],
});
