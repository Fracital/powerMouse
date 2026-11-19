// Wisp over the relay's WebTransport session (TransportDescriptor
// .webTransport, src/transport/wispWebTransport.ts). test/wisp-wt.mjs is a
// relay that speaks holyWisp's design (the discovery document on its TCP
// port, the Wisp stream and the datagrams on its UDP one) in front of the
// demo's holyWisp, with the transport in its worker and in the page:
//
// - a start that knows nothing of the relay opens the session and the
//   WebSocket together and rides the session, which is up in time, the
//   WebSocket closed; remembered (IndexedDB) as working, it says so on the
//   console and in the controller's `carrier`. A session that is up too late
//   leaves that start on the WebSocket and is closed, and the next start
//   rides it. The next start rides the session, no WebSocket opened and the
//   document not fetched again: a navigation, a page's
//   fetch, the host's own request and a page's WebSocket, a UDP stream's
//   DATA as datagrams (one too large for a datagram on the Wisp stream),
//   Wisp v2 offered as a protocol; requests in flight when the relay cut the
//   session answer over a new one, and a relay that restarts with a new
//   certificate is reached with it;
// - a stale document (a rotation between the fetch and the handshake) is
//   fetched again and the session is had;
// - no document, blocked UDP, no matching hash, no listener: everything
//   answers over the WebSocket with the first request within noise of the
//   carrier off, the relay is remembered as failing, and the next start
//   tries nothing; once that quiet is over (FAILED_QUIET_MS), a start rides
//   the WebSocket at once and tries a session beside it, and when UDP came
//   back the start after it rides the session;
// - a session whose UDP the network drops (no session close): the next
//   requests answer over the WebSocket, the switch is on the console, and
//   the relay is remembered as failing;
// - a session named by its URL alone (no document), its certificate taken
//   as the Web PKI's;
// - HTTP/3 to an origin through the session (QUIC in the relay's QUIC),
//   with datagrams smaller than QUIC's packets and some of them lost, and
//   then with the flow's UDP lost after the handshake: Chrome's blackhole
//   delay, not QUIC's idle timeout, before the request goes over TCP and
//   the origin is marked broken.
//
// When holyWisp's own build with its WebTransport listener is on the
// machine (HOLYWISP_WT, or ~/src/holyWisp/build/release/holywisp), a page
// and a UDP echo go through it too; skipped otherwise (CI).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { WebSocketServer } from 'ws';
import { done, FIXTURE, launch, ok, PORT, PROXY, sleep } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

const TIMEOUT_MS = 10000;
/** the carrier's timeout here, short so the fallback cases are quick */
const CARRIER_MS = 1500;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
let lossy = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const pki = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);

// a WebSocket echo and a UDP echo the proxied page and the transport reach
const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
echo.on('connection', (ws) =>
	ws.on('message', (m, binary) => ws.send(m, { binary })),
);
await new Promise((resolve) => echo.once('listening', resolve));
const wsEcho = `ws://127.0.0.1:${echo.address().port}/`;
const udpEcho = createSocket('udp4');
udpEcho.on('message', (m, from) => udpEcho.send(m, from.port, from.address));
await new Promise((resolve) => udpEcho.bind(0, '127.0.0.1', resolve));
const udpPort = udpEcho.address().port;

// the session of `pki` is dialed by its URL alone: Chrome takes its
// certificate as one of the Web PKI's for these flags
const browser = await launch([
	`--ignore-certificate-errors-spki-list=${pki.spki}`,
	`--origin-to-force-quic-on=127.0.0.1:${pki.port}`,
]);
const errors = [];

/** starts a controller in `page` whose transport has `webTransport` on, at `wisp` */
function startController(page, host, wisp, extra = {}) {
	return page.evaluate(
		async ({ host, wisp, extra, carrierMs }) => {
			const t0 = performance.now();
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					options: [{ wisp, ...(extra.options ?? {}) }],
					host,
					...(extra.http3 && { http3: extra.http3 }),
					...(extra.webTransport !== false && {
						webTransport: {
							timeoutMs: carrierMs,
							...(extra.webTransport ?? {}),
						},
					}),
				},
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			const element = document.createElement('iframe');
			document.body.append(element);
			Object.assign(window, {
				controller,
				element,
				frame: controller.createFrame(element),
			});
			return Math.round(performance.now() - t0);
		},
		{ host, wisp, extra, carrierMs: CARRIER_MS },
	);
}

/** what this origin remembers of the relay `key` (wispWebTransport.ts memory), or null */
const verdictOf = (page, key) =>
	page.evaluate(
		(key) =>
			new Promise((resolve) => {
				const request = indexedDB.open('stomp-wisp-carrier', 1);
				request.onupgradeneeded = () =>
					request.result.createObjectStore('relays');
				request.onerror = () => resolve(null);
				request.onsuccess = () => {
					const get = request.result
						.transaction('relays')
						.objectStore('relays')
						.get(key);
					get.onsuccess = () => {
						request.result.close();
						resolve(get.result?.verdict ?? null);
					};
					get.onerror = () => resolve(null);
				};
			}),
		key,
	);

