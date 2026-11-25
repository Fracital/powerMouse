// A reader that stops holds its connection back natively: Chrome stops
// reading the socket, TCP's receive window closes, and the origin waits,
// so a paused fetch of a body of hundreds of MB costs the browser a few
// MB. Through the proxy the body rides a Wisp stream of the relay's one
// connection, and plain Wisp has no flow control toward the client: what
// the relay sends for a stream no one reads waited in epoxy, in the
// transport worker's wasm memory, which never shrinks (384 MB of 384 MB,
// measured before src/transport/boundedBody.ts).
//
// Here a tab reads 1 MB of a 384 MB body and then reads nothing for a
// while, as a paused media element or a stalled download does, while
// another tab of the profile downloads as fast as it can and echoes over a
// WebSocket, all on the carrier host's one relay connection; then it reads
// the rest. A round is a relay and a body:
//
// - a relay whose INFO names stream credit (Wisp 0xE2, the fixture's
//   emulation, as holyWisp's `stream-credit`), and one that does not;
// - a body that cannot be resumed (chunked, no validator), and one that
//   can (a length, ranges and an ETag: resumableBody.ts);
// - through the carrier host, and on a carrier of the tab's own;
// - on the relay's WebSocket, and on its WebTransport session (`wt-`);
// - over HTTP/1, and over HTTP/2 (`h2`), whose windows hold the body back
//   on any relay (HTTP/3's do too: measured with an h3 origin outside the
//   suite, the origin 13 to 14 MB ahead of the reader and the worker 17 to
//   22 MB up on either relay and either carrier, since no fixture here
//   serves a GET over HTTP/3).
//
// Then, on the relay without credit: a reader that reads slowly but never
// stops, a transport switched from a connection with credit to a Wisp v1
// one (`switch-v1-chunked`), one that cancels while paused, a tab reloaded
// while paused (through the carrier host on either carrier, and on a
// carrier of its own), and (with credit, where a paused stream stays open)
// the relay cut while paused, each followed by a request that must work.
//
// Measured, not asserted from the code: the peak of the transport worker's
// and the carrier host's memory after a collection (JS heap, ArrayBuffers
// and wasm memories, over CDP, each second), the peak of the whole
// browser's proportional set size (every process of it, from /proc, five
// times a second; where there is no /proc it is left out), what the
// origin wrote past what the reader took, and what waited for a reader
// that was reset. The same body fetched natively (no proxy) with the same
// pause is the yardstick. A body must arrive whole and in order, or fail
// as a reset connection does; the other tab's download and echoes must not
// wait on the paused reader.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createSecureServer as createHttp2Server } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PORT, PROXY, sleep } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';
import { workerMemory } from '../worker-memory.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

const MB = 1024 * 1024;
/** the paused body */
const BIG_BYTES = Number(process.env.PAUSED_BODY_MB || 384) * MB;
/** what the reader takes before it pauses, and how long it pauses */
const FIRST_BYTES = 1 * MB;
const PAUSE_MS = Number(process.env.PAUSED_BODY_PAUSE_MS || 10000);
/** what the other tab downloads meanwhile, in requests of FAST_CHUNK */
const FAST_BYTES = 64 * MB;
const FAST_CHUNK = 16 * MB;
/** the longest the other tab may wait for its next bytes or an echo */
const GAP_MS = 1000;
/** the slow reader's body and pace */
const SLOW_BYTES = 96 * MB;
const SLOW_RATE = 12 * MB;
/** the origin's pace for the abort and reload rounds (bytes a second) */
const PACED_RATE = 16 * MB;
/** the rounds to run (all by default), by name: `credit-chunked`, ... */
const ONLY = process.env.PAUSED_BODY_ROUNDS?.split(',') ?? null;

