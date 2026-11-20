// With Wisp stream credit (0xE2, deploy/epoxy patch epoxy-tls 0084) one
// slow reader holds back only its own stream, as a native socket's receive
// window holds back only its remote. A tab of a profile reads a large
// HTTP/1.1 body slowly while another tab of the same profile downloads as
// fast as it can and echoes over a WebSocket, all through the carrier
// host's one relay connection, which names stream credit: the fast
// download and the echoes never wait on the slow reader, the slow body
// arrives whole, the slow tab's transport worker keeps little of what its
// reader has not taken (the relay held the rest back), and no relay-wide
// pause (src/transport/carrierHost.ts) or rider pacing
// (src/transport/riderPace.ts) stands in for it. Once over WebTransport
// with lanes, once over the WebSocket, epoxy in Wisp v2 (`wisp_v2`).
//
// The relay (test/wisp-wt.mjs) passes on the wisp server's credit when it
// offers it (holyWisp with `stream-credit`, HOLYWISP_BIN) and emulates it
// otherwise, holding a stream's DATA past what its reader granted. With the
// server's own, the origin itself is held back: what it wrote past what the
// slow reader took stays within the stream's window, the body port's
// (src/transport/bodyPort.ts BODY_WINDOW) and the sockets' buffers (16 to
// 21 MB measured on loopback, where with nothing holding it back it wrote
// the whole body, 96 MB past the reader).
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PORT, PROXY } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';
import { grewBy, workerMemory } from '../worker-memory.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

const MB = 1024 * 1024;
/** what the slow tab reads, and how fast */
const SLOW_BYTES = 128 * MB;
const SLOW_RATE = 8 * MB;
/** what the fast tab downloads, in requests of FAST_CHUNK */
const FAST_BYTES = 64 * MB;
const FAST_CHUNK = 16 * MB;
/** the longest the fast tab may wait for its next chunk or an echo */
const GAP_MS = 1000;
/**
 * what the slow tab's transport worker may grow by while its reader lags:
 * a stream's window (256 KiB, grown to a few MiB by the body port's first
 * fast pull) and the body port's, where with nothing holding the relay
 * back it kept the 96 MB its reader had not taken yet
 */
const HELD_MAX = 16 * MB;
/** what the origin may have written past the slow reader, with the server's own credit */
const AHEAD_MAX = 40 * MB;

// a leaf for 127.0.0.1 signed by the test CA, which epoxy is given
const { certPem, keyPem, caPem } = await startWebTransportServer();

// HTTP/1.1 origins: `/flow?n=` streams `n` bytes as fast as the socket
// takes them; `written` is what the slow body's server handed its socket
const chunk = Buffer.alloc(MB, 7);
const written = { slow: 0 };
async function flowOrigin() {
	const server = createHttpsServer(
		{ cert: certPem, key: keyPem },
		(req, res) => {
			const url = new URL(req.url, 'https://x');
			const n = Number(url.searchParams.get('n'));
			const slow = url.searchParams.has('slow');
			if (slow) written.slow = 0;
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': String(n),
				'cache-control': 'no-store',
			});
			let left = n;
			const more = () => {
				while (left > 0) {
					const part = chunk.subarray(0, Math.min(left, 64 * 1024));
					left -= part.length;
					if (slow) written.slow += part.length;
					if (!res.write(part)) return void res.once('drain', more);
				}
				res.end();
			};
			more();
		},
	);
	// a keep-alive that outlasts the slow read
	server.keepAliveTimeout = 120 * 1000;
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `https://127.0.0.1:${server.address().port}`;
}
const slowOrigin = await flowOrigin();
const fastOrigin = await flowOrigin();

const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
echo.on('connection', (ws) =>
	ws.on('message', (m, binary) => ws.send(m, { binary })),
);
await new Promise((resolve) => echo.once('listening', resolve));
const wsEcho = `ws://127.0.0.1:${echo.address().port}/`;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
relay.streamCredit = 'emulate';
const browser = await launch();
const errors = [];
const workers = await workerMemory(browser);

/** a tab of `context` with a controller whose transport (one shard, in its worker) rides the carrier host */
async function tab(context, webTransport) {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await page.evaluate(
		async ({ wisp, caPem, webTransport }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					// stream credit is Wisp v2's: epoxy in v1 (its default) has
					// no INFO to name it in, and the carrier's own INFO for it
					// (wispWebTransport.ts) names none
					options: [{ wisp, pem_files: [caPem], wisp_v2: true }],
					host: 'worker',
					shards: 1,
					...(webTransport ? { webTransport: { timeoutMs: 3000 } } : {}),
				},
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			window.controller = controller;
		},
		{ wisp: relay.wisp, caPem, webTransport },
	);
	return page;
}

