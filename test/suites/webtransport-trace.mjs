// The verbose mode's WebTransport stage traces (src/transport/
// webTransportTrace.ts, docs/webtransport.md "Tracing a session"): each
// stage a proxied page's session can fail at is forced here, and the `[wt]`
// line the host's console gets must name that stage, while the page reads
// what it reads natively for the same server (the same page loaded without
// the proxy, its `ready` and `closed` and their order).
//
// - udp: a relay that refuses the UDP stream (test/wisp-gate.mjs) with
//   0x48 (blocked, or no UDP) and 0x41 (invalid), and one that closes it
//   with 0x03 at the first datagram (the edges' name gate), each reason
//   named in the line; natively a name that does not resolve. A refusal
//   with 0x49 (throttled) is held by the carrier host and sent again as
//   streams close, so that session waits out its handshake (quic, no
//   answer) and the host's own verbose line says it held the stream;
// - quic: a server whose ALPN is not h3, a pinned hash that is not the
//   certificate's, a certificate no root the transport has signed (epoxy
//   without the suite's root, natively Chrome without the suite's flags),
//   a port that never answers;
// - h3: a server whose SETTINGS lack ENABLE_WEBTRANSPORT, one whose
//   SETTINGS lack H3_DATAGRAM, a CONNECT answered 404 and 403;
// - a session that is up, and the carrier: the relay's own session up
//   (test/wisp-wt.mjs) with the page's session riding it, and one whose UDP
//   the network drops, which fails at the carrier and leaves the page's
//   session on the WebSocket.
//
// The mode is off by default (no `[wt]` line without it), on with
// `debugTransport` and with the host origin's
// localStorage['stomp:debug-transport'] = '1', in both demo modes through
// the demo itself; no line carries the session's path or query.
import { createSocket } from 'node:dgram';
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { STOMP_H3, webTransportClient } from '../webtransport-env.mjs';
import { startWispGate } from '../wisp-gate.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

if (!webTransportClient) {
	console.log(
		`SKIP webtransport-trace: the stomp-h3 epoxy-transport ships has no WebTransport client (${STOMP_H3} exports no connect_webtransport)`,
	);
	process.exit(0);
}

const H3_DATAGRAM = 0x33;
const ENABLE_CONNECT_PROTOCOL = 0x08;
const ENABLE_WEBTRANSPORT = 0x2b603742;

const good = await startWebTransportServer();
const wrongAlpn = await startWebTransportServer({ alpn: ['x-not-h3'] });
const noWebTransport = await startWebTransportServer({
	settings: [
		[H3_DATAGRAM, 1],
		[ENABLE_CONNECT_PROTOCOL, 1],
	],
});
const noDatagram = await startWebTransportServer({
	settings: [
		[ENABLE_CONNECT_PROTOCOL, 1],
		[ENABLE_WEBTRANSPORT, 1],
	],
});
// a UDP port that takes every datagram and answers none
const silent = createSocket('udp4');
silent.on('message', () => {});
await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
const silentPort = silent.address().port;

const gate = await startWispGate(`ws://127.0.0.1:${PORT}/wisp/`);
const name = (label) => `${label}.wt.mixed.test`;
gate.refuse.set(name('blocked'), 0x48);
gate.refuse.set(name('throttled'), 0x49);
gate.refuse.set(name('invalid'), 0x41);
gate.gated.add(name('gated'));

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const dropped = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
dropped.udpBlocked = true;

const browser = await launch();
const errors = [];
let runs = 0;

const at = (server, path = '/echo') =>
	`https://127.0.0.1:${server.port}${path}`;