/**
 * The bounds, from what was measured (Chrome 159, a 12-core Linux machine,
 * loopback, 2026-11-22). Natively the paused 384 MB body grew the
 * browser's PSS by 3 to 23 MB, the page's heap by 0.4 MB, and the origin
 * wrote 7 to 9 MB past the reader. Through the proxy, before
 * boundedBody.ts, the paused chunked body on a relay without credit grew
 * the transport worker's wasm memory by 384 MB (for the life of the tab)
 * and the browser's PSS by 431 MB. With it, every round grew the worker's
 * memory by 26 MB at most (its wasm by 9 MB at most) and the carrier
 * host's by 8 MB, a reset body had 64 MB waiting for it, and the browser
 * held 76 MB more at most once collected with the reader still paused.
 * The browser's PSS peak is printed, not bounded: what the relay sent
 * before a stream was reset or let go arrives anyway (325 MB of it passed
 * through as garbage in the paused chunked round), and no client can
 * unsend it.
 */
const WORKER_MAX = 48 * MB;
/**
 * the transport worker of a round whose body is reset: its queue holds up
 * to HOLD_MAX (64 MiB) for the reader before the reset. The WebSocket's
 * rounds fill it within a second and the measure, each second, rarely
 * catches it (10 MB); the session's (WebTransport) fill it over seconds:
 * 45 to 63 MB measured
 */
const RESET_WORKER_MAX = 80 * MB;
/** what waited for a reader when it was reset: boundedBody.ts HOLD_MAX and a chunk */
const RESET_HELD_MAX = 66 * MB;
/** the browser's PSS held more: both tabs, the other tab's 64 MB download, and the paused body's bound */
const PSS_MAX = 160 * MB;
/**
 * how soon a paused body's origin connection closes after the page lets it
 * go or reloads (9 to 60 ms measured), and what the origin, writing at
 * PACED_RATE, may write past the let-go meanwhile (0.2 to 0.8 MB)
 */
const LET_GO_MS = 1000;
const LET_GO_AHEAD = 16 * MB;

// a leaf for 127.0.0.1 signed by the test CA, which epoxy is given
const { certPem, keyPem, caPem } = await startWebTransportServer();

// One block of the body's pattern: byte i of the resource is i % 251, so
// a body read in pieces (or resumed by range) checks in order.
const PATTERN = 251;
const block = Buffer.alloc(PATTERN * 4096);
for (let i = 0; i < block.length; i++) block[i] = i % PATTERN;

/** each `/big` request by its `id`: bytes written to the socket, and whether it closed before the end */
const origin = new Map();
let requests = 0;
function handler(req, res) {
	const url = new URL(req.url, 'https://x');
	const n = Number(url.searchParams.get('n'));
	const id = url.searchParams.get('id') ?? '';
	const rate = Number(url.searchParams.get('rate') || 0);
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('cache-control', 'no-store');
	if (url.pathname === '/flow') {
		res.writeHead(200, {
			'content-type': 'application/octet-stream',
			'content-length': String(n),
		});
		return send(res, 0, n, null, 0);
	}
	if (url.pathname !== '/big') return void res.writeHead(404).end();
	requests++;
	const ranged = url.searchParams.get('kind') === 'ranged';
	let from = 0;
	let to = n - 1;
	if (ranged) {
		res.setHeader('accept-ranges', 'bytes');
		res.setHeader('etag', '"paused-body-1"');
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
		const ifRange = req.headers['if-range'];
		if (range && (!ifRange || ifRange === '"paused-body-1"')) {
			from = Number(range[1]);
			if (range[2]) to = Math.min(n - 1, Number(range[2]));
			res.writeHead(206, {
				'content-type': 'application/octet-stream',
				'content-length': String(to - from + 1),
				'content-range': `bytes ${from}-${to}/${n}`,
			});
		} else
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': String(n),
			});
	} else
		// chunked, no length and no validator: nothing to resume by
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
	if (!origin.has(id)) origin.set(id, { written: 0, closedEarly: false });
	send(res, from, to + 1, origin.get(id), rate);
}
/** writes bytes `from` to `end` of the pattern as fast as the socket takes them, or at `rate` */
function send(res, from, end, report, rate) {
	let at = from;
	const t0 = performance.now();
	const more = () => {
		while (at < end) {
			if (rate) {
				const due = ((at - from) / rate) * 1000 - (performance.now() - t0);
				if (due > 0) return void setTimeout(more, Math.max(due, 10));
			}
			const start = at % block.length;
			const part = block.subarray(
				start,
				start +
					Math.min(
						end - at,
						block.length - start,
						rate ? 256 * 1024 : Infinity,
					),
			);
			at += part.length;
			if (report) report.written += part.length;
			if (!res.write(part)) return void res.once('drain', more);
		}
		res.end();
	};
	res.on('close', () => {
		if (report && !res.writableFinished) {
			report.closedEarly = true;
			report.closedAt = performance.now();
		}
		at = end;
	});
	more();
}
async function listen(server) {
	// a keep-alive that outlasts the pause
	server.keepAliveTimeout = 300 * 1000;
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}
const tlsServer = () =>
	createHttpsServer({ cert: certPem, key: keyPem }, handler);
