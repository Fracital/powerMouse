// HTTP/3 fallback without the internet: an Http3Transport around a stand-in
// base transport that answers every request at once with the Alt-Svc the
// URL asks for, and a datagram channel chosen per check and per host
// (refused, closed at once like a wisp server refusing the stream, with or
// without a close reason, a black hole that never answers, or one that
// echoes). What must hold, as in Chrome: Alt-Svc is learned only from https
// origins, only for h3 and only for the origin's own host, `clear` forgets
// it; a request never waits on a QUIC handshake that has not worked yet; a
// failed handshake marks the origin broken and the base transport serves it
// with no stall; a forced origin waits at most the handshake timeout. And
// what a refused UDP stream means (docs/http3.md, rule 5): HTTP/3 goes off
// for that origin alone, and for every origin only when the relay itself
// is shown to have no UDP (a wisp v2 server without the UDP extension, or
// eight hosts refused with nothing ever carried), until a new wisp
// connection. The last part runs the same over a real epoxy client and the
// demo's wisp server, behind a gate that refuses UDP per name
// (test/wisp-gate.mjs), with datagrams that really cross to a UDP server
// here. The stomp-h3 module comes from the epoxy build (deploy/epoxy/h3);
// without it, the checks that need it are skipped and the module error path
// is checked.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { done, launch, ok, PORT, PROXY } from '../lib.mjs';
import { startWispGate } from '../wisp-gate.mjs';

const H3 = '/epoxy/h3/stomp_h3.js';
const browser = await launch();
const errors = [];
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);

const present = await page.evaluate(
	async (url) => (await fetch(url, { method: 'HEAD' })).status === 200,
	H3,
);

// A stand-in for stomp-h3 that needs no QUIC server: the handshake is one
// datagram out and one back, a request is the same, and a channel that ends
// first fails the handshake the way stomp-h3 words it. Over a channel that
// echoes it is a connection that works; a datagram really has to come back.
const DATAGRAM_H3 = `data:text/javascript,${encodeURIComponent(`
	export default async function init() {}
	export async function connect(host, readable, writable, options) {
		const reader = readable.getReader();
		const writer = writable.getWriter();
		const read = () => reader.read().catch(() => ({ done: true }));
		let closed = false;
		const waiting = [];
		const gone = () => new Error('h3 response: connection closed');
		const close = () => {
			if (closed) return;
			closed = true;
			writer.close().catch(() => {});
			for (const entry of waiting.splice(0)) entry.reject(gone());
		};
		writer.write(new TextEncoder().encode('hello ' + host)).catch(() => {});
		const first = await Promise.race([
			read(),
			new Promise((resolve) =>
				setTimeout(() => resolve('timeout'), options.timeoutMs ?? 10000),
			),
		]);
		if (first === 'timeout') {
			close();
			throw new Error('quic handshake: timed out');
		}
		if (first.done) throw new Error('quic handshake: datagram channel closed');
		(async () => {
			for (;;) {
				const next = await read();
				if (next.done) return close();
				waiting.shift()?.resolve();
			}
		})();
		return {
			get alive() { return !closed; },
			handshake_ms: 1,
			stats() { return {}; },
			close,
			request(method, url) {
				if (closed) return Promise.reject(gone());
				return new Promise((resolve, reject) => {
					waiting.push({
						resolve: () => resolve({ status: 200, headers: [], body: null }),
						reject,
					});
					writer.write(new TextEncoder().encode(url)).catch(reject);
				});
			},
		};
	}
`)}`;

/**
 * Runs `steps` against a fresh Http3Transport. A step is a request
 * (`{ url, alt }`: the stand-in answers with `Alt-Svc: alt`), `{ sleep }`,
 * `{ info }` (a snapshot of info() under that name) or `{ relay }` (the base
 * transport is on a new wisp connection, whose channels are the ones given).
 * `channel` is one kind for every host or a map of host to kind (`*` for the
 * rest): `refuse` (the open fails), `noext` (the open fails the way epoxy
 * does on a wisp v2 server without the UDP extension), `close` (closed at
 * once, no reason reported), `close:N` (closed at once, close reason N),
 * `shut:N` (closed with reason N when the first datagram is sent, as the
 * edges' name gate does), `blackhole`, `endLater`, `echo` (what goes out
 * comes back) and `echo:MS` (after that long). Each request reports how long it took and how it went;
 * the end reports the wrapper's info() and how often the channel was opened,
 * in all and per host.
 */