/** [label, session URL, pinned hash, stage the line names, what it says, the transport] */
const CASES = [
	['up', at(good), good.certHash, null, /up in \d+ ms/],
	[
		'a relay that refuses the UDP stream with 0x48',
		`https://${name('blocked')}:443/echo`,
		good.certHash,
		'udp',
		/0x48 \(destination blocked/,
	],
	// (the carrier host holds a CONNECT the relay throttles and sends it
	// again as a stream closes: the session waits out its handshake, and a
	// verbose line of the host's says why, checked below)
	[
		'a relay that refuses the UDP stream with 0x49',
		`https://${name('throttled')}:443/echo`,
		good.certHash,
		'quic',
		/no QUIC answer/,
	],
	[
		'a relay that refuses the UDP stream with 0x41',
		`https://${name('invalid')}:443/echo`,
		good.certHash,
		'udp',
		/0x41 \(invalid destination/,
	],
	[
		'a relay that closes the UDP stream with 0x03 at its first datagram',
		`https://${name('gated')}:443/echo`,
		good.certHash,
		'udp',
		/0x03 \(network error/,
	],
	[
		'a server whose ALPN is not h3',
		at(wrongAlpn),
		wrongAlpn.certHash,
		'quic',
		/ALPN/,
	],
	[
		"a pinned hash that is not the certificate's",
		at(good),
		'zero',
		'quic',
		/TLS certificate/,
	],
	[
		'a certificate no root of the transport signed',
		at(good),
		'',
		'quic',
		/TLS certificate/,
		'/epoxy/index.mjs',
	],
	[
		'a port that never answers',
		`https://127.0.0.1:${silentPort}/echo`,
		good.certHash,
		'quic',
		/no QUIC answer/,
	],
	[
		'a server whose SETTINGS lack ENABLE_WEBTRANSPORT',
		at(noWebTransport),
		noWebTransport.certHash,
		'h3',
		/SETTINGS lack ENABLE_WEBTRANSPORT/,
	],
	[
		'a server whose SETTINGS lack H3_DATAGRAM',
		at(noDatagram),
		noDatagram.certHash,
		'h3',
		/SETTINGS lack H3_DATAGRAM/,
	],
	[
		'a CONNECT answered 404',
		at(good, '/nope'),
		good.certHash,
		'h3',
		/:status 404/,
	],
	[
		'a CONNECT answered 403',
		at(good, '/refuse'),
		good.certHash,
		'h3',
		/:status 403/,
	],
];

function caseURL(url, hash) {
	const id = `t${++runs}`;
	const search = new URLSearchParams({
		url: `${url}${url.includes('?') ? '&' : '?'}run=${id}`,
		run: id,
		...(hash ? { hash } : {}),
	});
	return { id, url: `${FIXTURE}pages/webtransport-trace.html?${search}` };
}

/** the page's answer, read with `read` until it is there */
async function answer(read, id, timeout = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await read(id).catch(() => null);
		if (value) return value.result;
		await sleep(100);
	}
	return { probeError: 'the page never answered' };
}

/** what the page reads, without the time it took */
const seen = (result) => {
	const rest = { ...result };
	delete rest.ms;
	return rest;
};

/**
 * A controller page in a context of its own, its transport's wisp at
 * `wisp`; `verbose`: 'init' (ControllerInit.debugTransport), 'storage'
 * (the host origin's localStorage key) or none
 */
async function controllerPage(
	wisp,
	{ verbose = 'init', module = '/test/mixed-transport.mjs', carrier } = {},
) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	page.lines = [];
	page.on('console', (message) => page.lines.push(message.text()));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	if (verbose === 'storage')
		await page.evaluate(() =>
			localStorage.setItem('stomp:debug-transport', '1'),
		);
	await page.evaluate(
		async ({ wisp, verbose, module, carrier }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module,
					options: [{ wisp }],
					// stomp-h3 is looked for next to the transport module, and
					// the test transport is not next to epoxy's (as the demo's)
					http3: { module: '/epoxy/h3/stomp_h3.js' },
					...(carrier && { webTransport: { timeoutMs: 1500 } }),
				},
				directory: '/stomp/',
				codec: 'xor',
				...(verbose === 'init' && { debugTransport: true }),
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
		},
		{ wisp, verbose, module, carrier },
	);
	return page;
}

