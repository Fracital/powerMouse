// A proxied WebSocket's bufferedAmount says what has not left, as natively:
// a burst sent to a server that reads nothing for a while stays counted
// while the server holds it and reaches 0 only once the server read on,
// messages of every kind (Blob, string, ArrayBuffer) reach the server in the
// order they were sent, and a close the page starts right after a burst
// reaches the server after the whole burst. bufferedAmount fell to 0 a
// moment after each send through the proxy, whatever the server had read
// (the stand-in counted a message until it was handed to the transport
// worker), so a speed test's upload, which counts `sent - bufferedAmount`,
// read the speed of the page's own thread (src/transport/socketSends.ts).
// A WebSocketStream's writes settle once their messages left, so a writer
// that waits on writer.ready is held back as natively (they settled at
// once, desiredSize never fell, and a 48 MiB burst was "written" before the
// server read a byte).
// Through the proxy more leaves before the server reads than natively (the
// wisp server's stream window and its own socket's buffers, beside the
// suite's server's), so the held amount is compared with the burst less
// both, never with 0.
import { WebSocketServer } from 'ws';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const MIB = 1048576;
const SIZES = {
	held: { total: 48 * MIB, chunk: 256 * 1024, hold: 3000 },
	order: { rounds: 20 },
	closing: { total: 8 * MIB, chunk: 256 * 1024, hold: 800 },
};
/**
 * What may leave before the server reads (natively: the two sockets' kernel
 * buffers on loopback, some MiB; through the proxy the wisp server's
 * stream window and its socket toward the site too)
 */
const PROXY_SLACK = 8 * MIB;

/** what the server saw, by the page's run tag and the scenario's path */
const seen = new Map();
const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => sockets.once('listening', resolve));
sockets.on('connection', (ws, req) => {
	const url = new URL(req.url, 'http://x/');
	const tag = url.searchParams.get('tag');
	const key = `${tag} ${url.pathname}`;
	ws.on('error', () => {});
	if (url.pathname === '/hold') {
		const bytes = Number(url.searchParams.get('bytes'));
		const quiet = url.searchParams.has('quiet');
		let got = 0;
		let intact = true;
		const record = { got: 0, close: null };
		seen.set(key, record);
		// read nothing for `hold` ms: what the page sends piles up in the
		// sockets' buffers, then in the sender's
		ws._socket.pause();
		setTimeout(() => ws._socket.resume(), Number(url.searchParams.get('hold')));
		ws.on('message', (data) => {
			for (let i = 0; i < data.length; i += 4093)
				if (data[i] !== ((i * 7 + 3) & 255)) intact = false;
			got += data.length;
			record.got = got;
			if (got === bytes && !quiet) ws.send(JSON.stringify({ got, intact }));
		});
		ws.on('close', (code) => (record.close = `${code} after ${got}`));
	} else if (url.pathname === '/order') {
		const count = Number(url.searchParams.get('count'));
		const firsts = [];
		ws.on('message', (data, binary) => {
			firsts.push(`${binary ? 'b' : 't'}${String.fromCharCode(data[0])}`);
			if (firsts.length === count)
				ws.send(JSON.stringify({ order: firsts.join(' ') }));
		});
	}
});
const PAGE = `${FIXTURE}pages/websocket-buffered.html?port=${sockets.address().port}`;

/** what a run's page and the server saw */
async function measure(frame, tag) {
	const page = await frame.evaluate(
		([t, sizes]) => window.__run(t, sizes),
		[tag, SIZES],
	);
	await sleep(500);
	return {
		...page,
		closingServer: seen.get(`${tag} /hold`)?.close ?? null,
	};
}

/**
 * Natively a WebSocketStream's writes settle as the burst's do (kernel
 * buffers and Chrome's network service), so what settled while the server
 * held it is some MiB and the writer waits (desiredSize 0)
 */
