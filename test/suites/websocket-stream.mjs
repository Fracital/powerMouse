// WebSocketStream in a proxied page goes through the proxied WebSocket: the
// connection is made by the transport (the handshake carries the page's
// Origin, like the WebSocket hook), `opened` hands the page its streams, the
// first message arrives on the readable, `closed` settles when the socket
// closes, and `url` reads back the page's URL. Skipped where the browser has
// no WebSocketStream.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}pages/websocket-stream.html`);
let wss = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		wss = (await frame.evaluate(() => window.__wss)) || {};
	} catch (error) {
		wss = {};
	}
	if (wss.done) break;
}
if (wss.absent) {
	console.log('SKIP websocket-stream: the browser has no WebSocketStream');
} else {
	const echo = `ws://${new URL(FIXTURE).host}/ws-echo`;
	ok(
		'the stream opens through the transport and reads the first message',
		// the handshake went through the transport with the page's Origin (the
		// native class would connect directly, from the proxy origin)
		wss.first?.origin === new URL(FIXTURE).origin &&
			typeof wss.first?.cookie === 'string' &&
			wss.url === echo &&
			wss.native === true,
		JSON.stringify([wss.first, wss.url, wss.native, wss.error]),
	);
	ok(
		'closed settles and the readable ends',
		typeof wss.closed?.closeCode === 'number' && wss.end?.done === true,
		JSON.stringify([wss.closed, wss.end]),
	);
	ok(
		'the fixture ran to completion',
		wss.done === true && !wss.error,
		wss.error,
	);
}
await done(browser, page.errors);