const tlsOrigin = `https://127.0.0.1:${await listen(tlsServer())}`;
const fastOrigin = `https://127.0.0.1:${await listen(tlsServer())}`;
// the same over HTTP/2 only, whose stream windows epoxy (hyper) opens as
// the body is read (boundedBody.ts leaves such a body alone)
const h2Origin = `https://127.0.0.1:${await listen(createHttp2Server({ cert: certPem, key: keyPem }, handler))}`;
// the native yardstick's: the same body over plain HTTP, which Chrome
// takes without the test CA
const plainOrigin = `http://127.0.0.1:${await listen(createHttpServer(handler))}`;

const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
echo.on('connection', (ws) =>
	ws.on('message', (m, binary) => ws.send(m, { binary })),
);
await new Promise((resolve) => echo.once('listening', resolve));
const wsEcho = `ws://127.0.0.1:${echo.address().port}/`;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
// a Chrome of the suite's own (not the run's shared one), marked so its
// processes can be found for their memory
const MARK = `--stomp-paused-body=${process.pid}`;
const browser = await launch([MARK]);
const errors = [];
const workers = await workerMemory(browser);

/** the browser's processes' proportional set size, summed (bytes); null where /proc has none */
function browserPss() {
	let all;
	try {
		all = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
	} catch {
		return null;
	}
	const parent = new Map();
	let root = null;
	for (const pid of all)
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			parent.set(pid, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			if (
				!root &&
				// (Chrome rewrites its command line as one line, spaces between)
				readFileSync(`/proc/${pid}/cmdline`, 'utf8')
					.split(/[\0 ]/)
					.includes(MARK)
			)
				root = pid;
		} catch {
			// gone
		}
	if (!root) return null;
	const ours = new Set([root]);
	for (let grew = true; grew;) {
		grew = false;
		for (const [pid, ppid] of parent)
			if (!ours.has(pid) && ours.has(ppid)) {
				ours.add(pid);
				grew = true;
			}
	}
	let pss = 0;
	for (const pid of ours)
		try {
			const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
			pss += Number(/^Pss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0) * 1024;
		} catch {
			// gone, or not ours to read
		}
	return pss;
}

/** what waited for each reader boundedBody.ts reset (MB), from the host's console */
const resets = [];
/**
 * a tab of `context` with a controller whose transport (one shard, in its
 * worker) rides the carrier host on the relay's WebSocket, or (`via`) a
 * carrier of its own (`own`), or the carrier host on the relay's
 * WebTransport session (`wt`)
 */
async function tab(context, via = '') {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		const held = /fell (\d+) MB behind/.exec(message.text());
		if (held) resets.push(Number(held[1]));
	});
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await start(page, via);
	return page;
}
/** the controller of `page`, its carrier as `via` says (tab) */
async function start(page, via = '') {
	const carrier = await page.evaluate(
		async ({ wisp, caPem, own, wt }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					// stream credit is Wisp v2's (as the demo runs epoxy)
					options: [{ wisp, pem_files: [caPem], wisp_v2: true }],
					host: 'worker',
					shards: 1,
					...(wt && { webTransport: { timeoutMs: 3000 } }),
				},
				directory: '/stomp/',
				codec: 'xor',
				...(own && { carrierHost: false }),
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			window.controller = controller;
			for (let i = 0; i < 100 && !controller.carrier; i++)
				await new Promise((resolve) => setTimeout(resolve, 50));
			return controller.carrier?.carrier ?? null;
		},
		{ wisp: relay.wisp, caPem, own: via === 'own', wt: via === 'wt' },
	);
	if (via === 'wt' && carrier !== 'webtransport')
		throw new Error(`the transport did not ride the session: ${carrier}`);
}