function streamChecks(mode, native, proxied) {
	const s = proxied.streamed;
	const n = native.streamed;
	const { total, hold } = SIZES.held;
	const nativeSettled = Math.max(...(n?.at ?? [total]));
	ok(
		`${mode}: a WebSocketStream's writes settle as natively while the server reads nothing (less no more than the wisp server's buffers beside), and the writer waits on writer.ready`,
		Array.isArray(s?.at) &&
			Math.max(...s.at) < total &&
			Math.max(...s.at) <= nativeSettled + PROXY_SLACK &&
			s.desired.at(-1) === 0 &&
			!s.failed,
		JSON.stringify({ native: n, proxied: s }),
	);
	ok(
		`${mode}: the stream's last write settles only once the server read on, and the server has every byte intact`,
		s?.drained >= hold - 100 &&
			s.settled === total &&
			s.server?.got === total &&
			s.server.intact === true,
		JSON.stringify(s),
	);
}

/** the proxied frame of a demo page that has the fixture's runner */
async function proxiedFrame(page) {
	for (let i = 0; i < 160; i++) {
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
			if (
				await frame
					.evaluate(() => typeof window.__run === 'function')
					.catch(() => false)
			)
				return frame;
		await sleep(250);
	}
	return null;
}

const { held, order, closing } = SIZES;
const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(nativePage.mainFrame(), 'native');
await nativePage.close();
console.log('native', JSON.stringify(native));
const nativeLeft = held.total - (native.held?.lowest ?? 0);
ok(
	'natively: the burst is counted at once, stays counted while the server holds it, and reaches 0 once the server read on',
	native.held?.afterSend === held.total &&
		native.held.lowest > 0 &&
		native.held.drained >= held.hold - 100 &&
		native.held.server?.got === held.total &&
		native.held.server.intact === true,
	JSON.stringify(native.held),
);
const streams = !native.streamed?.absent;
if (!streams) console.log('SKIP WebSocketStream: the browser has none');
else
	ok(
		'natively: a WebSocketStream writer waits while the server reads nothing, and its last write settles once the server read on',
		Array.isArray(native.streamed?.at) &&
			Math.max(...native.streamed.at) < held.total &&
			native.streamed.desired.at(-1) === 0 &&
			native.streamed.drained >= held.hold - 100 &&
			native.streamed.server?.got === held.total &&
			native.streamed.server.intact === true,
		JSON.stringify(native.streamed),
	);
ok(
	'natively: every message reaches the server in the order it was sent',
	native.order?.server?.order ===
		Array(order.rounds).fill('bB ts ba bb').join(' '),
	JSON.stringify(native.order),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const frame = await proxiedFrame(page);
	if (!ok(`${mode}: the page loads`, frame)) {
		await page.close();
		continue;
	}
	const proxied = await measure(frame, mode);
	console.log(mode, JSON.stringify(proxied));
	const h = proxied.held;
	ok(
		`${mode}: the burst is counted at once in bufferedAmount`,
		h?.afterSend === held.total,
		JSON.stringify(h),
	);
	ok(
		`${mode}: while the server reads nothing the burst stays counted, less no more than leaves natively and the wisp server's buffers`,
		h?.lowest > 0 && held.total - h.lowest <= nativeLeft + PROXY_SLACK,
		JSON.stringify({ native: native.held, proxied: h, nativeLeft }),
	);
	ok(
		`${mode}: bufferedAmount reaches 0 only once the server read on, and the server has every byte intact`,
		h?.drained >= held.hold - 100 &&
			h.server?.got === held.total &&
			h.server.intact === true,
		JSON.stringify(h),
	);
	ok(
		`${mode}: Blob, string and ArrayBuffer messages reach the server in the order they were sent, as natively`,
		typeof proxied.order?.server?.order === 'string' &&
			proxied.order.server.order === native.order?.server?.order &&
			proxied.order.left === 0,
		JSON.stringify({ native: native.order, proxied: proxied.order }),
	);
	ok(
		`${mode}: a close right after a burst reaches the server after the whole burst, and the close event comes once it left, as natively`,
		native.closingServer === `4001 after ${closing.total}` &&
			proxied.closingServer === native.closingServer &&
			native.closing?.closed === 4001 &&
			proxied.closing?.closed === 4001 &&
			proxied.closing.afterClose === native.closing.afterClose,
		JSON.stringify({
			native: [native.closing, native.closingServer],
			proxied: [proxied.closing, proxied.closingServer],
		}),
	);
	if (streams) streamChecks(mode, native, proxied);
	await page.close();
}

sockets.close();
await done(browser);