const scenario = async ({ module, channel, options, steps }) => {
	const { Http3Transport } = await import('/stomp/controller.mjs');
	const base = {
		ready: false,
		// what Http3Transport tells one wisp connection from the next by
		client: {},
		async init() {
			this.ready = true;
		},
		async request(url) {
			const alt = url.searchParams.get('alt');
			return {
				status: 200,
				statusText: 'OK',
				headers: alt ? [['Alt-Svc', alt]] : [],
				body: 'base',
			};
		},
		connect() {
			throw new Error('not here');
		},
	};
	let opened = 0;
	const openedBy = {};
	const udp = async (host) => {
		opened++;
		openedBy[host] = (openedBy[host] ?? 0) + 1;
		const [kind, arg] = (
			typeof channel === 'string'
				? channel
				: (channel[host] ?? channel['*'] ?? 'blackhole')
		).split(':');
		if (kind === 'refuse') throw new Error('the stream could not be opened');
		if (kind === 'noext')
			throw new Error(
				'Wisp: ExtensionsNotSupported([1]) (Protocol extensions [1] not supported)',
			);
		let back;
		const read = new ReadableStream({
			start(controller) {
				back = controller;
				if (kind === 'close') controller.close();
				// up long enough for a handshake, then gone (its wisp stream,
				// or the whole wisp connection, was lost)
				if (kind === 'endLater') setTimeout(() => controller.close(), 300);
			},
		});
		let shut = false;
		const write = new WritableStream({
			write(chunk) {
				if (kind === 'shut' && !shut) {
					shut = true;
					back.close();
				}
				if (kind !== 'echo') return;
				if (arg) setTimeout(() => back.enqueue(chunk), Number(arg));
				else back.enqueue(chunk);
			},
		});
		return {
			read,
			write,
			// as an epoxy build that reports the close reason does
			...((kind === 'close' || kind === 'shut') &&
				arg && { closeReason: () => Number(arg) }),
		};
	};
	const transport = new Http3Transport(base, { ...options, udp }, module);
	await transport.init();
	const out = [];
	const infos = {};
	for (const step of steps) {
		if (step.sleep) {
			await new Promise((resolve) => setTimeout(resolve, step.sleep));
			continue;
		}
		if (step.info) {
			infos[step.info] = transport.info();
			continue;
		}
		if (step.relay) {
			base.client = {};
			channel = step.relay;
			continue;
		}
		const url = new URL(step.url);
		if (step.alt) url.searchParams.set('alt', step.alt);
		const t0 = performance.now();
		try {
			const response = await Promise.race([
				transport.request(url, 'GET', null, [], undefined),
				new Promise((resolve, reject) =>
					setTimeout(() => reject(new Error('HUNG')), 15000),
				),
			]);
			out.push({
				ms: Math.round(performance.now() - t0),
				status: response.status,
				via: transport.info().recent.at(-1)?.via,
			});
		} catch (error) {
			out.push({
				ms: Math.round(performance.now() - t0),
				error: String(error),
			});
		}
	}
	const info = transport.info();
	return { out, info, infos, opened, openedBy, now: Date.now() };
};
const run = (args) =>
	page
		.evaluate(scenario, { module: H3, options: {}, ...args })
		.catch((error) => ({
			out: [],
			info: { altSvc: [] },
			error: String(error).slice(0, 300),
		}));
const fast = (out, ms = 250) =>
	out.length > 0 && out.every((r) => r.status === 200 && r.ms < ms);
const entry = (result, origin) =>
	result.info.altSvc.find((e) => e.origin === origin);

// ---- what is learned ---------------------------------------------------------

{
	const r = await run({
		channel: 'blackhole',
		steps: [
			{ url: 'http://plain.test/', alt: 'h3=":443"' },
			{ url: 'https://other.test/', alt: 'h3="elsewhere.test:443"' },
			{ url: 'https://draft.test/', alt: 'h3-29=":443"; ma=60' },
			{ url: 'https://good.test/', alt: 'h3-29=":443", h3=":8443"; ma=60' },
			{ url: 'https://gone.test/', alt: 'h3=":443"' },
			{ url: 'https://gone.test/', alt: 'clear' },
		],
	});
	const origins = r.info.altSvc.map((e) => e.origin);
	ok(
		'Alt-Svc on an http origin is ignored',
		!origins.includes('http://plain.test'),
		JSON.stringify(r.info.altSvc),
	);
	ok(
		'an alternative on another host is ignored',
		!origins.includes('https://other.test'),
		JSON.stringify(r.info.altSvc),
	);
	ok(
		'draft versions (h3-29) are ignored',
		!origins.includes('https://draft.test'),
		JSON.stringify(r.info.altSvc),
	);
	const good = entry(r, 'https://good.test');
	ok(
		'an h3 alternative is kept for its origin, with its port and max-age',
		good?.port === 8443 &&
			good.source === 'alt-svc' &&
			Math.abs(good.expires - (r.now + 60000)) < 5000,
		JSON.stringify(good),
	);
	ok(
		'`clear` forgets the origin',
		!origins.includes('https://gone.test'),
		JSON.stringify(r.info.altSvc),
	);
	ok(
		'every response came from the base transport at once',
		fast(r.out),
		JSON.stringify(r.out),
	);
}

