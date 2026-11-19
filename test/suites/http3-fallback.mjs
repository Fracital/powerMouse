// HTTP/3 fallback without the internet: an Http3Transport around a stand-in
// base transport that answers every request at once with the Alt-Svc the
// URL asks for, and a datagram channel chosen per check and per host
// (refused, closed at once like a wisp server refusing the stream, with or
// without a close reason, a black hole that never answers, or one that
// echoes). What must hold, as in Chrome: Alt-Svc is learned only from https
// origins, only for h3 and only for the origin's own host, `clear` forgets
// it; a request never waits on a QUIC handshake that has not worked yet; a
// failed handshake marks the origin broken and the base transport serves it
// with no stall; a forced origin waits at most the handshake timeout; an
// HTTPS record that names h3 (from a stand-in DoH server) puts a name's
// first request on HTTP/3, and a slow record or handshake delays it by a
// bounded head start at most. And
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
	// (how many transports loaded it: the scenario counts them)
	export default async function init() {
		globalThis.h3Inits = (globalThis.h3Inits ?? 0) + 1;
	}
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

// A stand-in for stomp-h3 that sends again what is not acknowledged, as
// QUIC does: a request goes out, and again after 200, 400, 800 ms... until
// the server acknowledges it (`ack <id>`, which this side acknowledges in
// turn with one datagram that wants no answer, as a QUIC packet that is
// only an ACK) or answers (`resp <id>`). Nothing heard for the handshake
// timeout closes it as quinn's idle timeout does, in quinn's words. While a
// request is open it sends a PING (`ping`) 15 s after the last datagram
// heard and counts it in `pings`, as stomp-h3's keep-alive. Its RTT is
// 1 ms, as on loopback.
const PROBING_H3 = `data:text/javascript,${encodeURIComponent(`
	export default async function init() {}
	export async function connect(host, readable, writable, options) {
		const reader = readable.getReader();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const read = () => reader.read().catch(() => ({ done: true }));
		// stomp-h3's writes run inside its wasm, where a call back into the
		// connection (its stats) throws as wasm-bindgen does
		let inside = false;
		const send = (text) => {
			inside = true;
			try {
				return writer.write(encoder.encode(text)).catch(() => {});
			} finally {
				inside = false;
			}
		};
		const idleMs = options.timeoutMs ?? 10000;
		const pending = new Map();
		let closed = false;
		let idle;
		let keepAlive;
		let pings = 0;
		const close = (why) => {
			if (closed) return;
			closed = true;
			clearTimeout(idle);
			clearTimeout(keepAlive);
			writer.close().catch(() => {});
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(new Error('h3 response: ' + why));
			}
			pending.clear();
		};
		const heard = () => {
			clearTimeout(idle);
			idle = setTimeout(() => close('Connection error: Timeout'), idleMs);
			clearTimeout(keepAlive);
			keepAlive = setTimeout(() => {
				if (closed || !pending.size) return;
				pings++;
				send('ping');
			}, 15000);
		};
		send('hello ' + host);
		const first = await Promise.race([
			read(),
			new Promise((resolve) => setTimeout(() => resolve('timeout'), idleMs)),
		]);
		if (first === 'timeout') {
			close('timeout');
			throw new Error('quic handshake: timed out');
		}
		if (first.done) throw new Error('quic handshake: datagram channel closed');
		heard();
		(async () => {
			for (;;) {
				const next = await read();
				if (next.done) return close('Connection error: closed');
				heard();
				const [what, id] = decoder.decode(next.value).split(' ');
				const entry = pending.get(id);
				if (what === 'ack') {
					if (entry) {
						entry.acked = true;
						clearTimeout(entry.timer);
					}
					send('a ' + id);
				} else if (what === 'resp' && entry) {
					clearTimeout(entry.timer);
					pending.delete(id);
					entry.resolve({ status: 200, headers: [], body: null });
				}
			}
		})();
		let ids = 0;
		return {
			get alive() { return !closed; },
			handshake_ms: 1,
			stats() {
				if (inside) throw new Error('recursive use of an object detected which would lead to unsafe aliasing in rust');
				return { rttMs: 1 };
			},
			get pings() {
				if (inside) throw new Error('recursive use of an object detected which would lead to unsafe aliasing in rust');
				return pings;
			},
			close: () => close('Connection error: closed locally'),
			request() {
				if (closed) return Promise.reject(new Error('h3 send: closed'));
				const id = String(ids++);
				return new Promise((resolve, reject) => {
					const entry = { resolve, reject, acked: false, timer: 0 };
					pending.set(id, entry);
					let wait = 200;
					const out = () => {
						if (closed || entry.acked || !pending.has(id)) return;
						send('req ' + id);
						entry.timer = setTimeout(out, wait);
						wait *= 2;
					};
					out();
				});
			},
		};
	}
