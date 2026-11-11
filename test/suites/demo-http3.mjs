// The demo has HTTP/3 on by default, and a site that offers it costs nothing
// where QUIC cannot be had. No internet: a fixture of this suite's own
// answers every request with `Alt-Svc: h3` for its own port, reached as
// https://mixed.test through the demo's test transport (plain http to
// 127.0.0.1, demo/public/test/mixed-transport.mjs), so the HTTP/3 wrapper
// sees an https origin that offers h3. Whether a visit has HTTP/3 on shows
// in whether its transport worker asks for stomp-h3, which happens only
// once an origin has offered h3. This suite's demo server refuses UDP
// (WISP_NO_UDP, as a holyWisp with `allow-udp = off`): the page and every
// request after it must arrive over the base transport without waiting for
// QUIC. A second demo server, started here with STOMP_HTTP3=0 and UDP
// relayed, shows the switches (`/config.js`, `?http3`, `?http3=0`) and
// QUIC failing behind a wisp server that does relay UDP (the fixture's name
// resolves nowhere). A third, whose wisp is a gate in front of the second's
// (test/wisp-gate.mjs), refuses UDP to the fixture's name alone, with close
// reason 0x03 on its first datagram as the production edges' name gate does: that one origin
// falls back and HTTP/3 stays on for the session, where one refused stream
// used to turn it off for every origin. Refused for eight names, as by the
// first server, the transport takes the relay to have no UDP (docs/http3.md,
// rule 5). An origin that takes the datagrams and never answers, and
// HTTP/3 that works beside a refused origin, are the http3-fallback suite's.
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
	waitForServer,
} from '../lib.mjs';
import { startWispGate } from '../wisp-gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const arrived = [];
const fixture = createServer((req, res) => {
	arrived.push(req.url);
	res.setHeader('Alt-Svc', `h3=":${fixture.address().port}"; ma=3600`);
	res.setHeader('Cache-Control', 'no-store');
	// the page asks the fixture's other names (h3.mixed.test) too
	res.setHeader('Access-Control-Allow-Origin', '*');
	if (req.url.startsWith('/n')) {
		res.setHeader('Content-Type', 'text/plain');
		res.end('n');
		return;
	}
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.end('<!doctype html><title>h3 fixture</title><p>h3 fixture</p>');
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const SITE = `https://mixed.test:${fixture.address().port}/`;
/** another https origin of the fixture (demo/public/test/mixed-transport.mjs) */
const other = (label) =>
	`https://${label}.h3.mixed.test:${fixture.address().port}/n?o=${label}`;

const freePort = () =>
	new Promise((resolve, reject) => {
		const probe = createNet();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});

// the server with HTTP/3 turned off, its built-in wisp relaying UDP
const offPort = await freePort();
const offServer = spawn(process.execPath, [`${root}demo/server.js`], {
	env: {
		...process.env,
		PORT: String(offPort),
		STOMP_HTTP3: '0',
		STOMP_TEST_TRANSPORT: '1',
		WISP_ALLOW_LOOPBACK: '1',
		WISP_NO_UDP: '',
	},
	stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => offServer.kill());
const OFF = `http://127.0.0.1:${offPort}/`;
await waitForServer(`${OFF}api/status`);

// the server behind a gate that refuses UDP to the fixture's name with 0x03
// and relays it for every other name (through the second server's wisp). The
// other name the page asks goes to a UDP socket here that never answers.
const gate = await startWispGate(`ws://127.0.0.1:${offPort}/wisp/`);
gate.gated.add('mixed.test');
const silent = createSocket('udp4');
await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
gate.resolve.set('open.h3.mixed.test', {
	host: '127.0.0.1',
	port: silent.address().port,
});
const gatedPort = await freePort();
const gatedServer = spawn(process.execPath, [`${root}demo/server.js`], {
	env: {
		...process.env,
		PORT: String(gatedPort),
		STOMP_HTTP3: '',
		STOMP_TEST_TRANSPORT: '1',
		STOMP_WISP_URL: gate.url,
		WISP_NO_UDP: '',
	},
	stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => gatedServer.kill());
const GATED = `http://127.0.0.1:${gatedPort}/`;
await waitForServer(`${GATED}api/status`);

const browser = await launch();
const pageErrors = [];

/**
 * One visit of the demo at `base`: the fixture's page in a tab, then six
 * requests from it one after the other, then one to each of `others` (more
 * origins of the fixture). Reports how long each took, whether the visit's
 * transport asked for stomp-h3, and what it said about QUIC.
 */
async function visit(base, others = []) {
	const context = await browser.newContext();
	let module = false;
	context.on('request', (request) => {
		if (request.url().includes('/h3/stomp_h3')) module = true;
	});
	const said = [];
	const listen = (source) =>
		source.on('console', (message) => {
			if (message.text().includes('HTTP/3')) said.push(message.text());
		});
	context.on('page', (page) => {
		listen(page);
		page.on('worker', listen);
	});
	const before = arrived.length;
	const page = await openDemo(context, base);
	const t0 = Date.now();
	await submitLanding(page, SITE);
	const frame = await waitActive(page, () => document.title === 'h3 fixture');
	const loaded = Date.now() - t0;
	const requests = [];
	for (let i = 0; i < 6; i++) {
		requests.push(
			await frame.evaluate(async (n) => {
				const t = performance.now();
				const response = await fetch(`/n?i=${n}`);
				const text = await response.text();
				return {
					ok: response.status === 200 && text === 'n',
					ms: Math.round(performance.now() - t),
				};
			}, i),
		);
		// the first requests fall while QUIC is being tried, the last after
		// it has failed
		await sleep(i < 3 ? 100 : 700);
	}
	for (const url of others) {
		requests.push(
			await frame.evaluate(async (target) => {
				const t = performance.now();
				const response = await fetch(target);
				const text = await response.text();
				return {
					ok: response.status === 200 && text === 'n',
					ms: Math.round(performance.now() - t),
				};
			}, url),
		);
		// its Alt-Svc is learned and its UDP stream asked for after the
		// response
		await sleep(300);
	}
	pageErrors.push(...page.errors);
	const got = arrived.slice(before);
	await context.close();
	return { loaded, requests, module, said, got };
}

const onTime = (result) =>
	result.loaded < 8000 &&
	result.requests.every((request) => request.ok && request.ms < 2000);
const brief = (result) =>
	JSON.stringify({
		loaded: result.loaded,
		ms: result.requests.map((request) => request.ms),
		module: result.module,
		said: result.said.filter((line) => line.startsWith('Stomp:')).length,
	});
const stompSaid = (result) =>
	result.said
		.filter((line) => line.startsWith('Stomp:'))
		.map((line) => line.slice(0, 160));
const config = async (base) => (await fetch(`${base}config.js`)).text();

// ---- the default, on a server whose wisp refuses UDP -----------------------
ok(
	'the demo server says HTTP/3 is on when nothing is set',
	/"http3":true/.test(await config(PROXY)),
);
{
	const result = await visit(PROXY);
	ok(
		'a default visit has HTTP/3 on: an origin that offers h3 makes the transport load stomp-h3',
		result.module,
		brief(result),
	);
	ok(
		'with a wisp server that refuses UDP the page and six requests after it arrive on time',
		onTime(result),
		brief(result),
	);
	ok(
		'all of them over the base transport (the fixture speaks only HTTP/1.1 over TCP)',
		result.got.filter((url) => url === '/').length >= 1 &&
			result.got.filter((url) => url.startsWith('/n')).length === 6,
		JSON.stringify(result.got),
	);
	ok(
		'and the transport says the UDP stream was refused and HTTP/3 is off for the origin, not for the relay',
		result.said.some((line) =>
			/refused UDP to mixed\.test.*HTTP\/3 off for https:\/\/mixed\.test/.test(
				line,
			),
		) && !result.said.some((line) => line.includes('relays no UDP')),
		JSON.stringify(stompSaid(result)),
	);
}
{
	// with the page's own: the eight of Http3Transport's RELAY_REFUSALS
	const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
	const result = await visit(PROXY, labels.map(other));
	ok(
		'refused for eight names, the transport takes the relay to have no UDP and says HTTP/3 is off for it',
		result.said.some((line) => /HTTP\/3 is off .*relays no UDP/.test(line)),
		JSON.stringify(stompSaid(result)),
	);
	ok(
		'and the page and every request arrived on time over the base transport',
		onTime(result) &&
			result.got.filter((url) => url.startsWith('/n')).length ===
				6 + labels.length,
		brief(result),
	);
}
{
	const result = await visit(`${PROXY}?http3=0`);
	ok(
		'?http3=0 turns it off for a visit: stomp-h3 is never asked for',
		!result.module && onTime(result),
		brief(result),
	);
}

// ---- STOMP_HTTP3=0, on a server whose wisp relays UDP ----------------------
ok(
	'STOMP_HTTP3=0 makes the demo server say HTTP/3 is off',
	/"http3":false/.test(await config(OFF)),
);
{
	const result = await visit(OFF);
	ok(
		'and a visit there has it off',
		!result.module && onTime(result),
		brief(result),
	);
}
{
	const result = await visit(`${OFF}?http3`);
	ok('?http3 turns it on for a visit there', result.module, brief(result));
	ok(
		'an origin whose QUIC connection fails (UDP relayed) costs the page and its requests nothing',
		onTime(result) &&
			result.got.filter((url) => url.startsWith('/n')).length === 6,
		brief(result),
	);
}

// ---- a wisp server that refuses UDP to one name ----------------------------
{
	const result = await visit(GATED, [other('open')]);
	const streams = gate.seen.map((s) => `${s.host} ${s.refused ?? 'relayed'}`);
	const refusedAt = gate.seen.findIndex((s) => s.host === 'mixed.test');
	ok(
		"UDP to the page's origin refused with 0x03: the page and its requests arrive on time over the base transport",
		onTime(result) &&
			result.got.filter((url) => url === '/').length >= 1 &&
			result.got.filter((url) => url.startsWith('/n?i=')).length === 6,
		brief(result),
	);
	ok(
		'its UDP stream was asked for once, not again with every request',
		gate.seen.filter((s) => s.host === 'mixed.test').length === 1 &&
			gate.seen[refusedAt]?.refused === 0x03,
		JSON.stringify(streams),
	);
	ok(
		'HTTP/3 stays on for the session: the UDP stream of the next origin that offers h3 is asked for, and relayed',
		refusedAt >= 0 &&
			gate.seen.findIndex(
				(s) => s.host === 'open.h3.mixed.test' && s.refused === null,
			) > refusedAt,
		JSON.stringify(streams),
	);
	ok(
		'the transport says HTTP/3 is off for that origin and never that the relay has no UDP',
		result.said.some((line) =>
			/refused UDP to mixed\.test.*HTTP\/3 off for https:\/\/mixed\.test/.test(
				line,
			),
		) && !result.said.some((line) => line.includes('relays no UDP')),
		JSON.stringify(stompSaid(result)),
	);
}

gatedServer.kill();
gate.close();
silent.close();
offServer.kill();
fixture.close();
await done(browser, pageErrors);