// ---- without stomp-h3 --------------------------------------------------------

{
	const r = await page
		.evaluate(scenario, {
			module: '/epoxy/h3/missing.js',
			channel: 'blackhole',
			options: {},
			steps: [
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ sleep: 300 },
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ url: 'https://a.test/', alt: 'h3=":443"' },
			],
		})
		.catch((error) => ({ out: [], info: {}, error: String(error) }));
	ok(
		'a stomp-h3 module that does not load leaves every request on the base transport, no stall, no channel opened',
		fast(r.out) &&
			r.out.every((x) => x.via === 'base') &&
			!!r.info.moduleError &&
			r.opened === 0,
		JSON.stringify({
			out: r.out,
			moduleError: r.info.moduleError,
			opened: r.opened,
		}),
	);
}

if (!present) {
	console.log(
		`SKIP the QUIC handshake checks: no ${H3} in this epoxy build (deploy/epoxy/build.sh)`,
	);
} else {
	// ---- a wisp v2 server without the UDP extension: off for every origin ------
	{
		const r = await run({
			channel: 'noext',
			steps: [
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ sleep: 300 },
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ url: 'https://b.test/', alt: 'h3=":443"' },
				{ sleep: 300 },
				{ url: 'https://b.test/', alt: 'h3=":443"' },
			],
		});
		ok(
			'a wisp server that says it has no UDP: every request on the base transport at once, QUIC off for all origins, asked once',
			fast(r.out) &&
				r.out.every((x) => x.via === 'base') &&
				r.info.udpBlockedUntil > r.now &&
				r.opened === 1,
			JSON.stringify({
				out: r.out,
				blocked: r.info.udpBlockedUntil,
				opened: r.opened,
			}),
		);
		ok(
			'and no origin is marked broken for it',
			r.info.altSvc.every((e) => e.brokenUntil === null),
			JSON.stringify(r.info.altSvc),
		);
	}

	// ---- a channel closed at once (wisp v1 refusing the stream) ----------------
	{
		const r = await run({
			channel: 'close',
			steps: [
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ sleep: 500 },
				{ url: 'https://a.test/', alt: 'h3=":443"' },
			],
		});
		const a = entry(r, 'https://a.test');
		ok(
			'a channel the server closes at once fails the handshake at once: origin broken for 5 minutes, base serves',
			fast(r.out) &&
				a?.brokenUntil > r.now + 4 * 60000 &&
				a.brokenUntil <= r.now + 5 * 60000 + 1000,
			JSON.stringify({ out: r.out, a }),
		);
		ok(
			'and that is a refusal of the one host: QUIC is not off for the others, the stream is not opened again',
			a?.refused === true &&
				r.info.udpBlockedUntil === null &&
				r.info.udpRefused.join() === 'a.test' &&
				r.opened === 1,
			JSON.stringify({
				a,
				blocked: r.info.udpBlockedUntil,
				refused: r.info.udpRefused,
				opened: r.opened,
			}),
		);
	}

	// ---- a black hole: the handshake times out ---------------------------------
	{
		const r = await run({
			channel: 'blackhole',
			options: { timeout: 1500 },
			steps: [
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				// the handshake is under way: nothing waits on it
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ sleep: 200 },
				{ url: 'https://a.test/', alt: 'h3=":443"' },
				{ sleep: 2000 },
				{ url: 'https://a.test/', alt: 'h3=":443"' },
			],
		});
		const a = entry(r, 'https://a.test');
		ok(
			'UDP that never answers: requests during the handshake do not wait for it',
			fast(r.out) && r.out.every((x) => x.via === 'base'),
			JSON.stringify(r.out),
		);
		ok(
			'and the handshake gives up at its timeout, marking the origin broken',
			a?.brokenUntil > r.now && r.opened === 1,
			JSON.stringify({ a, opened: r.opened }),
		);
	}

	// ---- a forced origin waits at most the handshake timeout -------------------
	{
		const r = await run({
			channel: 'blackhole',
			options: { timeout: 1000, force: ['forced.test:443'] },
			steps: [{ url: 'https://forced.test/' }, { url: 'https://forced.test/' }],
		});
		ok(
			'a forced origin waits for QUIC, then falls back once the handshake times out; the next request does not wait',
			r.out[0]?.status === 200 &&
				r.out[0].ms >= 900 &&
				r.out[0].ms < 3500 &&
				r.out[1]?.status === 200 &&
				r.out[1].ms < 250,
			JSON.stringify(r.out),
		);
	}
}