/** the slow read, the fast download and the echoes in one profile, over `carrier` */
async function round(carrier) {
	const webTransport = carrier === 'webtransport';
	relay.stats.creditHeldMost = 0;
	const before = { ...relay.stats };
	const context = await browser.newContext();
	const slowTab = await tab(context, webTransport);
	const fastTab = await tab(context, webTransport);
	const settled = await workers.memory();

	// the slow tab reads its body at SLOW_RATE, from now on
	const slow = slowTab.evaluate(
		async ({ url, rate }) => {
			const response = await window.controller.transport.request(
				new URL(url),
				'GET',
				null,
				[],
				undefined,
			);
			const reader = response.body.getReader();
			const t0 = performance.now();
			window.slowGot = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				window.slowGot += value.byteLength;
				const due = (window.slowGot / rate) * 1000 - (performance.now() - t0);
				if (due > 0) await new Promise((resolve) => setTimeout(resolve, due));
			}
			return { got: window.slowGot, ms: Math.round(performance.now() - t0) };
		},
		{ url: `${slowOrigin}/flow?n=${SLOW_BYTES}&slow`, rate: SLOW_RATE },
	);
	// the slow tab falls behind: what its worker holds, and the origin wrote
	await new Promise((resolve) => setTimeout(resolve, 4000));
	const lagging = await workers.memory();
	const taken = await slowTab.evaluate(() => window.slowGot);
	const ahead = written.slow - taken;

	const fast = await fastTab.evaluate(
		async ({ origin, bytes, chunk, ws }) => {
			// an echo every 100 ms over a WebSocket of its own while it downloads
			const echoes = [];
			let echoError = null;
			let pinging = true;
			const echoed = new Promise((resolve) => {
				const sent = new Map();
				let n = 0;
				const [send, close] = window.controller.transport.connect(
					new URL(ws),
					[],
					[],
					async () => {
						while (pinging) {
							const id = String(n++);
							sent.set(id, performance.now());
							send(id);
							await new Promise((r) => setTimeout(r, 100));
						}
						// the last answers
						await new Promise((r) => setTimeout(r, 1000));
						close(1000, '');
						resolve();
					},
					(data) => {
						const at = sent.get(String(data));
						if (at !== undefined) {
							echoes.push(performance.now() - at);
							sent.delete(String(data));
						}
					},
					() => resolve(),
					(error) => {
						echoError = String(error);
						resolve();
					},
				);
			});
			const t0 = performance.now();
			let got = 0;
			let gap = 0;
			let last = t0;
			for (let at = 0; at < bytes; at += chunk) {
				const response = await window.controller.transport.request(
					new URL(`${origin}/flow?n=${chunk}&at=${at}`),
					'GET',
					null,
					[],
					undefined,
				);
				const reader = response.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					const now = performance.now();
					gap = Math.max(gap, now - last);
					last = now;
					if (done) break;
					got += value.byteLength;
				}
			}
			const ms = performance.now() - t0;
			pinging = false;
			await echoed;
			return {
				got,
				ms: Math.round(ms),
				gap: Math.round(gap),
				echoes: echoes.length,
				slowestEcho: Math.round(Math.max(0, ...echoes)),
				echoError,
			};
		},
		{ origin: fastOrigin, bytes: FAST_BYTES, chunk: FAST_CHUNK, ws: wsEcho },
	);
	const slowRead = await slow;
	const stats = relay.stats;
	const credit = {
		offered: stats.creditOffered - before.creditOffered,
		named: stats.creditNamed - before.creditNamed,
		emulated: stats.creditEmulated - before.creditEmulated,
		credits: stats.credits - before.credits,
		heldMostMB: +(stats.creditHeldMost / MB).toFixed(1),
		lanes: stats.lanes - before.lanes,
		ws: stats.ws - before.ws,
	};
	const grew = grewBy(settled, lagging, 'transport');
	const detail = JSON.stringify({
		fast,
		slowRead,
		credit,
		grewMB: grew === null ? null : +(grew / MB).toFixed(1),
		aheadMB: +(ahead / MB).toFixed(1),
		takenMB: +(taken / MB).toFixed(1),
	});
	console.log(`${carrier}: ${detail}`);

	ok(
		`${carrier}: the relay connection names stream credit and the readers grant it`,
		credit.named > 0 &&
			credit.credits > 0 &&
			(webTransport ? credit.lanes > 0 : credit.ws > 0),
		detail,
	);
	ok(
		`${carrier}: a tab downloads at its own pace while another tab of the profile reads a body slowly: no wait for its next bytes past a second`,
		fast.got === FAST_BYTES && fast.gap < GAP_MS,
		detail,
	);
	ok(
		`${carrier}: its WebSocket's echoes come back within a second all along`,
		!fast.echoError &&
			fast.echoes >= Math.floor(fast.ms / 100) - 2 &&
			fast.slowestEcho < GAP_MS,
		detail,
	);
	ok(
		`${carrier}: the slow tab's body arrives whole, at its reader's pace`,
		slowRead.got === SLOW_BYTES &&
			slowRead.ms >= ((SLOW_BYTES / SLOW_RATE) * 1000) / 2,
		detail,
	);
	ok(
		`${carrier}: the slow tab's worker keeps no more than a window or so of what its reader has not taken`,
		grew !== null && grew < HELD_MAX && taken < SLOW_BYTES / 2,
		detail,
	);
	if (credit.offered)
		ok(
			`${carrier}: with the wisp server's own credit the origin is held back, as a socket's reader holds it back`,
			ahead < AHEAD_MAX,
			detail,
		);
	else
		ok(
			`${carrier}: the relay holds back what the slow reader did not grant`,
			credit.emulated > 0 && stats.creditHeldMost > HELD_MAX,
			detail,
		);
	await context.close();
}

await round('webtransport');
await round('websocket');
await workers.detach();
relay.close();
echo.close();
await done(browser, errors);
