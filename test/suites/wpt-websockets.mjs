// web-platform-tests websockets (test/wpt/websockets): the WebSocket the
// inject stands in for the browser's, over the transport, measured against
// the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-websockets', {
	roots: ['websockets'],
	concurrency: 3,
	globals: ['window', 'dedicatedworker'],
	skip: [
		// the fixture speaks neither TLS nor HTTP/2: only the plain ws: variant
		/\?wss/,
		/\?wpt_flags=h2/,
		// waits 20 s on an idle socket, past the harness natively
		/^\/websockets\/keeping-connection-open\//,
	],
});