// ---- a channel that ends under a live connection ends it now -----------------
{
	// a stand-in for stomp-h3: the handshake succeeds at once and a request
	// waits until the connection is closed. stomp-h3 only marks a connection
	// over an ended channel dead, and its requests waited for the 30 s idle
	// timeout (a dropped wisp connection under a YouTube load held the app's
	// script that long).
	const standIn = `data:text/javascript,${encodeURIComponent(`
		export default async function init() {}
		export async function connect() {
			let closed = false;
			const waiting = [];
			const gone = () => new Error('h3 response: connection closed');
			return {
				get alive() { return !closed; },
				handshake_ms: 1,
				stats() { return {}; },
				close() {
					closed = true;
					for (const reject of waiting.splice(0)) reject(gone());
				},
				request() {
					return new Promise((resolve, reject) =>
						closed ? reject(gone()) : waiting.push(reject),
					);
				},
			};
		}
	`)}`;
	const r = await run({
		module: standIn,
		channel: 'endLater',
		options: { force: ['ends.test:443'] },
		steps: [{ url: 'https://ends.test/' }],
	});
	ok(
		'a QUIC connection whose datagram channel ends is closed at once: its GET goes over the base transport',
		r.out[0]?.status === 200 &&
			r.out[0].via === 'base-after-h3' &&
			r.out[0].ms < 2000,
		JSON.stringify(r.out ?? r),
	);
}

// ---- what a refused UDP stream means ------------------------------------------
// With the stand-in module above, so a host whose channel echoes has HTTP/3
// that works. Each origin is asked once to learn its Alt-Svc, then again.
const ALT = 'h3=":443"';
// Http3Transport's RELAY_REFUSALS: the hosts refused, with nothing carried,
// that make the relay one without UDP
const N = 8;
const hosts = (n) => Array.from({ length: n }, (_, i) => `h${i + 1}.test`);
const visits = (names, pause = 150) =>
	names.flatMap((name) => [
		{ url: `https://${name}/`, alt: ALT },
		{ sleep: pause },
	]);
const scoped = (args) => run({ module: DATAGRAM_H3, ...args });
const vias = (out) => out.map((r) => r.via).join(' ');

{
	// one name refused with the reason the edges' gate gives, another carried
	const r = await scoped({
		channel: { 'gated.test': 'shut:3', 'open.test': 'echo' },
		steps: [
			{ url: 'https://open.test/', alt: ALT },
			{ sleep: 200 },
			{ url: 'https://open.test/', alt: ALT }, // 1: before
			{ url: 'https://gated.test/', alt: ALT }, // 2: the refusal starts
			{ url: 'https://open.test/', alt: ALT }, // 3: during
			{ sleep: 200 },
			{ url: 'https://gated.test/', alt: ALT },
			{ url: 'https://gated.test/', alt: ALT },
			{ url: 'https://gated.test/', alt: ALT },
			{ url: 'https://open.test/', alt: ALT }, // 7: after
		],
	});
	const gated = entry(r, 'https://gated.test');
	ok(
		'one origin refused (close reason 0x03): the other origin is on HTTP/3 before, during and after',
		[1, 3, 7].every((i) => r.out[i]?.via === 'h3') &&
			r.info.udpBlockedUntil === null &&
			r.info.udpCarried === true,
		JSON.stringify({ vias: vias(r.out), blocked: r.info.udpBlockedUntil }),
	);
	ok(
		'the refused origin is broken alone, its requests go over the base transport at once and its stream is not opened again',
		gated?.refused === true &&
			gated.brokenUntil > r.now + 4 * 60000 &&
			[2, 4, 5, 6].every((i) => r.out[i]?.via === 'base') &&
			fast(r.out, 100) &&
			r.openedBy['gated.test'] === 1,
		JSON.stringify({ gated, out: r.out, openedBy: r.openedBy }),
	);
}