`)}`;

/**
 * Runs `steps` against a fresh Http3Transport. A step is a request
 * (`{ url, alt, partition }`: the stand-in answers with `Alt-Svc: alt`;
 * `partition` is the network partition the service worker names), `{ sleep }`,
 * `{ info }` (a snapshot of info() under that name) or `{ relay }` (the base
 * transport is on a new wisp connection, whose channels are the ones given).
 * `channel` is one kind for every host or a map of host to kind (`*` for the
 * rest): `refuse` (the open fails), `noext` (the open fails the way epoxy
 * does on a wisp v2 server without the UDP extension), `close` (closed at
 * once, no reason reported), `close:N` (closed at once, close reason N),
 * `shut:N` (closed with reason N when the first datagram is sent, as the
 * edges' name gate does), `blackhole`, `endLater`, `echo` (what goes out
 * comes back), `echo:MS` (after that long), `dark:N` (the first N datagrams
 * echo, nothing after them crosses either way: a path that took the
 * handshake and then carried nothing), `server:MS` (PROBING_H3's server:
 * a request is acknowledged at once and answered MS later, a PING
 * acknowledged at once) and `acked` (PROBING_H3's server acknowledges the
 * first request at once, and nothing it sends after that arrives: the
 * answer is lost, and so is everything after it). A request step's `cap`
 * is how long it may take (15 s). Each request reports how long it took and how it went;
 * the end reports the wrapper's info() and how often the channel was opened,
 * in all and per host. The base transport is a DoH server too, at
 * doh.test: `records` maps a name to the HTTPS record it answers for it
 * (`{ alpn, port, delay }`, alpn h3 unless given, after `delay` ms), any
 * other name has none; `asked` counts its questions per name.
 */