/**
 * In a page: fetch `url` (through the controller's transport, or natively
 * with `fetch`), read `first` bytes, wait for `window.resumePaused` (or
 * cancel at `window.cancelPaused`), read the rest (at `rate` bytes a
 * second, if given), checking the pattern
 */
const pausedRead = async ({ url, first, pattern, proxied, rate }) => {
	window.pausedGot = 0;
	let wrong = -1;
	let error = null;
	let cancelled = false;
	const t0 = performance.now();
	let resumedAt = 0;
	try {
		const response = proxied
			? await window.controller.transport.request(
					new URL(url),
					'GET',
					null,
					[],
					undefined,
				)
			: await fetch(url);
		const reader = response.body.getReader();
		let paused = false;
		for (;;) {
			if (!paused && window.pausedGot >= first) {
				paused = true;
				while (!window.resumePaused && !window.cancelPaused)
					await new Promise((resolve) => setTimeout(resolve, 50));
				if (window.cancelPaused) {
					await reader.cancel('the page let it go');
					cancelled = true;
					break;
				}
				resumedAt = performance.now();
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (wrong < 0)
				for (let i = 0; i < value.length; i++)
					if (value[i] !== (window.pausedGot + i) % pattern) {
						wrong = window.pausedGot + i;
						break;
					}
			window.pausedGot += value.byteLength;
			if (rate) {
				const due = (window.pausedGot / rate) * 1000 - (performance.now() - t0);
				if (due > 0) await new Promise((resolve) => setTimeout(resolve, due));
			}
		}
	} catch (e) {
		error = String(e);
	}
	return {
		got: window.pausedGot,
		wrong,
		error,
		cancelled,
		restMs: Math.round(performance.now() - (resumedAt || t0)),
	};
};

/** In a page: download `bytes` from `origin` and echo over `ws` every 100 ms meanwhile */
const fastRead = async ({ origin, bytes, chunk, ws }) => {
	const echoes = [];
	let echoError = null;
	let pings = 0;
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
	let error = null;
	try {
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
	} catch (e) {
		error = String(e);
	}
	const ms = performance.now() - t0;
	pinging = false;
	await echoed;
	return {
		got,
		error,
		ms: Math.round(ms),
		gap: Math.round(gap),
		pings,
		echoes: echoes.length,
		slowestEcho: Math.round(Math.max(0, ...echoes)),
		echoError,
	};
};

/** In a page: a short request through the transport, read whole */
const oneRequest = async ({ url }) => {
	try {
		const response = await window.controller.transport.request(
			new URL(url),
			'GET',
			null,
			[],
			undefined,
		);
		return (await new Response(response.body).arrayBuffer()).byteLength;
	} catch (e) {
		return String(e);
	}
};

/** a full collection in each of `pages` */
async function collect(context, pages) {
	for (const page of pages) {
		const cdp = await context.newCDPSession(page);
		await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
		await cdp.detach().catch(() => {});
	}
}

const sum = (m) => (m ? m.heap + m.buffers + m.wasm : 0);
const mb = (bytes) =>
	bytes === null || bytes === undefined || !Number.isFinite(bytes)
		? null
		: +(bytes / MB).toFixed(1);

/** the most each figure `measure` gives reached until `until` settles: memory each second, PSS five times a second */
async function peaks(until, measure) {
	const most = {};
	let over = false;
	until.finally(() => (over = true)).catch(() => {});
	const note = (figures) => {
		for (const [key, value] of Object.entries(figures))
			if (value !== null && value !== undefined)
				most[key] = Math.max(most[key] ?? -Infinity, value);
	};
	const pss = (async () => {
		while (!over) {
			note({ pss: browserPss() });
			await Promise.race([sleep(200), until.catch(() => {})]);
		}
	})();
	while (!over) {
		note(await measure());
		await Promise.race([sleep(1000), until.catch(() => {})]);
	}
	await pss;
	return most;
}
const measureWorkers = async () => {
	const memory = await workers.memory();
	return {
		transport: sum(memory.transport),
		transportWasm: memory.transport?.wasm ?? 0,
		carrier: sum(memory.carrier),
	};
};

const results = {};
const want = (name) => !ONLY || ONLY.includes(name);
const fastOK = (fast) =>
	fast.got === FAST_BYTES &&
	!fast.error &&
	fast.gap < GAP_MS &&
	!fast.echoError &&
	fast.pings > 0 &&
	fast.echoes === fast.pings &&
	fast.slowestEcho < GAP_MS;

/** the paused read natively: the yardstick */
async function native(kind) {
	const name = `native-${kind}`;
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	const cdp = await context.newCDPSession(page);
	const heap = async () =>
		(await cdp.send('Runtime.getHeapUsage').catch(() => null))?.usedSize ??
		null;
	await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
	const pss0 = browserPss();
	const heap0 = await heap();
	const read = page.evaluate(pausedRead, {
		url: `${plainOrigin}/big?n=${BIG_BYTES}&kind=${kind}&id=${name}`,
		first: FIRST_BYTES,
		pattern: PATTERN,
		proxied: false,
	});
	const most = await peaks(sleep(PAUSE_MS), async () => ({
		heap: await heap(),
	}));
	const taken = await page.evaluate(() => window.pausedGot);
	const ahead = (origin.get(name)?.written ?? 0) - taken;
	await page.evaluate(() => (window.resumePaused = true));
	const body = await read;
	const result = {
		pssGrewMB: pss0 === null ? null : mb(most.pss - pss0),
		heapGrewMB: mb(most.heap - heap0),
		aheadMB: mb(ahead),
		body,
	};
	results[name] = result;
	console.log(`${name}: ${JSON.stringify(result)}`);
	ok(
		`${name}: natively the paused body arrives whole and in order`,
		body.got === BIG_BYTES && body.wrong < 0 && !body.error,
		JSON.stringify(result),
	);
	await context.close();
}

/** the paused read through the proxy, on a relay with stream credit or without, through the carrier host or not */
async function proxied(credit, kind, via = '') {
	const name = `${via ? `${via}-` : ''}${credit ? 'credit' : 'plain'}-${kind}`;
	relay.streamCredit = credit ? 'emulate' : false;
	const before = { ...relay.stats };
	const requestsBefore = requests;
	const resetsBefore = resets.length;
	const context = await browser.newContext();
	const pausedTab = await tab(context, via);
	const fastTab = await tab(context, via);
	const settled = await workers.memory();
	const pss0 = browserPss();
	const read = pausedTab.evaluate(pausedRead, {
		url: `${kind === 'h2' ? h2Origin : tlsOrigin}/big?n=${BIG_BYTES}&kind=${kind}&id=${name}`,
		first: FIRST_BYTES,
		pattern: PATTERN,
		proxied: true,
	});
	// the other tab's download and echoes, while the reader is paused
	await sleep(2000);
	const fast = fastTab.evaluate(fastRead, {
		origin: fastOrigin,
		bytes: FAST_BYTES,
		chunk: FAST_CHUNK,
		ws: wsEcho,
	});
	const most = await peaks(
		Promise.all([sleep(PAUSE_MS), fast]),
		measureWorkers,
	);
	const fastResult = await fast;
	const taken = await pausedTab.evaluate(() => window.pausedGot);
	const ahead = (origin.get(name)?.written ?? 0) - taken;
	// what is still held once the collector ran everywhere it reaches
	await workers.memory();
	await collect(context, [pausedTab, fastTab]);
	await sleep(1000);
	const pssHeld = browserPss();
	await pausedTab.evaluate(() => (window.resumePaused = true));
	const body = await read;
	const after = await workers.memory();
	const stats = relay.stats;
	const result = {
		transportGrewMB: mb(most.transport - sum(settled.transport)),
		wasmGrewMB: mb(most.transportWasm - (settled.transport?.wasm ?? 0)),
		carrierGrewMB: mb(most.carrier - sum(settled.carrier)),
		pssGrewMB: pss0 === null ? null : mb(most.pss - pss0),
		pssHeldMB: pss0 === null ? null : mb(pssHeld - pss0),
		wasmAfterMB: mb(
			(after.transport?.wasm ?? 0) - (settled.transport?.wasm ?? 0),
		),
		resetHeldMB: resets.slice(resetsBefore),
		aheadMB: mb(ahead),
		originRequests: requests - requestsBefore,
		creditNamed: stats.creditNamed - before.creditNamed,
		// how often the relay stopped reading the wisp server because the
		// session's lanes held more than it lets wait (wisp-wt.mjs highWater)
		relayPaused: stats.paused - before.paused,
		body,
		fast: fastResult,
	};
	results[name] = result;
	console.log(`${name}: ${JSON.stringify(result)}`);
	const detail = JSON.stringify(result);
	// a body nothing holds back waits for its reader in the worker's queue
	// until it is reset (boundedBody.ts HOLD_MAX): the bound is that queue's
	const reset = !credit && kind === 'chunked';
	const workerMax = reset ? RESET_WORKER_MAX : WORKER_MAX;
	ok(
		`${name}: the relay connection ${credit ? 'names' : 'does not name'} stream credit`,
		credit ? result.creditNamed > 0 : result.creditNamed === 0,
		detail,
	);
	ok(
		`${name}: the transport worker's memory (heap, buffers, wasm) grows by less than ${workerMax / MB} MB while the reader is paused, and the carrier host's by less than ${WORKER_MAX / MB} MB`,
		most.transport - sum(settled.transport) < workerMax &&
			most.carrier - sum(settled.carrier) < WORKER_MAX,
		detail,
	);
	// (its peak is not bounded here: what the relay sent before the stream
	// was reset or let go arrives anyway, and passes through as garbage the
	// collector takes when it runs, since no client can unsend it)
	if (pss0 !== null)
		ok(
			`${name}: the whole browser's PSS holds less than ${PSS_MAX / MB} MB more once collected, while the reader is still paused`,
			pssHeld - pss0 < PSS_MAX,
			detail,
		);
	// Not on the session without credit: the relay sends the paused stream
	// as fast as the session takes it until its reset, and keeps what it
	// queued on the stream's lane after the CLOSE, and past lanes x
	// highWater queued it stops reading the wisp server for every stream
	// (wisp-wt.mjs, as holyWisp's design does), so the other tab's bytes
	// wait behind the reset stream's (gaps of 1.0 to 4.5 s measured, the
	// relay pausing 28 to 31 times; none with credit). Nothing a client
	// does can unsend them: stream credit is the remedy
	if (!(via === 'wt' && reset))
		ok(
			`${name}: the other tab downloads and echoes at its own pace meanwhile`,
			fastOK(fastResult),
			detail,
		);
	// with credit the relay holds the stream back, and a body that can be
	// resumed is asked for again: either way it arrives whole once read
	if (credit || kind === 'ranged' || kind === 'h2')
		ok(
			`${name}: the paused body arrives whole and in order once read`,
			body.got === BIG_BYTES && body.wrong < 0 && !body.error,
			detail,
		);
	else
		ok(
			`${name}: the paused body that nothing holds back is reset as a connection is, with no more than ${RESET_HELD_MAX / MB} MB waiting for it, after what came in order`,
			body.wrong < 0 &&
				/network error/.test(body.error ?? '') &&
				result.resetHeldMB.length === 1 &&
				result.resetHeldMB[0] * MB <= RESET_HELD_MAX,
			detail,
		);
	await context.close();
}

/** a reader that reads slowly but never stops, on the relay without credit: never reset */
async function slow() {
	const name = 'plain-slow';
	relay.streamCredit = false;
	const resetsBefore = resets.length;
	const context = await browser.newContext();
	const page = await tab(context);
	const settled = await workers.memory();
	const read = page.evaluate(pausedRead, {
		url: `${tlsOrigin}/big?n=${SLOW_BYTES}&kind=chunked&id=${name}`,
		first: Infinity,
		pattern: PATTERN,
		proxied: true,
		rate: SLOW_RATE,
	});
	const most = await peaks(read, measureWorkers);
	const body = await read;
	const result = {
		transportGrewMB: mb(most.transport - sum(settled.transport)),
		wasmGrewMB: mb(most.transportWasm - (settled.transport?.wasm ?? 0)),
		resetHeldMB: resets.slice(resetsBefore),
		body,
	};
	results[name] = result;
	console.log(`${name}: ${JSON.stringify(result)}`);
	ok(
		`${name}: a reader that reads slowly but never stops gets the whole body in order, and the worker grows by less than ${WORKER_MAX / MB} MB`,
		body.got === SLOW_BYTES &&
			body.wrong < 0 &&
			!body.error &&
			!result.resetHeldMB.length &&
			most.transport - sum(settled.transport) < WORKER_MAX,
		JSON.stringify(result),
	);
	await context.close();
}

/**
 * A transport on the relay with stream credit replaced (setTransport, the
 * same worker) by one whose epoxy speaks Wisp v1, which has no INFO to name
 * credit in: the paused body on the new connection is bounded as on any
 * relay without credit. The realm took the old connection's credit for
 * the new one's until it decided credit per connection (streamCredit.ts),
 * and the body was all in the worker's wasm memory.
 */
async function switched() {
	const name = 'switch-v1-chunked';
	relay.streamCredit = 'emulate';
	const before = { ...relay.stats };
	const resetsBefore = resets.length;
	const context = await browser.newContext();
	const page = await tab(context);
	// the credit relay's connection is up and named it
	const first = await page.evaluate(oneRequest, {
		url: `${fastOrigin}/flow?n=${MB}`,
	});
	const namedBefore = relay.stats.creditNamed - before.creditNamed;
	await page.evaluate(
		async ({ wisp, caPem }) => {
			await window.controller.setTransport({
				module: '/epoxy/index.mjs',
				options: [{ wisp, pem_files: [caPem], wisp_v2: false }],
				host: 'worker',
				shards: 1,
			});
		},
		{ wisp: relay.wisp, caPem },
	);
	const settled = await workers.memory();
	const read = page.evaluate(pausedRead, {
		url: `${tlsOrigin}/big?n=${BIG_BYTES}&kind=chunked&id=${name}`,
		first: FIRST_BYTES,
		pattern: PATTERN,
		proxied: true,
	});
	const most = await peaks(sleep(PAUSE_MS), measureWorkers);
	const taken = await page.evaluate(() => window.pausedGot);
	const ahead = (origin.get(name)?.written ?? 0) - taken;
	await page.evaluate(() => (window.resumePaused = true));
	const body = await read;
	const result = {
		first,
		namedBefore,
		transportGrewMB: mb(most.transport - sum(settled.transport)),
		wasmGrewMB: mb(most.transportWasm - (settled.transport?.wasm ?? 0)),
		resetHeldMB: resets.slice(resetsBefore),
		aheadMB: mb(ahead),
		body,
	};
	results[name] = result;
	console.log(`${name}: ${JSON.stringify(result)}`);
	const detail = JSON.stringify(result);
	ok(
		`${name}: after a switch from a connection with stream credit to a Wisp v1 one, the paused body is bounded: the worker grows by less than ${RESET_WORKER_MAX / MB} MB and the body is reset as a connection is`,
		// the body is reset, so its queue fills to HOLD_MAX first: CI's
		// runners caught it at 60 and 62 MB, over WORKER_MAX
		first === MB &&
			namedBefore > 0 &&
			most.transport - sum(settled.transport) < RESET_WORKER_MAX &&
			body.wrong < 0 &&
			/network error/.test(body.error ?? '') &&
			result.resetHeldMB.length === 1,
		detail,
	);
	await context.close();
}

/**
 * A paused read the page lets go (`cancel`), whose tab reloads (`reload`),
 * or (on the relay with credit, where its stream is still open) whose relay
 * is cut (`cut`): the origin's connection closes, the worker's memory stays
 * bounded, and a request after it works
 */
async function letGo(how, via = '') {
	const credit = how === 'cut';
	const name = `${via ? `${via}-` : ''}${credit ? 'credit' : 'plain'}-${how}`;
	relay.streamCredit = credit ? 'emulate' : false;
	const context = await browser.newContext();
	const page = await tab(context, via);
	const settled = await workers.memory();
	const read = page
		.evaluate(pausedRead, {
			url: `${tlsOrigin}/big?n=${BIG_BYTES}&kind=chunked&id=${name}&rate=${PACED_RATE}`,
			first: FIRST_BYTES,
			pattern: PATTERN,
			proxied: true,
		})
		.catch((error) => ({ error: String(error), gone: true }));
	await sleep(1500);
	const writtenAt = origin.get(name)?.written ?? 0;
	const letGoAt = performance.now();
	if (how === 'cancel') await page.evaluate(() => (window.cancelPaused = true));
	else if (how === 'reload') {
		await page.reload();
		await start(page, via);
	} else {
		relay.cut();
		// the reader reads on, and hears the connection's end
		await page.evaluate(() => (window.resumePaused = true));
	}
	const body = await read;
	// the origin's connection closes within a few seconds
	const t0 = performance.now();
	while (!origin.get(name)?.closedEarly && performance.now() - t0 < 10000)
		await sleep(100);
	const closedMs = Math.round(performance.now() - t0);
	const closedAt = origin.get(name)?.closedAt;
	const most = await peaks(sleep(2000), measureWorkers);
	const again = await page.evaluate(oneRequest, {
		url: `${fastOrigin}/flow?n=${4 * MB}`,
	});
	const result = {
		transportGrewMB: mb(most.transport - sum(settled.transport)),
		carrierGrewMB: mb(most.carrier - sum(settled.carrier)),
		writtenAtLetGoMB: mb(writtenAt),
		writtenMB: mb(origin.get(name)?.written),
		closedEarly: origin.get(name)?.closedEarly,
		closedMs,
		closedAfterLetGoMs:
			closedAt === undefined ? null : Math.round(closedAt - letGoAt),
		body,
		again,
	};
	results[name] = result;
	console.log(`${name}: ${JSON.stringify(result)}`);
	const detail = JSON.stringify(result);
	ok(
		`${name}: the origin's connection closes once the read is let go`,
		result.closedEarly === true && origin.get(name).written < BIG_BYTES,
		detail,
	);
	// a page that lets go, or goes, says so: its stream closes at the relay
	// at once (it was 4.3 s, and 68 MB more from the origin, after a reload
	// through the carrier host: the host read the stream for no one until
	// its rider's queue was full, carrierClient.ts watchPage)
	if (how !== 'cut')
		ok(
			`${name}: it closes within ${LET_GO_MS} ms of the let-go, the origin writing no more than ${LET_GO_AHEAD / MB} MB more`,
			result.closedAfterLetGoMs !== null &&
				result.closedAfterLetGoMs < LET_GO_MS &&
				origin.get(name).written - writtenAt <= LET_GO_AHEAD,
			detail,
		);
	ok(
		`${name}: the worker's and the carrier host's memory stay within ${WORKER_MAX / MB} MB of where they were`,
		most.transport - sum(settled.transport) < WORKER_MAX &&
			most.carrier - sum(settled.carrier) < WORKER_MAX,
		detail,
	);
	ok(`${name}: a request after it is answered whole`, again === 4 * MB, detail);
	await context.close();
}

for (const kind of ['chunked', 'ranged'])
	if (want(`native-${kind}`)) await native(kind);
for (const credit of [true, false])
	for (const kind of ['chunked', 'ranged'])
		if (want(`${credit ? 'credit' : 'plain'}-${kind}`))
			await proxied(credit, kind);
for (const via of ['own', 'wt'])
	for (const credit of [true, false])
		if (want(`${via}-${credit ? 'credit' : 'plain'}-chunked`))
			await proxied(credit, 'chunked', via);
// HTTP/2's windows hold the body back, on either relay and either carrier
for (const via of ['', 'wt'])
	for (const credit of [true, false])
		if (want(`${via ? `${via}-` : ''}${credit ? 'credit' : 'plain'}-h2`))
			await proxied(credit, 'h2', via);
if (want('plain-slow')) await slow();
if (want('switch-v1-chunked')) await switched();
for (const how of ['cancel', 'reload', 'cut'])
	if (want(`${how === 'cut' ? 'credit' : 'plain'}-${how}`)) await letGo(how);
for (const via of ['own', 'wt'])
	if (want(`${via}-plain-reload`)) await letGo('reload', via);

console.log(`paused-body-memory: ${JSON.stringify(results)}`);
await workers.detach();
relay.close();
echo.close();
await done(browser, errors);