for (const [kind, what] of [
	['close', 'no reason reported'],
	['close:72', 'close reason 0x48, as holyWisp and wisp-js without UDP'],
	['close:66', 'close reason 0x42, as wisp-server-python without UDP'],
]) {
	// a relay with no UDP at all: every stream closed at once
	const r = await scoped({
		channel: kind,
		steps: [
			...visits(hosts(N - 1)),
			{ info: 'short' },
			...visits(hosts(N + 1).slice(N - 1)),
			{ url: 'https://h1.test/', alt: ALT },
			{ url: `https://h${N + 1}.test/`, alt: ALT },
		],
	});
	ok(
		`a relay that refuses every UDP stream (${what}): ${N - 1} hosts refused is not yet the relay, ${N} is, and the next is not asked`,
		r.infos.short?.udpBlockedUntil === null &&
			r.infos.short.udpRefused.length === N - 1 &&
			r.info.udpBlockedUntil > r.now + 4 * 60000 &&
			r.info.udpBlockedUntil <= r.now + 5 * 60000 + 1000 &&
			r.opened === N &&
			r.openedBy[`h${N + 1}.test`] === undefined,
		JSON.stringify({
			short: r.infos.short?.udpRefused,
			blocked: r.info.udpBlockedUntil,
			openedBy: r.openedBy,
		}),
	);
	ok(
		'and every request went over the base transport at once',
		fast(r.out, 100) && r.out.every((x) => x.via === 'base'),
		JSON.stringify(r.out),
	);
}

{
	// every name tried is refused for itself (the gate's reason): the relay
	// is never blamed, whatever the number
	const r = await scoped({
		channel: 'close:3',
		steps: [...visits(hosts(N + 2))],
	});
	ok(
		`${N + 2} hosts refused with close reason 0x03, which no server gives for "no UDP": QUIC stays on for the rest, each origin broken alone`,
		r.info.udpBlockedUntil === null &&
			r.info.udpRefused.length === 0 &&
			r.opened === N + 2 &&
			r.info.altSvc.length === N + 2 &&
			r.info.altSvc.every((e) => e.refused && e.brokenUntil > r.now),
		JSON.stringify({
			blocked: r.info.udpBlockedUntil,
			refused: r.info.udpRefused,
			opened: r.opened,
		}),
	);
}

{
	// refusals that could be the relay's, but a stream has carried: never
	const r = await scoped({
		channel: { 'open.test': 'echo', '*': 'close' },
		steps: [
			...visits(hosts(N - 1)),
			{ url: 'https://open.test/', alt: ALT },
			{ sleep: 200 },
			{ info: 'carried' },
			...visits(hosts(2 * N).slice(N - 1)),
			{ url: 'https://open.test/', alt: ALT },
		],
	});
	ok(
		`a relay that carried a datagram has UDP: ${2 * N} hosts refused around it never turn QUIC off, and the count is dropped`,
		r.infos.carried?.udpCarried === true &&
			r.infos.carried.udpRefused.length === 0 &&
			r.info.udpBlockedUntil === null &&
			r.info.udpRefused.length === 0 &&
			r.opened === 2 * N + 1 &&
			r.out.at(-1)?.via === 'h3',
		JSON.stringify({
			carried: r.infos.carried?.udpCarried,
			blocked: r.info.udpBlockedUntil,
			opened: r.opened,
			last: r.out.at(-1),
		}),
	);
}

{
	// enough refusals while another host's handshake is still out: the verdict
	// is withdrawn when that one carries
	const r = await scoped({
		channel: { 'slow.test': 'echo:700', '*': 'close' },
		steps: [
			{ url: 'https://slow.test/', alt: ALT },
			...visits(hosts(N), 40),
			{ info: 'off' },
			{ sleep: 900 },
			{ info: 'back' },
			{ url: 'https://slow.test/', alt: ALT },
			{ url: 'https://later.test/', alt: ALT },
			{ sleep: 150 },
		],
	});
	ok(
		'a verdict from refusals is withdrawn when a stream opened before it carries: QUIC is on again for every origin',
		r.infos.off?.udpBlockedUntil > r.now - 60000 &&
			r.infos.back?.udpBlockedUntil === null &&
			r.infos.back.udpCarried === true &&
			r.out.at(-2)?.via === 'h3' &&
			r.openedBy['later.test'] === 1,
		JSON.stringify({
			off: r.infos.off?.udpBlockedUntil,
			back: r.infos.back?.udpBlockedUntil,
			slow: r.out.at(-2),
			openedBy: r.openedBy,
		}),
	);
}

