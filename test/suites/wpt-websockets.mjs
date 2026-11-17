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
		// Pages that wait for a message the server sends in answer to one
		// send. epoxy hands an incoming frame over only when the next
		// outgoing one is written (test/wpt/README.md), so each of these
		// times out or passes by a race: they come back when the transport
		// delivers frames as they arrive.
		/^\/websockets\/Send-(0byte-data|binary-|null|unpaired-surrogates|data\.worker)/,
		/^\/websockets\/binary\//,
		/^\/websockets\/Close-server-initiated-close\./,
		/^\/websockets\/closing-handshake\/00[24]\./,
		/^\/websockets\/constructor\/0(06|13)\./,
		/^\/websockets\/extended-payload-length\./,
		/^\/websockets\/interfaces\/CloseEvent\/clean-close\./,
		/^\/websockets\/interfaces\/WebSocket\/bufferedAmount\/bufferedAmount-(arraybuffer|blob)\./,
		/^\/websockets\/interfaces\/WebSocket\/events\/01[5-8]\./,
		/^\/websockets\/interfaces\/WebSocket\/send\/0(06|08|09|10|11)\./,
		/^\/websockets\/security\/001\./,
		/^\/websockets\/send-data-isolation\./,
	],
});
