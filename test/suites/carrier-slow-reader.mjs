// One slow reader does not hold back the rest of the profile. Every tab of
// an origin rides the carrier host's one relay connection
// (src/transport/carrierHost.ts), and a tab whose body readers are slow
// holds the relay back (its rider's credit), as a reader holds its socket
// back natively. A native socket holds back only itself: here one tab reads
// a large HTTP/1.1 body slowly, through the carrier host, while another tab
// of the same profile downloads from another origin as fast as it can and
// echoes over a WebSocket. The fast download and the echoes must go on at
// their own pace, never waiting on the slow reader (the host stopped
// reading the relay until the slow tab caught up, so the fast tab ran at
// the slow one's pace and WebRTC's datagrams waited with it), and the slow
// body still arrives whole.
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PORT, PROXY } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

const MB = 1024 * 1024;
/** what the slow tab reads, and how fast */
const SLOW_BYTES = 48 * MB;
const SLOW_RATE = 3 * MB;
/** what the fast tab downloads, in requests of FAST_CHUNK */
const FAST_BYTES = 128 * MB;
const FAST_CHUNK = 16 * MB;
/** the longest the fast tab may wait for its next chunk or an echo */
const GAP_MS = 1000;

// a leaf for 127.0.0.1 signed by the test CA, which epoxy is given
const { certPem, keyPem, caPem } = await startWebTransportServer();

// HTTP/1.1 origins (no flow control but the client's reading): `/flow?n=`
// streams `n` bytes of one random MiB as fast as the client takes them
const chunk = Buffer.alloc(MB, 7);
const flowReports = [];
async function flowOrigin(label) {
	const server = createHttpsServer(
		{ cert: certPem, key: keyPem },
		(req, res) => {
			const n = Number(new URL(req.url, 'https://x').searchParams.get('n'));
			const report = {
				label,
				expected: n,
				queued: 0,
				finished: false,
				closedEarly: false,
			};
			flowReports.push(report);
			res.once('finish', () => {
				report.finished = true;
			});
			res.once('close', () => {
				report.closedEarly = !res.writableFinished;
			});
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': String(n),
				'cache-control': 'no-store',
			});
			let left = n;
			const more = () => {
				while (left > 0) {
					const part = chunk.subarray(0, Math.min(left, chunk.length));
					left -= part.length;
					report.queued += part.length;
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
const slowOrigin = await flowOrigin('slow');
const fastOrigin = await flowOrigin('fast');

const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
echo.on('connection', (ws) =>
	ws.on('message', (m, binary) => ws.send(m, { binary })),
);
await new Promise((resolve) => echo.once('listening', resolve));
const wsEcho = `ws://127.0.0.1:${echo.address().port}/`;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const browser = await launch();
const context = await browser.newContext();
const errors = [];

/** a tab of the profile with a controller whose transport (one shard, in its worker) rides the carrier host */
async function tab() {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await page.evaluate(
		async ({ wisp, caPem }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					options: [{ wisp, pem_files: [caPem] }],
					host: 'worker',
					shards: 1,
					webTransport: { timeoutMs: 3000 },
				},
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			window.controller = controller;
		},
		{ wisp: relay.wisp, caPem },
	);
	return page;
}

const slowTab = await tab();
const fastTab = await tab();

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
		let got = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			got += value.byteLength;
			const due = (got / rate) * 1000 - (performance.now() - t0);
			if (due > 0) await new Promise((resolve) => setTimeout(resolve, due));
		}
		return { got, ms: Math.round(performance.now() - t0) };
	},
	{ url: `${slowOrigin}/flow?n=${SLOW_BYTES}&slow`, rate: SLOW_RATE },
);
// let the slow tab fall behind first
await new Promise((resolve) => setTimeout(resolve, 2000));

const fastEvaluation = fastTab.evaluate(
	async ({ origin, bytes, chunk, ws }) => {
		// an echo every 100 ms over a WebSocket of its own while it downloads
		const echoes = [];
		let echoError = null;
		let pings = 0;
		// the longest the page went between two pings (its timers run late
		// on a busy machine)
		let sendGap = 0;
		let pinging = true;
		const echoed = new Promise((resolve) => {
			const sent = new Map();
			let n = 0;
			const [send, close] = window.controller.transport.connect(
				new URL(ws),
				[],
				[],
				async () => {
					let last = performance.now();
					while (pinging) {
						const id = String(n++);
						const now = performance.now();
						sendGap = Math.max(sendGap, now - last);
						last = now;
						sent.set(id, now);
						send(id);
						await new Promise((r) => setTimeout(r, 100));
					}
					// the last answers
					await new Promise((r) => setTimeout(r, 1000));
					pings = n;
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
			pings,
			echoes: echoes.length,
			sendGap: Math.round(sendGap),
			slowestEcho: Math.round(Math.max(0, ...echoes)),
			echoError,
		};
	},
	{ origin: fastOrigin, bytes: FAST_BYTES, chunk: FAST_CHUNK, ws: wsEcho },
);
const fast = await fastEvaluation.catch((error) => {
	// A transport-side incomplete body is indistinguishable from the origin
	// closing early without the origin's own finish/close state. Keep the
	// request-by-request evidence when the browser evaluation throws.
	console.error(
		'Flow origins at transport failure:',
		JSON.stringify(flowReports),
	);
	throw error;
});

const slowRead = await slow;

ok(
	'a tab downloads at its own pace while another tab of the profile reads a body slowly: no wait for its next bytes past a second',
	fast.got === FAST_BYTES && fast.gap < GAP_MS,
	JSON.stringify({ fast, slowRead }),
);
// every ping is answered, each within a second, and the pings went on all
// along: never a second without one. Counted against the pings the page
// sent, not against the download's time over 100 ms: a timer on a busy
// machine fires late, and six of CI's failing runs had every echo back
// within 0.6 s but 1 to 4 fewer echoes than that count asked for.
ok(
	"its WebSocket's echoes come back within a second all along",
	!fast.echoError &&
		fast.pings > 0 &&
		fast.echoes === fast.pings &&
		fast.sendGap < GAP_MS &&
		fast.slowestEcho < GAP_MS,
	JSON.stringify(fast),
);
ok(
	"the slow tab's body arrives whole, at its reader's pace",
	slowRead.got === SLOW_BYTES,
	JSON.stringify(slowRead),
);
await done(browser, errors);
