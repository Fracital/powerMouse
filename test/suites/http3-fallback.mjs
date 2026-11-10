// HTTP/3 fallback without the internet: an Http3Transport around a stand-in
// base transport that answers every request at once with the Alt-Svc the
// URL asks for, and a datagram channel chosen per check (refused, closed at
// once like a wisp server without UDP, or a black hole that never answers).
// What must hold, as in Chrome: Alt-Svc is learned only from https origins,
// only for h3 and only for the origin's own host, `clear` forgets it; a
// request never waits on a QUIC handshake that has not worked yet; a failed
// handshake marks the origin broken and the base transport serves it with
// no stall; a refused UDP stream turns QUIC off for every origin for a
// while; a forced origin waits at most the handshake timeout. The stomp-h3
// module comes from the epoxy build (deploy/epoxy/h3); without it, the
// checks that need it are skipped and the module error path is checked.
import { done, launch, ok, PROXY } from '../lib.mjs';

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

/**
 * Runs `steps` against a fresh Http3Transport. A step is a request
 * (`{ url, alt }`: the stand-in answers with `Alt-Svc: alt`) or `{ sleep }`.
 * Each request reports how long it took and how it went; the end reports
 * the wrapper's info() and how often the channel was opened.
 */
const scenario = async ({ module, channel, options, steps }) => {
	const { Http3Transport } = await import('/stomp/controller.mjs');
	const base = {
		ready: false,
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
	const udp = async () => {
		opened++;
		if (channel === 'refuse')
			throw new Error('UDP not supported by the wisp server');
		const read = new ReadableStream({
			start(controller) {
				if (channel === 'close') controller.close();
			},
		});
		const write = new WritableStream({ write() {} });
		return { read, write };
	};
	const transport = new Http3Transport(base, { ...options, udp }, module);
	await transport.init();
	const out = [];
	for (const step of steps) {
		if (step.sleep) {
			await new Promise((resolve) => setTimeout(resolve, step.sleep));
			continue;
		}
		const url = new URL(step.url);
		if (step.alt) url.searchParams.set('alt', step.alt);
		const t0 = performance.now();
		try {
			const response = await transport.request(url, 'GET', null, [], undefined);
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
	return { out, info, opened, now: Date.now() };
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
	// ---- refused UDP: off for every origin ---------------------------------------
	{
		const r = await run({
			channel: 'refuse',
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
			'a wisp server that refuses UDP: every request on the base transport at once, QUIC off for all origins, asked once',
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

await context.close();
await done(browser, errors);