/** the session at `url` in the proxied frame of `page`: its answer and the `[wt]` lines it made */
async function proxied(page, url, hash) {
	const made = caseURL(url, hash);
	const before = page.lines.length;
	await page.evaluate((url) => window.frame.go(url), made.url);
	const result = await answer(
		(id) =>
			page.evaluate((id) => {
				const wt = window.element.contentWindow?.__wt;
				return wt?.run === id ? JSON.parse(JSON.stringify(wt)) : null;
			}, id),
		made.id,
	);
	// the trace is told once the page heard the outcome
	let lines = [];
	for (let i = 0; i < 30; i++) {
		lines = page.lines
			.slice(before)
			.filter((line) => line.startsWith('[wt] ') && /page session/.test(line));
		if (lines.length) break;
		await sleep(100);
	}
	return { result, lines, id: made.id };
}

async function natively(url, hash) {
	const made = caseURL(url, hash);
	const page = await browser.newPage();
	await page.goto(made.url);
	const result = await answer(
		(id) =>
			page.evaluate((id) => (window.__wt?.run === id ? window.__wt : null), id),
		made.id,
	);
	await page.close();
	return result;
}

const brief = (value) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > 700 ? `${text.slice(0, 700)}...` : text;
};

// ---- each stage, against the page's native answer ----