/** waits until the origin remembers `key` (the session tried beside the WebSocket settled) */
async function settled(page, key) {
	for (let i = 0; i < 40; i++) {
		const verdict = await verdictOf(page, key);
		if (verdict) return verdict;
		await sleep(150);
	}
	return null;
}

/** the memory key of the auto plan for a wisp URL (wispWebTransport.ts relayPlan) */
const autoKey = (wisp) => `wisp ${wisp}`;

/**
 * A controller page in a context of its own. `learn`: one start first (the
 * WebSocket, a session tried beside it), and once the origin remembers the
 * session worked, the page loaded again and started again, so that it
 * rides the session.
 */
async function controllerPage(
	host,
	wisp,
	extra = {},
	{ learn = false, at = relay } = {},
) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	page.logs = [];
	page.on('console', (message) => page.logs.push(message.text()));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	let started = await startController(page, host, wisp, extra);
	if (learn) {
		const key = extra.key ?? autoKey(wisp);
		page.learned = await settled(page, key);
		await page.goto(`${PROXY}stomp/controllerFrame.html`);
		page.before = { ...at.stats, protocols: [...at.stats.protocols] };
		started = await startController(page, host, wisp, extra);
	}
	return { context, page, started };
}

/** the controller's `carrier` once the transport chose (worker or page), null if it never does */
const carrierInfo = (page) =>
	page.evaluate(async () => {
		for (let i = 0; i < 60 && !window.controller.carrier; i++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		return window.controller.carrier;
	});
/** which carrier the transport chose */
const carrierOf = async (page) => (await carrierInfo(page))?.carrier ?? null;

/** waits until the origin remembers `key` as `want` */
async function settledTo(page, key, want) {
	for (let i = 0; i < 40; i++) {
		const verdict = await verdictOf(page, key);
		if (verdict === want) return verdict;
		await sleep(150);
	}
	return verdictOf(page, key);
}

/** FAILED_QUIET_MS went by for `key`: what failed is tried beside the WebSocket again */
const endQuiet = (page, key) =>
	page.evaluate(
		(key) =>
			new Promise((resolve) => {
				const request = indexedDB.open('stomp-wisp-carrier', 1);
				request.onerror = () => resolve(false);
				request.onsuccess = () => {
					const store = request.result
						.transaction('relays', 'readwrite')
						.objectStore('relays');
					const get = store.get(key);
					get.onsuccess = () => {
						if (!get.result) return resolve(false);
						store.put({ ...get.result, quiet: 0 }, key).onsuccess = () => {
							request.result.close();
							resolve(true);
						};
					};
				};
			}),
		key,
	);

/** a navigation, a page's fetch and the host's own request, each "ok@ms" or why not */
function load(page, url, title) {
	return page.evaluate(
		async ({ url, title, timeoutMs }) => {
			const t0 = performance.now();
			const at = (result) => `${result}@${Math.round(performance.now() - t0)}`;
			const hung = new Promise((resolve) =>
				setTimeout(() => resolve('HUNG'), timeoutMs),
			);
			const settle = (promise) =>
				Promise.race([promise, hung]).catch((error) =>
					String(error).slice(0, 200),
				);
			const navigation = window.frame.go(url).then(() => {
				const got = window.element.contentDocument?.title;
				return at(got === title ? 'ok' : `title ${got}`);
			});
			const win = () => window.element.contentWindow;
			const fetched = navigation.then(() =>
				Reflect.apply(win().fetch, win(), [
					`${url.replace(/[^/]*$/, 'echo.json')}?${Date.now()}`,
				]).then((r) => at(r.status === 200 ? 'ok' : `status ${r.status}`)),
			);
			const raw = window.controller.transport
				.request(new URL(`${url}?raw${Date.now()}`), 'GET', null, [], undefined)
				.then(async (r) => {
					await new Response(r.body).arrayBuffer();
					return at(r.status === 200 ? 'ok' : `status ${r.status}`);
				});
			return {
				navigation: await settle(navigation),
				fetch: await settle(fetched),
				raw: await settle(raw),
			};
		},
		{ url, title, timeoutMs: TIMEOUT_MS },
	);
}
const allOk = (result) =>
	Object.values(result).every((r) => r.startsWith('ok@'));

/** a WebSocket of the proxied page, echoed three times */
const socketEcho = (page, url) =>
	page.evaluate(
		({ url, timeoutMs }) => {
			const win = window.element.contentWindow;
			return new Promise((resolve) => {
				const got = [];
				const ws = new win.WebSocket(url);
				const timer = setTimeout(() => resolve(`HUNG after ${got}`), timeoutMs);
				ws.onopen = () => ['one', 'two', 'three'].forEach((m) => ws.send(m));
				ws.onmessage = (event) => {
					got.push(event.data);
					if (got.length === 3) {
						clearTimeout(timer);
						ws.close();
						resolve(got.join(','));
					}
				};
				ws.onerror = () => resolve(`error after ${got}`);
			});
		},
		{ url, timeoutMs: TIMEOUT_MS },
	);

/**
 * A UDP stream of the page-hosted transport's wisp client to the echo:
 * `sizes` datagrams sent, the sizes echoed back
 */
const udpRoundTrip = (page, port, sizes) =>
	page.evaluate(
		async ({ port, sizes, timeoutMs }) => {
			let t = window.controller.transport;
			while (t && !(t.client && t.client.connect_udp)) t = t.base;
			if (!t) return 'no wisp client';
			const stream = await t.client.connect_udp(`udp://127.0.0.1:${port}`);
			const writer = stream.write.getWriter();
			const reader = stream.read.getReader();
			const got = [];
			const deadline = Date.now() + timeoutMs;
			for (const size of sizes) {
				const out = new Uint8Array(size).fill(size & 0xff);
				// UDP may lose one: send again until it comes back
				for (;;) {
					await writer.write(out);
					const answer = await Promise.race([
						reader.read(),
						new Promise((resolve) => setTimeout(() => resolve(null), 300)),
					]);
					if (answer && !answer.done) {
						got.push(answer.value.byteLength);
						break;
					}
					if (Date.now() > deadline) return `HUNG after ${got}`;
				}
			}
			writer.close().catch(() => {});
			return got.join(',');
		},
		{ port, sizes, timeoutMs: TIMEOUT_MS },
	);

const snapshot = () => ({
	...relay.stats,
	protocols: [...relay.stats.protocols],
});
const delta = (before) => {
	const now = relay.stats;
	return Object.fromEntries(
		Object.entries(now)
			.filter(([, v]) => typeof v === 'number')
			.map(([k, v]) => [k, v - before[k]]),
	);
};
const reset = () => {
	relay.document = null;
	relay.udpBlocked = false;
};

for (const host of ['worker', 'page']) {
	// over the session
	// nothing known of the relay: the session and the WebSocket together,
	// the session taken as it is up in time, the WebSocket closed
	{
		reset();
		const before = snapshot();
		const fresh = await controllerPage(host, relay.wisp);
		const result = await load(
			fresh.page,
			`${FIXTURE}pages/walk-1.html`,
			'WALK 1',
		);
		const verdict = await settled(fresh.page, autoKey(relay.wisp));
		const info = await carrierInfo(fresh.page);
		await sleep(300);
		const d = delta(before);
		ok(
			`${host} first start: everything answers`,
			allOk(result),
			JSON.stringify(result),
		);
		ok(
			`${host} first start: it rides the WebTransport session, as the controller's carrier says`,
			info?.carrier === 'webtransport' &&
				info.url === relay.url &&
				Number.isFinite(info.ms) &&
				d.sessions === 1 &&
				d.sessionsClosed === 0,
			JSON.stringify({ info, d }),
		);
		ok(
			`${host} first start: the WebSocket opened beside it was closed`,
			d.ws === 1 && d.wsClosed === 1,
			JSON.stringify(d),
		);
		ok(
			`${host} first start: remembered as working, the document fetched once`,
			d.documents === 1 && verdict === 'worked',
			JSON.stringify({ verdict, d }),
		);
		// on the controller's page wherever the transport runs (the worker
		// hands its notes over)
		ok(
			`${host} first start: the console says it at a glance`,
			fresh.page.logs.includes(
				`[wisp] WebTransport session established in ${info?.ms} ms: wisp transport WebTransport (UDP/QUIC) to ${relay.url} (epoxy, HTTP/3 off)`,
			),
			JSON.stringify(fresh.page.logs.filter((l) => l.startsWith('[wisp]'))),
		);
		await fresh.context.close();
	}

	// a session that is up too late for the first start: the WebSocket, the
	// session closed once it is up and remembered, the next start on it
	{
		reset();
		relay.documentDelay = 600;
		// the last context's session close reaches the relay first
		await sleep(300);
		const before = snapshot();
		const { context, page } = await controllerPage(host, relay.wisp);
		const result = await load(page, `${FIXTURE}pages/walk-2.html`, 'WALK 2');
		const info = await carrierInfo(page);
		const verdict = await settled(page, autoKey(relay.wisp));
		await sleep(300);
		const d = delta(before);
		relay.documentDelay = 0;
		ok(
			`${host} late session: the first start rides the WebSocket, saying why`,
			allOk(result) &&
				info?.carrier === 'websocket' &&
				/within \d+ ms of the WebSocket/.test(info.why) &&
				d.ws === 1 &&
				d.wsClosed === 0,
			JSON.stringify({ result, info, d }),
		);
		ok(
			`${host} late session: the session was closed once it was up, remembered as working`,
			d.sessions === 1 && d.sessionsClosed === 1 && verdict === 'worked',
			JSON.stringify({ verdict, d }),
		);
		const again = snapshot();
		await page.goto(`${PROXY}stomp/controllerFrame.html`);
		await startController(page, host, relay.wisp);
		const next = await load(page, `${FIXTURE}pages/walk-3.html`, 'WALK 3');
		const d2 = delta(again);
		ok(
			`${host} late session: the next start rides it, no WebSocket`,
			allOk(next) &&
				(await carrierOf(page)) === 'webtransport' &&
				d2.ws === 0 &&
				d2.sessions === 1,
			JSON.stringify({ next, d2 }),
		);
		await context.close();
	}

	// remembered as working: over the session
	{
		reset();
		const { context, page } = await controllerPage(
			host,
			relay.wisp,
			{},
			{ learn: true },
		);
		const before = page.before;
		const result = await load(page, `${FIXTURE}pages/walk-1.html`, 'WALK 1');
		ok(
			`${host}: a navigation, a fetch and a raw request answer`,
			allOk(result),
			JSON.stringify(result),
		);
		const d = delta(before);
		ok(
			`${host}: the next start rides a WebTransport session, no WebSocket opened, the document kept`,
			page.learned === 'worked' &&
				d.sessions === 1 &&
				d.ws === 0 &&
				d.documents === 0,
			JSON.stringify({ learned: page.learned, d }),
		);
		ok(
			`${host}: the transport says it rides WebTransport`,
			(await carrierOf(page)) === 'webtransport',
		);
		const echoed = await socketEcho(page, wsEcho);
		ok(
			`${host}: a page's WebSocket echoes over the session`,
			echoed === 'one,two,three',
			echoed,
		);
		// TLS handshakes to a host the wisp server refuses, started with
		// plain requests beside them (epoxy-tls 0075: before it, a
		// handshake's flush held the session's sink and every request on the
		// connection hung)
		const refused = await page.evaluate(
			async ({ fixture, timeoutMs }) => {
				const hung = new Promise((resolve) =>
					setTimeout(() => resolve('HUNG'), timeoutMs),
				);
				const get = (url) =>
					Promise.race([
						window.controller.transport
							.request(new URL(url), 'GET', null, [], undefined)
							.then(async (r) => {
								await new Response(r.body).arrayBuffer();
								return `status ${r.status}`;
							}),
						hung,
					]).catch(() => 'failed');
				return Promise.all([
					...['a', 'b', 'c', 'd'].map((n) =>
						get(`https://${n}.refused.invalid/`),
					),
					get(`${fixture}pages/walk-3.html?beside-refused`),
					get(`${fixture}pages/walk-2.html?beside-refused`),
				]);
			},
			{ fixture: FIXTURE, timeoutMs: TIMEOUT_MS },
		);
		ok(
			`${host}: four TLS requests to a host the wisp server refuses fail, and two plain ones started with them answer`,
			refused.slice(0, 4).every((r) => r === 'failed') &&
				refused.slice(4).every((r) => r === 'status 200'),
			JSON.stringify(refused),
		);
		// the relay cuts the Wisp stream into chunks of a few bytes and of
		// more than a packet, so length prefixes and packets span chunks:
		// two bodies of a megabyte read back byte for byte
		relay.pieces = [1, 3, 2, 4, 7, 1500, 5, 70000, 16384];
		const cut = await page.evaluate(
			async ({ url, timeoutMs }) => {
				const hung = new Promise((resolve) =>
					setTimeout(() => resolve('HUNG'), timeoutMs * 3),
				);
				const digest = (i) =>
					window.controller.transport
						.request(new URL(`${url}?cut${i}`), 'GET', null, [], undefined)
						.then(async (r) => {
							const body = await new Response(r.body).arrayBuffer();
							const hash = await crypto.subtle.digest('SHA-256', body);
							return `${r.status} ${body.byteLength} ${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
						});
				return Promise.race([Promise.all([digest(1), digest(2)]), hung]).catch(
					(error) => String(error).slice(0, 200),
				);
			},
			{
				url: `${FIXTURE}pages/prewrite-big.html.bin`,
				timeoutMs: TIMEOUT_MS,
			},
		);
		relay.pieces = [];
		const big = readFileSync(
			new URL('../pages/prewrite-big.html.bin', import.meta.url),
		);
		const want = `200 ${big.length} ${createHash('sha256').update(big).digest('hex')}`;
		ok(
			`${host}: bodies whose packets and length prefixes the relay cut across chunks read back byte for byte`,
			Array.isArray(cut) && cut.every((r) => r === want),
			JSON.stringify({ cut, want }),
		);
		if (host === 'page') {
			const udp = delta(before);
			const small = await udpRoundTrip(page, udpPort, [32, 600, 1000]);
			const small2 = delta(before);
			ok(
				`page: UDP datagrams of a wisp stream echo`,
				small === '32,600,1000',
				small,
			);
			ok(
				'page: their DATA went as WebTransport datagrams both ways, none on the stream',
				small2.datagramsIn - udp.datagramsIn >= 3 &&
					small2.datagramsOut - udp.datagramsOut >= 3 &&
					small2.udpOnStreamIn === udp.udpOnStreamIn &&
					small2.udpOnStreamOut === udp.udpOnStreamOut,
				JSON.stringify(small2),
			);
			const large = await udpRoundTrip(page, udpPort, [1400]);
			const large2 = delta(before);
			ok(
				'page: a UDP datagram too large for a WebTransport datagram echoes',
				large === '1400',
				large,
			);
			// the relay's answer goes as a datagram when the server's side
			// allows one that large (quinn's limit is the path's, not Chrome's
			// maxDatagramSize), so only the page's direction is held to it
			ok(
				'page: it went from the page on the Wisp stream',
				large2.udpOnStreamIn > small2.udpOnStreamIn &&
					large2.datagramsIn === small2.datagramsIn,
				JSON.stringify(large2),
			);
		}

		// the relay restarts with requests in flight: they answer over a new session
		const opened = relay.stats.sessions;
		await page.evaluate(
			({ fixture, timeoutMs }) => {
				const t0 = performance.now();
				const hung = new Promise((resolve) =>
					setTimeout(() => resolve('HUNG'), timeoutMs),
				);
				const slow = (i) => `${fixture}slow-js?ms=1500&i=${i}-${Date.now()}`;
				const answer = (promise) =>
					Promise.race([
						promise.then(async (r) => {
							await new Response(r.body).text();
							return `${r.status === 200 ? 'ok' : `status ${r.status}`}@${Math.round(performance.now() - t0)}`;
						}),
						hung,
					]).catch((error) => String(error).slice(0, 200));
				const win = window.element.contentWindow;
				window.inFlight = Promise.all([
					...[0, 1].map((i) =>
						answer(
							window.controller.transport.request(
								new URL(slow(`raw${i}`)),
								'GET',
								null,
								[],
								undefined,
							),
						),
					),
					...[0, 1].map((i) =>
						answer(Reflect.apply(win.fetch, win, [slow(`page${i}`)])),
					),
				]);
			},
			{ fixture: FIXTURE, timeoutMs: TIMEOUT_MS },
		);
		await sleep(500);
		const wsBefore = relay.stats.ws;
		relay.cut();
		const inFlight = await page.evaluate(() => window.inFlight);
		ok(
			`${host}: GETs in flight when the relay cut the session all answer`,
			inFlight.every((r) => r.startsWith('ok@')),
			JSON.stringify(inFlight),
		);
		ok(
			`${host}: over a new session`,
			relay.stats.sessions > opened && relay.stats.ws === wsBefore,
			`${opened} -> ${relay.stats.sessions}, ws ${wsBefore} -> ${relay.stats.ws}`,
		);

		// a new certificate: the document lists it and the old one
		const rotated = relay.stats.sessions;
		await relay.rotate();
		await sleep(300);
		const after = await load(page, `${FIXTURE}pages/walk-2.html`, 'WALK 2');
		ok(
			`${host}: after the relay restarted with a new certificate, everything answers`,
			allOk(after),
			JSON.stringify(after),
		);
		ok(
			`${host}: over a session with the new certificate, no WebSocket`,
			relay.stats.sessions > rotated && relay.stats.ws === wsBefore,
			`${rotated} -> ${relay.stats.sessions}, ws ${relay.stats.ws}`,
		);
		await context.close();
	}

	// Wisp v2: offered as a protocol, answered with it
	{
		reset();
		const before = snapshot();
		const { context, page } = await controllerPage(
			host,
			relay.wisp,
			{ options: { wisp_v2: true } },
			{ learn: true },
		);
		const result = await load(page, `${FIXTURE}pages/walk-3.html`, 'WALK 3');
		ok(
			`${host} v2: over the session`,
			relay.stats.sessions > page.before.sessions &&
				relay.stats.ws === page.before.ws,
			JSON.stringify(delta(page.before)),
		);
		ok(`${host} v2: everything answers`, allOk(result), JSON.stringify(result));
		const protocols = relay.stats.protocols.slice(before.protocols.length);
		ok(
			`${host} v2: the session offered wisp-v2`,
			protocols.length >= 1 && protocols.every((p) => p === 'wisp-v2'),
			JSON.stringify(protocols),
		);
		await context.close();
	}

	// a stale document: the handshake fails, the document is fetched again
	{
		reset();
		const from = relay.stats.documents;
		const stale = {
			url: relay.url,
			hashes: [
				{ algorithm: 'sha-256', value: Buffer.alloc(32, 7).toString('base64') },
			],
		};
		relay.document = (count) => (count === from + 1 ? stale : relay.answer());
		const before = snapshot();
		const { context, page } = await controllerPage(host, relay.wisp);
		const result = await load(page, `${FIXTURE}pages/walk-4.html`, 'WALK 4');
		const verdict = await settled(page, autoKey(relay.wisp));
		const d = delta(before);
		ok(
			`${host} stale document: everything answers`,
			allOk(result),
			JSON.stringify(result),
		);
		ok(
			`${host} stale document: fetched again, then a session, remembered as working`,
			d.documents === 2 && d.sessions === 1 && verdict === 'worked',
			JSON.stringify({ verdict, d }),
		);
		await context.close();
	}

	// what the first request costs with the carrier off: the fallbacks are
	// held to it, as nothing waits for a session not had before
	const baseline = await (async () => {
		const plain = await controllerPage(host, relay.wisp, {
			webTransport: false,
		});
		const result = await load(
			plain.page,
			`${FIXTURE}pages/walk-5.html`,
			'WALK 5',
		);
		await plain.context.close();
		return plain.started + Number(result.raw.split('@')[1] ?? Infinity);
	})();

	// the fallbacks: each ends on the WebSocket, and everything answers
	const fallbacks = [
		['no discovery document', () => (relay.document = () => null)],
		['UDP blocked', () => (relay.udpBlocked = true)],
		[
			'no listed hash matches',
			() =>
				(relay.document = () => ({
					url: relay.url,
					hashes: [
						{
							algorithm: 'sha-256',
							value: Buffer.alloc(32, 9).toString('base64'),
						},
					],
				})),
		],
		[
			'no WebTransport listener',
			() =>
				(relay.document = () => ({ url: 'https://127.0.0.1:9/', hashes: [] })),
		],
	];
	for (const [name, arrange] of fallbacks) {
		reset();
		arrange();
		const before = snapshot();
		const { context, page, started } = await controllerPage(host, relay.wisp);
		const result = await load(page, `${FIXTURE}pages/walk-5.html`, 'WALK 5');
		// the controller's start and the host's request: the time to the
		// first answer
		const ms = started + Number(result.raw.split('@')[1] ?? Infinity);
		const verdict = await settled(page, autoKey(relay.wisp));
		const d = delta(before);
		ok(
			`${host} ${name}: everything answers`,
			allOk(result),
			JSON.stringify(result),
		);
		ok(
			`${host} ${name}: over the WebSocket`,
			d.ws >= 1 && d.sessions === 0,
			JSON.stringify(d),
		);
		// no wait for the session: within noise of the carrier off
		ok(
			`${host} ${name}: the first request answered ${ms} ms after the start, ${baseline} ms with the carrier off`,
			ms < baseline + 400,
		);
		ok(
			`${host} ${name}: remembered as failing`,
			verdict === 'failed',
			String(verdict),
		);
		const info = await carrierInfo(page);
		ok(
			`${host} ${name}: the transport says it rides the WebSocket, and why`,
			info?.carrier === 'websocket' && !!info.why,
			JSON.stringify(info),
		);
		const echoed = await socketEcho(page, wsEcho);
		ok(
			`${host} ${name}: a page's WebSocket echoes`,
			echoed === 'one,two,three',
			echoed,
		);
		// the next start of the origin tries nothing
		const again = snapshot();
		await page.goto(`${PROXY}stomp/controllerFrame.html`);
		await startController(page, host, relay.wisp);
		const next = await load(page, `${FIXTURE}pages/walk-4.html`, 'WALK 4');
		const d2 = delta(again);
		ok(
			`${host} ${name}: the next start goes to the WebSocket without a document or a handshake`,
			allOk(next) && d2.documents === 0 && d2.sessions === 0 && d2.ws >= 1,
			JSON.stringify({ next, d2 }),
		);
		await context.close();
	}

	// UDP comes back after a failure: once the quiet is over, the WebSocket
	// at once with a session beside it, then the session
	{
		reset();
		relay.udpBlocked = true;
		const key = autoKey(relay.wisp);
		const { context, page } = await controllerPage(host, relay.wisp);
		await load(page, `${FIXTURE}pages/walk-5.html`, 'WALK 5');
		const failed = await settled(page, key);
		relay.udpBlocked = false;
		const quietOver = await endQuiet(page, key);
		const before = snapshot();
		await page.goto(`${PROXY}stomp/controllerFrame.html`);
		await startController(page, host, relay.wisp);
		const result = await load(page, `${FIXTURE}pages/walk-4.html`, 'WALK 4');
		const info = await carrierInfo(page);
		const verdict = await settledTo(page, key, 'worked');
		const d = delta(before);
		ok(
			`${host} recovery: after the quiet, the WebSocket at once with a session tried beside it`,
			failed === 'failed' &&
				quietOver &&
				allOk(result) &&
				info?.carrier === 'websocket' &&
				/tried beside the WebSocket/.test(info.why) &&
				d.ws >= 1 &&
				d.sessions === 1,
			JSON.stringify({ failed, quietOver, result, info, d }),
		);
		ok(
			`${host} recovery: the session is remembered as working again`,
			verdict === 'worked',
			String(verdict),
		);
		const again = snapshot();
		await page.goto(`${PROXY}stomp/controllerFrame.html`);
		await startController(page, host, relay.wisp);
		const next = await load(page, `${FIXTURE}pages/walk-3.html`, 'WALK 3');
		const d2 = delta(again);
		ok(
			`${host} recovery: the next start rides the session`,
			allOk(next) &&
				(await carrierOf(page)) === 'webtransport' &&
				d2.ws === 0 &&
				d2.sessions === 1,
			JSON.stringify({ next, d2 }),
		);
		await context.close();
	}

	// a session the network drops UDP under: the WebSocket at once, and
	// the relay remembered as failing
	{
		lossy.udpBlocked = false;
		const { context, page } = await controllerPage(
			host,
			lossy.wisp,
			{},
			{ learn: true, at: lossy },
		);
		const first = await load(page, `${FIXTURE}pages/walk-1.html`, 'WALK 1');
		const on = { ...lossy.stats };
		await lossy.drop();
		const after = await load(page, `${FIXTURE}pages/walk-2.html`, 'WALK 2');
		// nothing known after the loss, then the session tried beside the
		// WebSocket fails
		const verdict = await settled(page, autoKey(lossy.wisp));
		ok(
			`${host} UDP lost under the session: before it, over the session`,
			allOk(first) && page.learned === 'worked' && on.ws === page.before.ws,
			JSON.stringify({ first, learned: page.learned }),
		);
		ok(
			`${host} UDP lost under the session: everything answers over the WebSocket`,
			allOk(after) &&
				lossy.stats.ws > on.ws &&
				lossy.stats.sessions === on.sessions,
			JSON.stringify({
				after,
				ws: lossy.stats.ws - on.ws,
				sessions: lossy.stats.sessions - on.sessions,
			}),
		);
		ok(
			`${host} UDP lost under the session: remembered as failing`,
			verdict === 'failed',
			String(verdict),
		);
		ok(
			`${host} UDP lost under the session: the controller's carrier says the WebSocket`,
			(await carrierInfo(page))?.carrier === 'websocket',
		);
		ok(
			`${host} UDP lost under the session: the console says it switched`,
			page.logs.includes('[wisp] switched from WebTransport to WebSocket'),
			JSON.stringify(page.logs.filter((l) => l.startsWith('[wisp]'))),
		);
		await context.close();
		await lossy.close();
		lossy = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
	}

	// a session named by its URL alone, its certificate taken as the Web PKI's
	{
		const documents = pki.stats.documents;
		const { context, page } = await controllerPage(
			host,
			pki.wisp,
			{ webTransport: { url: pki.url }, key: pki.url },
			{ learn: true, at: pki },
		);
		const result = await load(page, `${FIXTURE}pages/walk-3.html`, 'WALK 3');
		const d = {
			sessions: pki.stats.sessions - page.before.sessions,
			ws: pki.stats.ws - page.before.ws,
			documents: pki.stats.documents - documents,
		};
		ok(
			`${host} by URL: everything answers over the session, no document fetched`,
			allOk(result) &&
				page.learned === 'worked' &&
				d.sessions === 1 &&
				d.ws === 0 &&
				d.documents === 0,
			JSON.stringify({ result, learned: page.learned, d }),
		);
		await context.close();
	}
}

// HTTP/3 through the session: QUIC inside the relay's QUIC. An h3 origin
// (test/wtserver.mjs, whose answer to a GET is a 404 over HTTP/3) with an
// HTTPS server on the same TCP port that offers it (Alt-Svc) and answers
// 200, the way a site's TCP and UDP sides sit, both trusted through the
// test CA. stomp-h3's packets (1250 bytes) and the server's handshake
// (1200) are larger than this relay's datagrams (1000), so they go on the
// Wisp stream both ways while the small ones go as datagrams, and a tenth
// of those are lost: every request still answers over HTTP/3. Then the
// session stops carrying the flow's UDP either way (the session lives):
// a request on the connection must not wait for stomp-h3's 30 s idle
// timeout. As Chrome does with a blackhole (6.4 s on loopback, measured),
// the connection is closed, the request goes over TCP, and the origin is
// marked broken, so the next request goes over TCP at once.
{
	const h3 = await startWebTransportServer({ port: 0 });
	const tcpSeen = [];
	const site = createHttps({ cert: h3.certPem, key: h3.keyPem }, (req, res) => {
		tcpSeen.push(req.url);
		res.setHeader('alt-svc', `h3=":${h3.port}"; ma=3600`);
		res.setHeader('content-type', 'text/plain');
		res.end('tcp');
	});
	await new Promise((resolve) => site.listen(h3.port, '127.0.0.1', resolve));
	const origin = `https://127.0.0.1:${h3.port}`;
	const { context, page } = await controllerPage(
		'page',
		relay.wisp,
		{
			options: { pem_files: [h3.caPem] },
			http3: { pem: h3.caPem, timeout: 5000 },
		},
		{ learn: true },
	);
	const get = (path) =>
		page.evaluate(async (url) => {
			const t = window.controller.transport;
			const t0 = performance.now();
			try {
				const response = await Promise.race([
					t.request(new URL(url), 'GET', null, [], undefined),
					new Promise((resolve, reject) =>
						setTimeout(() => reject(new Error('HUNG')), 20000),
					),
				]);
				await new Response(response.body).arrayBuffer();
				return {
					status: response.status,
					via: t.info().recent.at(-1)?.via,
					ms: Math.round(performance.now() - t0),
				};
			} catch (error) {
				return {
					error: String(error).slice(0, 160),
					ms: Math.round(performance.now() - t0),
				};
			}
		}, `${origin}${path}`);
	const info = () => page.evaluate(() => window.controller.transport.info());
	ok(
		'h3 through the session: the transport rides the session',
		(await carrierOf(page)) === 'webtransport',
	);
	relay.datagramMax = 1000;
	relay.datagramLoss = 0.1;
	const before = snapshot();
	const learned = await get('/learn');
	let up = false;
	for (let i = 0; i < 80 && !up; i++) {
		up = (await info()).connections.some((c) => c.alive);
		if (!up) await sleep(100);
	}
	const lossy = [];
	for (let i = 0; i < 6; i++) lossy.push(await get(`/lossy?${i}`));
	const d = delta(before);
	ok(
		'h3 through the session, datagrams of 1000 bytes and a tenth of them lost: every request answers over HTTP/3',
		learned.status === 200 &&
			up &&
			lossy.every((r) => r.status === 404 && r.via === 'h3'),
		JSON.stringify({ learned, up, lossy }),
	);
	ok(
		"h3 through the session: QUIC's packets too large for a datagram went on the Wisp stream both ways, the rest as datagrams",
		d.udpOnStreamIn > 0 &&
			d.udpOnStreamOut > 0 &&
			d.datagramsIn > 0 &&
			d.datagramsOut > 0 &&
			d.datagramsLost > 0,
		JSON.stringify(d),
	);
	relay.udpLost = true;
	const dark = await get('/dark');
	const next = await get('/next');
	const after = await info();
	const entry = after.altSvc.find((e) => e.origin === origin);
	ok(
		"h3 through the session, its UDP lost after the handshake: the request goes over TCP at Chrome's blackhole delay, not QUIC's idle timeout",
		dark.status === 200 &&
			dark.via === 'base-after-h3' &&
			dark.ms > 5000 &&
			dark.ms < 10000,
		JSON.stringify(dark),
	);
	ok(
		'h3 through the session: and the origin is marked broken, the next request over TCP at once',
		entry?.brokenUntil > Date.now() &&
			next.status === 200 &&
			next.via === 'base' &&
			next.ms < 1500 &&
			!after.connections.some((c) => c.alive),
		JSON.stringify({ next, entry, connections: after.connections }),
	);
	relay.datagramMax = 0;
	relay.datagramLoss = 0;
	relay.udpLost = false;
	await context.close();
	site.close();
	await h3.close();
}

// holyWisp's own listener, when its build is on the machine
const holyWisp =
	process.env.HOLYWISP_WT || `${homedir()}/src/holyWisp/build/release/holywisp`;
const holyWispStats = { stats: { protocols: [] } };
if (!existsSync(holyWisp)) {
	console.log(`SKIP holyWisp's WebTransport listener: no build at ${holyWisp}`);
} else {
	const free = createServer();
	await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
	const port = free.address().port;
	await new Promise((resolve) => free.close(resolve));
	const child = spawn(
		holyWisp,
		[
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--allow-loopback',
			'--allow-direct-ip',
			'--webtransport=true',
		],
		{ stdio: ['ignore', 'ignore', 'inherit'] },
	);
	try {
		let document = null;
		for (let i = 0; i < 40 && !document; i++) {
			await sleep(250);
			document = await fetch(`http://127.0.0.1:${port}/webtransport.json`)
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null);
		}
		ok(
			'holyWisp: its listener answers /webtransport.json',
			document?.hashes?.length >= 1,
			JSON.stringify(document),
		);
		const { context, page } = await controllerPage(
			'page',
			`ws://127.0.0.1:${port}/`,
			{},
			{ learn: true, at: holyWispStats },
		);
		const result = await load(page, `${FIXTURE}pages/walk-1.html`, 'WALK 1');
		ok(
			'holyWisp: a navigation, a fetch and a raw request answer',
			allOk(result),
			JSON.stringify(result),
		);
		ok(
			'holyWisp: over its WebTransport listener',
			(await carrierOf(page)) === 'webtransport',
		);
		const echoed = await socketEcho(page, wsEcho);
		ok(
			"holyWisp: a page's WebSocket echoes",
			echoed === 'one,two,three',
			echoed,
		);
		const udp = await udpRoundTrip(page, udpPort, [32, 1000, 1400]);
		ok(
			'holyWisp: UDP echoes, by datagram and on the stream',
			udp === '32,1000,1400',
			udp,
		);
		await context.close();
		const v2 = await controllerPage(
			'page',
			`ws://127.0.0.1:${port}/`,
			{ options: { wisp_v2: true } },
			{ learn: true, at: holyWispStats },
		);
		const result2 = await load(
			v2.page,
			`${FIXTURE}pages/walk-2.html`,
			'WALK 2',
		);
		ok(
			'holyWisp v2: everything answers',
			allOk(result2),
			JSON.stringify(result2),
		);
		ok(
			'holyWisp v2: over its WebTransport listener',
			(await carrierOf(v2.page)) === 'webtransport',
		);
		await v2.context.close();
	} finally {
		child.kill('SIGKILL');
	}
}

echo.close();
udpEcho.close();
await relay.close();
await lossy.close();
await pki.close();
await done(browser, errors);