{
	// off for the relay, then a new wisp connection to a relay that has UDP
	const r = await scoped({
		channel: 'close',
		steps: [
			...visits(hosts(N)),
			{ info: 'off' },
			{ relay: 'echo' },
			{ url: 'https://h1.test/', alt: ALT },
			{ sleep: 200 },
			{ url: 'https://h1.test/', alt: ALT },
			{ url: `https://h${N}.test/`, alt: ALT },
			{ sleep: 200 },
			{ url: `https://h${N}.test/`, alt: ALT },
		],
	});
	ok(
		'a new wisp connection forgets the verdict and what the old relay refused: the same origins are on HTTP/3 through a relay that has UDP',
		r.infos.off?.udpBlockedUntil > r.now - 60000 &&
			r.info.udpBlockedUntil === null &&
			r.info.udpCarried === true &&
			r.out.at(-3)?.via === 'h3' &&
			r.out.at(-1)?.via === 'h3' &&
			r.info.altSvc.every((e) => e.brokenUntil === null),
		JSON.stringify({
			off: r.infos.off?.udpBlockedUntil,
			blocked: r.info.udpBlockedUntil,
			vias: vias(r.out),
		}),
	);
}

{
	// a stream that cannot be opened at all, for a reason that is not the
	// wisp connection's or the relay's own word
	const r = await scoped({
		channel: { 'bad.test': 'refuse', 'open.test': 'echo' },
		steps: [
			{ url: 'https://bad.test/', alt: ALT },
			{ sleep: 150 },
			{ info: 'bad' },
			{ url: 'https://bad.test/', alt: ALT },
			{ url: 'https://open.test/', alt: ALT },
			{ sleep: 150 },
			{ url: 'https://open.test/', alt: ALT },
		],
	});
	const bad = entry(r, 'https://bad.test');
	ok(
		"a UDP stream that cannot be opened is that origin's failure: counted once against the relay, QUIC on for the next origin",
		bad?.refused === true &&
			r.infos.bad?.udpRefused.join() === 'bad.test' &&
			r.infos.bad.udpBlockedUntil === null &&
			r.openedBy['bad.test'] === 1 &&
			r.out.at(-1)?.via === 'h3',
		JSON.stringify({
			bad,
			refused: r.infos.bad?.udpRefused,
			last: r.out.at(-1),
		}),
	);
}

{
	// a handshake that fails for the origin's own reasons (here: no answer)
	// stays that origin's across a new wisp connection
	const r = await scoped({
		channel: 'blackhole',
		options: { timeout: 300 },
		steps: [
			{ url: 'https://quiet.test/', alt: ALT },
			{ sleep: 600 },
			{ relay: 'blackhole' },
			{ url: 'https://quiet.test/', alt: ALT },
		],
	});
	const quiet = entry(r, 'https://quiet.test');
	ok(
		'an origin whose QUIC did not answer is not a refusal: it stays broken on a new wisp connection and counts nothing against the relay',
		quiet?.refused === false &&
			quiet.brokenUntil > r.now &&
			r.info.udpRefused.length === 0 &&
			r.opened === 1,
		JSON.stringify({ quiet, refused: r.info.udpRefused, opened: r.opened }),
	);
}

await context.close();