const pages = new Map();
const pageFor = async (module = '/test/mixed-transport.mjs') => {
	if (!pages.has(module))
		pages.set(module, await controllerPage(gate.url, { module }));
	return pages.get(module);
};
for (const [label, url, hash, stage, says, module] of CASES) {
	const native = await natively(url, hash);
	const page = await pageFor(module);
	const { result, lines, id } = await proxied(page, url, hash);
	ok(
		`${label}: the page reads what it reads natively`,
		!native.probeError &&
			JSON.stringify(seen(native)) === JSON.stringify(seen(result)),
		`native ${brief(native)} proxied ${brief(result)}`,
	);
	const line = lines[0] ?? '';
	const named = stage
		? new RegExp(`failed at ${stage} \\(`).test(line)
		: / up in \d+ ms/.test(line);
	ok(
		`${label}: the trace says ${stage ? `it failed at ${stage}` : 'it is up'}, and why`,
		lines.length === 1 && named && says.test(line),
		brief(lines),
	);
	ok(
		`${label}: the trace names the server's origin, not the session's path or query`,
		line.includes(new URL(url).origin) &&
			!line.includes(new URL(url).pathname) &&
			!line.includes(id),
		brief(line),
	);
	if (/0x49/.test(label))
		ok(
			`${label}: the carrier host's verbose line says it holds the stream`,
			page.lines.some((line) =>
				/^\[net\] the relay refused a stream with 0x49 \(throttled/.test(line),
			),
			brief(page.lines.filter((line) => /0x49/.test(line))),
		);
	if (stage)
		ok(
			`${label}: the trace tells what the page reads`,
			/page \+\d+ ms: WebTransportError "Opening handshake failed\." \(source session, streamErrorCode null\)/.test(
				line,
			),
			brief(line),
		);
}
{
	// at most 2000 characters, the stomp-h3 error cut and ASCII
	const all = [...pages.values()].flatMap((page) =>
		page.lines.filter((line) => line.startsWith('[wt] ')),
	);
	ok(
		'every line is bounded and printable ASCII',
		all.length >= CASES.length &&
			all.every((line) => line.length <= 2000 && /^[\x20-\x7e]*$/.test(line)),
		`${all.length} lines, longest ${Math.max(...all.map((line) => line.length))}`,
	);
}
for (const page of pages.values()) await page.context().close();

// ---- off by default, on by the host origin's storage ----

{
	const off = await controllerPage(gate.url, { verbose: 'none' });
	const { result } = await proxied(off, at(good, '/nope'), good.certHash);
	await sleep(300);
	ok(
		'off by default: a failed session makes no [wt] line',
		result.ready?.startsWith('rejected') &&
			!off.lines.some((line) => line.startsWith('[wt] ')),
		brief(off.lines.slice(-6)),
	);
	await off.context().close();
	const stored = await controllerPage(gate.url, { verbose: 'storage' });
	const on = await proxied(stored, at(good, '/nope'), good.certHash);
	ok(
		"localStorage['stomp:debug-transport'] = '1' on the host origin turns it on",
		on.lines.length === 1 && /failed at h3 \(/.test(on.lines[0]),
		brief(stored.lines.slice(-6)),
	);
	await stored.context().close();
}

// ---- the carrier: the relay's own session ----

{
	const page = await controllerPage(relay.wisp, { carrier: true });
	let carrierLine = '';
	for (let i = 0; i < 40 && !carrierLine; i++) {
		carrierLine =
			page.lines.find((line) =>
				/^\[wt\] #\d+ carrier session to the relay/.test(line),
			) ?? '';
		if (!carrierLine) await sleep(100);
	}
	ok(
		"the relay's session up: the carrier's trace says so, with its stages",
		/ up in \d+ ms/.test(carrierLine) &&
			/handshake to https:\/\/127\.0\.0\.1:\d+ \(\d+ pinned hashes\): ready/.test(
				carrierLine,
			) &&
			/first Wisp packet came/.test(carrierLine),
		brief(page.lines.filter((line) => /^\[(wt|wisp)\]/.test(line))),
	);
	const { result, lines } = await proxied(page, at(good), good.certHash);
	ok(
		"a page's session over that carrier is up, its trace saying it rides the session's datagrams",
		result.ready === 'fulfilled' &&
			lines.length === 1 &&
			/ up in \d+ ms/.test(lines[0]) &&
			/carrier \+\d+ ms: the Wisp connection on WebTransport \(QUIC datagrams\)/.test(
				lines[0],
			),
		brief({ result, lines }),
	);
	await page.context().close();
}
{
	const page = await controllerPage(dropped.wisp, { carrier: true });
	let carrierLine = '';
	for (let i = 0; i < 60 && !carrierLine; i++) {
		carrierLine =
			page.lines.find((line) =>
				/^\[wt\] #\d+ carrier session to the relay/.test(line),
			) ?? '';
		if (!carrierLine) await sleep(100);
	}
	ok(
		"the relay's session lost to dropped UDP: the carrier's trace fails at the carrier, naming the handshake",
		/failed at carrier \(no session: /.test(carrierLine) &&
			/handshake to https:\/\/127\.0\.0\.1:\d+ .*failed in \d+ ms/.test(
				carrierLine,
			),
		brief(page.lines.filter((line) => /^\[(wt|wisp)\]/.test(line))),
	);
	const { result, lines } = await proxied(page, at(good), good.certHash);
	ok(
		"a page's session then rides the WebSocket, and its trace says so",
		result.ready === 'fulfilled' &&
			lines.length === 1 &&
			/carrier \+\d+ ms: the Wisp connection on the WebSocket \(TCP\)/.test(
				lines[0],
			),
		brief({ result, lines }),
	);
	await page.context().close();
}

// ---- through the demo, both modes, the host origin's storage ----

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const lines = [];
	const page = await openDemo(browser, base, {}, async (page) => {
		page.on('console', (message) => lines.push(message.text()));
		await page.addInitScript(() => {
			try {
				localStorage.setItem('stomp:debug-transport', '1');
			} catch {
				// (a page of another origin before the demo's)
			}
		});
	});
	const made = caseURL(at(good), 'zero');
	await submitLanding(page, made.url);
	const result = await answer(async (id) => {
		const frame = await activeFrame(page);
		return frame?.evaluate(
			(id) => (window.__wt?.run === id ? window.__wt : null),
			id,
		);
	}, made.id);
	let line = '';
	for (let i = 0; i < 40 && !line; i++) {
		line =
			lines.find(
				(text) => text.startsWith('[wt] ') && /page session/.test(text),
			) ?? '';
		if (!line) await sleep(100);
	}
	ok(
		`${mode} demo: the host's console gets the page session's trace, failed at quic`,
		result.ready?.startsWith('rejected') &&
			/failed at quic \(TLS certificate/.test(line),
		brief({ result, line }),
	);
	await page.context().close();
}

ok('no page errors', errors.length === 0, brief(errors));

for (const server of [good, wrongAlpn, noWebTransport, noDatagram])
	await server.close();
silent.close();
gate.close();
await done(browser);