const scenario = async ({
	module,
	channel,
	options,
	steps,
	records = {},
	shared = false,
}) => {
	const { Http3Transport } = await import('/stomp/controller.mjs');
	const asked = {};
	const answered = {};
	const answeredWith = [];
	// an RFC 8484 answer to the query in `dns`: the question, and one
	// ServiceMode HTTPS record (priority 1, target ".", TTL 300) when there
	// is one for the name
	const doh = async (url) => {
		const query = Uint8Array.from(
			atob(url.searchParams.get('dns').replace(/-/g, '+').replace(/_/g, '/')),
			(c) => c.charCodeAt(0),
		);
		const labels = [];
		for (let at = 12; query[at]; at += query[at] + 1)
			labels.push(
				new TextDecoder().decode(query.subarray(at + 1, at + 1 + query[at])),
			);
		const name = labels.join('.');
		asked[name] = (asked[name] ?? 0) + 1;
		const record = records[name];
		if (record?.delay)
			await new Promise((resolve) => setTimeout(resolve, record.delay));
		const answer = [...query];
		answer[2] = 0x81;
		answer[3] = 0x80;
		if (record) {
			answer[7] = 1;
			const alpn = new TextEncoder().encode(record.alpn ?? 'h3');
			const rdata = [0, 1, 0, 0, 1, 0, alpn.length + 1, alpn.length, ...alpn];
			if (record.port)
				rdata.push(0, 3, 0, 2, record.port >> 8, record.port & 255);
			answer.push(0xc0, 12, 0, 65, 0, 1, 0, 0, 1, 44, 0, rdata.length);
			answer.push(...rdata);
		}
		return {
			status: 200,
			statusText: 'OK',
			headers: [['content-type', 'application/dns-message']],
			body: new Uint8Array(answer),
		};
	};
	const base = {
		ready: false,
		// what Http3Transport tells one wisp connection from the next by
		client: {},
		async init() {
			this.ready = true;
		},
		async request(url) {
			if (url.hostname === 'doh.test' && url.searchParams.has('dns'))
				return doh(url);
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
		// `shared`: the base answers HTTPS records itself (the epoxy build's
		// httpsAnswer), one question per name, counted in `answered`
		...(shared && {
			fieldSupport: { httpsAnswer: true },
			async httpsAnswer(host, headers) {
				answered[host] = (answered[host] ?? 0) + 1;
				answeredWith.push(headers ?? null);
				const query = [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
				for (const label of host.split('.'))
					query.push(label.length, ...new TextEncoder().encode(label));
				query.push(0, 0, 65, 0, 1);
				const url = new URL('https://doh.test/dns-query');
				url.searchParams.set(
					'dns',
					btoa(String.fromCharCode(...query))
						.replace(/\+/g, '-')
						.replace(/\//g, '_')
						.replace(/=+$/, ''),
				);
				const answer = await doh(url);
				// (asked of the base itself, not over a DoH request)
				asked[host]--;
				if (!asked[host]) delete asked[host];
				return answer.body.buffer;
			},
		}),
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
		let crossed = 0;
		// `acked`: the acknowledgement went back, nothing will after it
		let lostAfter = false;
		const write = new WritableStream({
			write(chunk) {
				if (kind === 'shut' && !shut) {
					shut = true;
					back.close();
				}
				if (kind === 'dark' && crossed++ < Number(arg)) back.enqueue(chunk);
				if (kind === 'server' || kind === 'acked') {
					const [what, id] = new TextDecoder().decode(chunk).split(' ');
					const say = (text) => back.enqueue(new TextEncoder().encode(text));
					if (what === 'hello') say('hello');
					if (kind === 'acked') {
						if (what === 'req' && !lostAfter) {
							lostAfter = true;
							say(`ack ${id}`);
						}
						return;
					}
					if (what === 'ping') say('ack ping');
					if (what !== 'req') return;
					say(`ack ${id}`);
					setTimeout(() => say(`resp ${id}`), Number(arg));
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
	const transport = new Http3Transport(
		base,
		{ ...options, udp },
		module,
		undefined,
		shared,
	);
	const inits0 = globalThis.h3Inits ?? 0;
	await transport.init();
	// what it did when it started, before any request
	await new Promise((resolve) => setTimeout(resolve, 50));
	const atStart = {
		asked: Object.keys(asked).length,
		inits: (globalThis.h3Inits ?? 0) - inits0,
	};
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
				transport.request(
					url,
					'GET',
					null,
					step.partition ? [['$stomp$network', step.partition]] : [],
					undefined,
				),
				new Promise((resolve, reject) =>
					setTimeout(() => reject(new Error('HUNG')), step.cap ?? 15000),
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
	const inits = (globalThis.h3Inits ?? 0) - inits0;
	return {
		out,
		info,
		infos,
		opened,
		openedBy,
		asked,
		answered,
		answeredWith,
		atStart,
		inits,
		now: Date.now(),
	};
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
	ok(
		'and the origin is not marked broken for it: the wisp stream ended, not its QUIC',
		!entry(r, 'https://ends.test')?.brokenUntil,
		JSON.stringify(r.info.altSvc),
	);
}

// ---- a QUIC path that carries the handshake and then nothing -----------------
// With PROBING_H3, which sends a request again until it is acknowledged.
// Chrome closes a connection that has sent and heard nothing back for its
// blackhole delay (6.4 s on loopback, measured: QUIC_TOO_MANY_RTOS), sends
// the request again without the alternative and marks it broken when that
// answers. stomp-h3 (quinn) waited for its idle timeout (30 s), and the
// next request reconnected and waited again.
{
	const r = await run({
		module: PROBING_H3,
		channel: 'dark:1',
		// the idle timeout far past the check's 15 s
		options: { timeout: 30000 },
		steps: [
			{ url: 'https://dark.test/', alt: 'h3=":443"' },
			{ sleep: 300 },
			{ url: 'https://dark.test/', alt: 'h3=":443"' },
			{ url: 'https://dark.test/', alt: 'h3=":443"' },
		],
	});
	const dark = entry(r, 'https://dark.test');
	ok(
		"a QUIC connection that hears nothing back is closed at Chrome's blackhole delay: its GET goes over the base transport",
		r.out[1]?.status === 200 &&
			r.out[1].via === 'base-after-h3' &&
			r.out[1].ms > 5500 &&
			r.out[1].ms < 8500,
		JSON.stringify(r.out),
	);
	ok(
		'and the origin is marked broken: the next request goes over the base transport at once, with no new connection',
		dark?.brokenUntil > r.now &&
			r.out[2]?.status === 200 &&
			r.out[2].via === 'base' &&
			r.out[2].ms < 250 &&
			r.opened === 1,
		JSON.stringify({ out: r.out, dark, opened: r.opened }),
	);
}
{
	// the connection dies under the request with its channel open (quinn's
	// idle timeout, here 1.5 s): Chrome's retry without the alternative
	const r = await run({
		module: PROBING_H3,
		channel: 'dark:1',
		options: { timeout: 1500 },
		steps: [
			{ url: 'https://idle.test/', alt: 'h3=":443"' },
			{ sleep: 300 },
			{ url: 'https://idle.test/', alt: 'h3=":443"' },
			{ url: 'https://idle.test/', alt: 'h3=":443"' },
		],
	});
	ok(
		'a QUIC connection that fails under a request marks the origin broken once the base transport answered it; the next request does not reconnect',
		r.out[1]?.via === 'base-after-h3' &&
			entry(r, 'https://idle.test')?.brokenUntil > r.now &&
			r.out[2]?.via === 'base' &&
			r.out[2].ms < 250 &&
			r.opened === 1,
		JSON.stringify({ out: r.out, opened: r.opened, alt: r.info.altSvc }),
	);
}
{
	// a request the server acknowledges and answers 7 s later (a long
	// poll): the only datagram unanswered is the acknowledgement of the
	// server's, which wants no answer, and the connection stays
	const r = await run({
		module: PROBING_H3,
		channel: 'server:7000',
		options: { timeout: 30000 },
		steps: [
			{ url: 'https://poll.test/', alt: 'h3=":443"' },
			{ sleep: 300 },
			{ url: 'https://poll.test/', alt: 'h3=":443"' },
			{ url: 'https://poll.test/', alt: 'h3=":443"' },
		],
	});
	ok(
		'a request the server acknowledges and holds past the blackhole delay is answered over HTTP/3; the origin is not marked broken',
		r.out[1]?.via === 'h3' &&
			r.out[1].ms > 6900 &&
			r.out[2]?.via === 'h3' &&
			!entry(r, 'https://poll.test')?.brokenUntil &&
			r.opened === 1,
		JSON.stringify({ out: r.out, opened: r.opened, alt: r.info.altSvc }),
	);
}
{
	// A request the server acknowledges and whose answer is lost, with
	// nothing after it arriving either: Chrome 157 sent its PING 15 s on,
	// closed the connection as a blackhole 6.4 s after it (21.4 s after the
	// request, measured) and sent the request again. stomp-h3 sent no PING
	// and waited for its 30 s idle timeout. Beside it, a request the server
	// acknowledges and answers 25 s later, which the same PING finds alive.
	const [lost, held] = await Promise.all([
		run({
			module: PROBING_H3,
			channel: 'acked',
			options: { timeout: 30000 },
			steps: [
				{ url: 'https://lost.test/', alt: 'h3=":443"' },
				{ sleep: 300 },
				{ url: 'https://lost.test/', alt: 'h3=":443"', cap: 40000 },
				{ url: 'https://lost.test/', alt: 'h3=":443"' },
			],
		}),
		run({
			module: PROBING_H3,
			channel: 'server:25000',
			options: { timeout: 30000 },
			steps: [
				{ url: 'https://held.test/', alt: 'h3=":443"' },
				{ sleep: 300 },
				{ url: 'https://held.test/', alt: 'h3=":443"', cap: 40000 },
			],
		}),
	]);
	ok(
		"a request the server acknowledges and whose answer is lost goes over the base transport at Chrome's time: its PING 15 s on goes unanswered for the blackhole delay",
		lost.out[1]?.status === 200 &&
			lost.out[1].via === 'base-after-h3' &&
			lost.out[1].ms > 20000 &&
			lost.out[1].ms < 23500,
		JSON.stringify(lost.out),
	);
	ok(
		'and the origin is marked broken: the next request goes over the base transport at once, with no new connection',
		entry(lost, 'https://lost.test')?.brokenUntil > lost.now &&
			lost.out[2]?.via === 'base' &&
			lost.out[2].ms < 250 &&
			lost.opened === 1,
		JSON.stringify({
			out: lost.out,
			opened: lost.opened,
			alt: lost.info.altSvc,
		}),
	);
	ok(
		'a request the server holds for 25 s, acknowledging its PING, is answered over HTTP/3; the origin is not marked broken',
		held.out[1]?.via === 'h3' &&
			held.out[1].ms > 24900 &&
			!entry(held, 'https://held.test')?.brokenUntil &&
			held.opened === 1,
		JSON.stringify({
			out: held.out,
			opened: held.opened,
			alt: held.info.altSvc,
		}),
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

// ---- HTTPS records: h3 on the first request ----------------------------------
// As Chrome's resolver asks for a name's HTTPS record with its addresses and
// connects with QUIC at once when its alpn names h3, racing TCP: the first
// request to such a name waits for the record (up to 300 ms) and then for
// the QUIC handshake (a head start of `wait`, 300 ms), and goes over the
// base transport when either is late. Nothing of it happens when the
// transport starts: until a record (or an Alt-Svc) has named h3 and
// stomp-h3 has loaded, a first request does not wait for its record. These
// need no stomp-h3 (the stand-in module above).
const DOH = { dns: 'https://doh.test/dns-query' };
// a first name whose record names h3: its request does not wait, and the
// record loads stomp-h3 for the steps after it
const WARM = [{ url: 'https://warm.test/' }, { sleep: 100 }];
const warmed = (records) => ({ 'warm.test': {}, ...records });
{
	const r = await scoped({
		channel: 'echo',
		options: DOH,
		records: warmed({ 'rec.test': {}, 'two.test': { alpn: 'h2' } }),
		steps: [
			...WARM,
			{ url: 'https://rec.test/' },
			{ url: 'https://rec.test/' },
			{ url: 'https://none.test/' },
			{ url: 'https://none.test/' },
			{ url: 'https://two.test/' },
			{ url: 'https://rec.test:8443/' },
			{ url: 'https://127.0.0.9/' },
			{ url: 'http://plain.test/' },
		],
	});
	ok(
		'nothing is asked and stomp-h3 is not loaded when the transport starts; a first request before it has loaded does not wait for its record, and the record that names h3 loads it',
		r.atStart.asked === 0 &&
			r.atStart.inits === 0 &&
			r.out[0]?.via === 'base' &&
			r.out[0].ms < 50 &&
			r.asked['warm.test'] === 1 &&
			r.inits === 1,
		JSON.stringify({ atStart: r.atStart, inits: r.inits, out: r.out[0] }),
	);
	ok(
		'a name whose HTTPS record names h3: its first request goes over HTTP/3, the record asked once',
		r.out[1]?.via === 'h3' &&
			r.out[2]?.via === 'h3' &&
			r.asked['rec.test'] === 1 &&
			entry(r, 'https://rec.test')?.source === 'dns' &&
			fast(r.out.slice(1, 3), 150),
		JSON.stringify({ out: r.out, asked: r.asked, alt: r.info.altSvc }),
	);
	ok(
		'a name with no HTTPS record, or one without h3, is served by the base transport once its record says so, asked once',
		[3, 4, 5].every((i) => r.out[i]?.via === 'base') &&
			fast(r.out.slice(3, 6), 100) &&
			r.asked['none.test'] === 1 &&
			r.asked['two.test'] === 1 &&
			!r.openedBy['none.test'] &&
			!r.openedBy['two.test'],
		JSON.stringify({ out: r.out, asked: r.asked, openedBy: r.openedBy }),
	);
	ok(
		'no record is asked for another port, an IP address or plain http',
		r.asked['rec.test'] === 1 &&
			!r.asked['127.0.0.9'] &&
			!r.asked['plain.test'] &&
			Object.keys(r.asked).length === 4 &&
			[6, 7, 8].every((i) => r.out[i]?.via === 'base'),
		JSON.stringify({ out: r.out, asked: r.asked }),
	);
}
{
	const r = await scoped({
		channel: 'echo',
		options: DOH,
		records: { 'two.test': { alpn: 'h2' }, 'doh.test': {} },
		steps: [
			{ url: 'https://none.test/' },
			{ url: 'https://two.test/' },
			{ url: 'https://doh.test/' },
			{ sleep: 50 },
		],
	});
	ok(
		'records without h3 never load stomp-h3, and the DoH server is not asked for its own name',
		r.inits === 0 &&
			r.out.every((x) => x.via === 'base') &&
			r.asked['none.test'] === 1 &&
			r.asked['two.test'] === 1 &&
			!r.asked['doh.test'],
		JSON.stringify({ out: r.out, asked: r.asked, inits: r.inits }),
	);
}
{
	const r = await scoped({
		channel: 'echo',
		options: DOH,
		records: warmed({ 'rec.test': {} }),
		steps: [
			...WARM,
			{ url: 'https://rec.test/', partition: 'https://a.test' },
			{ url: 'https://rec.test/', partition: 'https://a.test' },
			{ url: 'https://rec.test/', partition: 'https://b.test' },
		],
	});
	ok(
		'an HTTPS record answer is kept per network partition: another site asks again, and each goes over HTTP/3',
		r.asked['rec.test'] === 2 && r.out.slice(1).every((x) => x.via === 'h3'),
		JSON.stringify({ out: r.out, asked: r.asked }),
	);
}
{
	const r = await scoped({
		channel: 'echo',
		options: DOH,
		shared: true,
		records: warmed({ 'rec.test': {} }),
		steps: [
			...WARM,
			{ url: 'https://rec.test/', partition: 'https://a.test' },
			{ url: 'https://rec.test/', partition: 'https://a.test' },
			{ url: 'https://none.test/' },
		],
	});
	ok(
		'a base that answers HTTPS records itself is asked instead of the DoH server, with the partition, and its answer puts a first request on HTTP/3',
		Object.keys(r.asked).length === 0 &&
			r.answered['warm.test'] === 1 &&
			r.answered['rec.test'] === 1 &&
			r.answered['none.test'] === 1 &&
			r.out[1]?.via === 'h3' &&
			r.out[2]?.via === 'h3' &&
			r.out[3]?.via === 'base' &&
			r.answeredWith.some((headers) => headers?.[0]?.[1] === 'https://a.test'),
		JSON.stringify({
			out: r.out,
			asked: r.asked,
			answered: r.answered,
			answeredWith: r.answeredWith,
		}),
	);
}
{
	const r = await scoped({
		channel: 'echo',
		options: { dns: '' },
		records: { 'rec.test': {} },
		steps: [{ url: 'https://rec.test/' }],
	});
	ok(
		'with `dns` empty no record is asked for',
		r.out[0]?.via === 'base' && Object.keys(r.asked).length === 0,
		JSON.stringify({ out: r.out, asked: r.asked }),
	);
}
{
	const r = await scoped({
		channel: { 'dead.test': 'blackhole', 'up.test': 'echo', '*': 'echo' },
		options: DOH,
		records: warmed({ 'dead.test': {}, 'up.test': {} }),
		steps: [
			...WARM,
			{ url: 'https://dead.test/' },
			{ url: 'https://dead.test/' },
			{ url: 'https://up.test/' },
			{ sleep: 300 },
			{ url: 'https://up.test/' },
		],
	});
	ok(
		'a first QUIC connection not up within its head start: the base transport serves the request after 300 ms, and the next at once',
		r.out[1]?.via === 'base' &&
			r.out[1].ms >= 250 &&
			r.out[1].ms < 700 &&
			r.out[2]?.via === 'base' &&
			r.out[2].ms < 100 &&
			r.openedBy['dead.test'] === 1,
		JSON.stringify({ out: r.out, openedBy: r.openedBy }),
	);
	ok(
		'a relay that carried a datagram back keeps giving head starts, and a QUIC connection is used once up',
		r.out[3]?.via === 'h3' &&
			r.out[4]?.via === 'h3' &&
			r.asked['up.test'] === 1,
		JSON.stringify({ out: r.out, asked: r.asked }),
	);
}
{
	const r = await scoped({
		channel: {
			'dead.test': 'blackhole',
			'up.test': 'echo',
			'warm.test': 'blackhole',
		},
		options: DOH,
		records: warmed({ 'dead.test': {}, 'up.test': {} }),
		steps: [
			...WARM,
			{ url: 'https://dead.test/' },
			{ url: 'https://up.test/' },
			{ sleep: 300 },
			{ url: 'https://up.test/' },
		],
	});
	ok(
		'over a relay nothing has come back on since a head start ran out, a new name gets none, and its QUIC connection is used once up',
		r.out[1]?.via === 'base' &&
			r.out[2]?.via === 'base' &&
			r.out[2].ms < 100 &&
			r.out[3]?.via === 'h3' &&
			r.asked['up.test'] === 1,
		JSON.stringify({ out: r.out, asked: r.asked }),
	);
}
{
	const r = await scoped({
		channel: 'echo',
		options: DOH,
		records: warmed({ 'slow.test': { delay: 1200 } }),
		steps: [
			...WARM,
			{ url: 'https://slow.test/' },
			{ sleep: 1500 },
			{ url: 'https://slow.test/' },
		],
	});
	ok(
		'a DoH server slower than 300 ms: the first request goes over the base transport at 300 ms, and the answer serves the next over HTTP/3',
		r.out[1]?.via === 'base' &&
			r.out[1].ms >= 250 &&
			r.out[1].ms < 600 &&
			r.out[2]?.via === 'h3' &&
			r.asked['slow.test'] === 1,
		JSON.stringify({ out: r.out, asked: r.asked }),
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