// ---- the same over a real wisp connection ------------------------------------
// A controller's own transport (the test transport: epoxy, with this suite's
// names reached in plain http on 127.0.0.1), behind RevivingTransport and
// Http3Transport as every host gets it, over the demo's wisp server through
// the gate. The fixture offers h3 on every origin; the stand-in module's
// datagrams cross the wisp server to the UDP echo below when the gate lets
// them.
const tcp = [];
const fixture = createServer((req, res) => {
	tcp.push(req.url);
	res.setHeader('Alt-Svc', `h3=":${fixture.address().port}"; ma=3600`);
	res.setHeader('Cache-Control', 'no-store');
	res.setHeader('Content-Type', 'text/plain');
	res.end('n');
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const sitePort = fixture.address().port;
const echo = createSocket('udp4');
echo.on('message', (message, from) =>
	echo.send(message, from.port, from.address),
);
await new Promise((resolve) => echo.bind(0, '127.0.0.1', resolve));
const toEcho = { host: '127.0.0.1', port: echo.address().port };
const gate = await startWispGate(`ws://127.0.0.1:${PORT}/wisp/`);
const name = (label) => `${label}.h3.mixed.test`;
const origin = (label) => `https://${name(label)}:${sitePort}`;

/** a page whose controller's transport goes through the gate */
async function wired() {
	const wiredContext = await browser.newContext();
	const wiredPage = await wiredContext.newPage();
	wiredPage.on('pageerror', (error) => errors.push(error.message));
	const said = [];
	wiredPage.on('console', (message) => {
		if (message.text().startsWith('Stomp:')) said.push(message.text());
	});
	await wiredPage.goto(`${PROXY}stomp/controllerFrame.html`);
	const kind = await wiredPage.evaluate(
		async ({ wisp, module }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/test/mixed-transport.mjs',
					options: [{ wisp }],
					http3: { module, timeout: 3000 },
					host: 'page',
				},
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			window.transport = controller.transport;
			// the worker's first request would do this
			if (!window.transport.ready) await window.transport.init();
			return typeof window.transport.info;
		},
		{ wisp: gate.url, module: DATAGRAM_H3 },
	);
	const info = () => wiredPage.evaluate(() => window.transport.info());
	const request = (label) => get(`${origin(label)}/n?o=${label}`);
	const get = (url) =>
		wiredPage.evaluate(async (url) => {
			const t0 = performance.now();
			try {
				const response = await Promise.race([
					window.transport.request(new URL(url), 'GET', null, [], undefined),
					new Promise((resolve, reject) =>
						setTimeout(() => reject(new Error('HUNG')), 15000),
					),
				]);
				if (response.body) await new Response(response.body).text();
				return {
					ms: Math.round(performance.now() - t0),
					status: response.status,
					via: window.transport.info().recent.at(-1)?.via,
				};
			} catch (error) {
				return {
					ms: Math.round(performance.now() - t0),
					error: String(error).slice(0, 200),
				};
			}
		}, url);
	/** poll info() until `test` holds, for at most `ms` */
	const until = async (test, ms = 5000) => {
		const deadline = Date.now() + ms;
		for (;;) {
			const now = await info();
			if (test(now) || Date.now() > deadline) return now;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const up = (label) => (now) =>
		now.connections.some((c) => c.origin === origin(label) && c.alive);
	const broken = (label) => (now) =>
		now.altSvc.some((e) => e.origin === origin(label) && e.brokenUntil);
	return {
		kind,
		said,
		info,
		request,
		get,
		until,
		up,
		broken,
		close: () => wiredContext.close(),
	};
}

{
	// the edges' gate: UDP to one name is closed with reason 0x03 as soon as
	// a datagram is sent to it, UDP to any other name is carried
	gate.udp = true;
	gate.gated.add(name('gated'));
	gate.resolve.set(name('open'), toEcho);
	const w = await wired();
	ok(
		"the controller's transport is the Http3Transport itself",
		w.kind === 'function',
		w.kind,
	);
	const out = [];
	out.push(await w.request('open')); // 0: learns the Alt-Svc
	await w.until(w.up('open'));
	out.push(await w.request('open')); // 1: before
	out.push(await w.request('gated')); // 2: learns it, the refusal follows
	out.push(await w.request('open')); // 3: during
	const after = await w.until(w.broken('gated'));
	for (let i = 0; i < 6; i++) out.push(await w.request('gated')); // 4 to 9
	out.push(await w.request('open')); // 10: after
	const now = await w.info();
	const gated = now.altSvc.find((e) => e.origin === origin('gated'));
	const streams = gate.seen.filter((s) => s.host === name('gated'));
	ok(
		'through a relay that refuses UDP to one name with 0x03: the other origin is on HTTP/3 before, during and after, its datagrams crossing the relay',
		[1, 3, 10].every((i) => out[i]?.via === 'h3' && out[i].status === 200) &&
			gate.seen.some((s) => s.host === name('open') && s.refused === null) &&
			now.udpBlockedUntil === null &&
			now.udpCarried === true,
		JSON.stringify({ vias: vias(out), blocked: now.udpBlockedUntil }),
	);
	ok(
		'the refused origin alone is off HTTP/3, and its UDP stream was asked for once',
		gated?.refused === true &&
			gated.brokenUntil > Date.now() &&
			after.udpBlockedUntil === null &&
			streams.length === 1 &&
			streams[0].refused === 0x03,
		JSON.stringify({ gated, streams }),
	);
	const fallback = out.slice(4, 10);
	ok(
		'and its requests arrive over TCP on time, none waiting on QUIC',
		out[2]?.via === 'base' &&
			out[2].ms < 2000 &&
			fallback.every((r) => r.via === 'base' && r.status === 200) &&
			fallback.every((r) => r.ms < 250) &&
			tcp.filter((url) => url.includes('o=gated')).length === 7,
		JSON.stringify({
			first: out[2],
			ms: fallback.map((r) => r.ms),
			arrived: tcp.filter((url) => url.includes('o=gated')).length,
		}),
	);
	const refusal = w.said.find((line) => line.includes('refused UDP to'));
	ok(
		'the transport says which name was refused, and never that the relay has no UDP',
		!!refusal &&
			refusal.includes(name('gated')) &&
			!w.said.some((line) => line.includes('relays no UDP')),
		JSON.stringify(w.said.map((line) => line.slice(0, 160))),
	);
	// the pinned epoxy build (deploy/epoxy's patch 0058) hands the reason
	// through
	ok(
		"the gate's close reason reaches the transport (0x03)",
		/close reason 0x03/.test(refusal ?? ''),
		String(refusal).slice(0, 160),
	);
	await w.close();
}

{
	// a relay with UDP off entirely, then a new wisp connection to one that
	// has it (another edge answering after the first went away)
	gate.seen.length = 0;
	gate.gated.clear();
	gate.udp = false;
	const labels = Array.from({ length: N + 1 }, (_, i) => `r${i + 1}`);
	const [first, last, extra] = [labels[0], labels[N - 1], labels[N]];
	for (const label of labels) gate.resolve.set(name(label), toEcho);
	const w = await wired();
	const out = [];
	for (const label of labels.slice(0, N - 1)) {
		out.push(await w.request(label));
		await w.until(w.broken(label));
	}
	const short = await w.info();
	out.push(await w.request(last));
	const off = await w.until((now) => now.udpBlockedUntil !== null);
	out.push(await w.request(extra));
	out.push(await w.request(first));
	await new Promise((resolve) => setTimeout(resolve, 300));
	ok(
		`through a relay with no UDP at all: ${N - 1} names refused is not yet the relay, one more is, and HTTP/3 is off for the relay for 5 minutes`,
		short.udpBlockedUntil === null &&
			short.udpRefused.length === N - 1 &&
			off.udpBlockedUntil > Date.now() + 4 * 60000 &&
			off.udpCarried === false,
		JSON.stringify({
			short: short.udpRefused,
			blocked: off.udpBlockedUntil,
		}),
	);
	ok(
		'no UDP stream is asked for after that, and every request arrived over TCP on time',
		gate.seen.length === N &&
			gate.seen.every((s) => s.refused === 0x48) &&
			out.every((r) => r.via === 'base' && r.status === 200 && r.ms < 2000) &&
			out.slice(1).every((r) => r.ms < 250) &&
			w.said.some((line) => line.includes('relays no UDP')),
		JSON.stringify({
			streams: gate.seen.map((s) => s.host.split('.')[0]),
			ms: out.map((r) => r.ms),
		}),
	);
	const refusals = w.said.filter((line) => line.includes('refused UDP to'));
	ok(
		'each of those refusals reached the transport with its close reason (0x48)',
		refusals.length === N &&
			refusals.every((line) => line.includes('close reason 0x48')),
		JSON.stringify(refusals.map((line) => line.slice(0, 120))),
	);

	const before = gate.connections;
	gate.udp = true;
	gate.cut();
	// What a page does next: a request on the connection it had (which
	// would wait on the dead one) and one that needs a new stream, which
	// finds the wisp connection gone; the transport is built again and both
	// are answered over the new one. QUIC to an origin starts with its next
	// request.
	const again = (
		await Promise.all([
			w.request(first),
			w.get(`http://localhost:${PORT}/config.js?${Date.now()}`),
		])
	).slice(0, 1);
	again.push(await w.request(first));
	const back = await w.until(w.up(first), 8000);
	again.push(await w.request(first));
	again.push(await w.request(extra));
	await w.until(w.up(extra), 8000);
	again.push(await w.request(extra));
	const end = await w.info();
	ok(
		'after a new wisp connection to a relay that has UDP, HTTP/3 comes back: for an origin the old relay refused and for one it was never asked about',
		gate.connections > before &&
			again.every((r) => r.status === 200) &&
			again[2].via === 'h3' &&
			again[4].via === 'h3' &&
			end.udpBlockedUntil === null &&
			end.udpCarried === true,
		JSON.stringify({
			connections: [before, gate.connections],
			again,
			up: back.connections.map((c) => c.origin),
			blocked: end.udpBlockedUntil,
		}),
	);
	await w.close();
}

gate.close();
echo.close();
fixture.close();
await done(browser, errors);
