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
// resolves nowhere). An origin that takes the datagrams and never answers
// is the http3-fallback suite's.
import { spawn } from 'node:child_process';
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

const root = fileURLToPath(new URL('../../', import.meta.url));

const arrived = [];
const fixture = createServer((req, res) => {
	arrived.push(req.url);
	res.setHeader('Alt-Svc', `h3=":${fixture.address().port}"; ma=3600`);
	res.setHeader('Cache-Control', 'no-store');
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

const browser = await launch();
const pageErrors = [];

/**
 * One visit of the demo at `base`: the fixture's page in a tab, then six
 * requests from it one after the other. Reports how long each took, whether
 * the visit's transport asked for stomp-h3, and what it said about QUIC.
 */
async function visit(base) {
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
		'and the transport says QUIC failed and is off for the origin',
		result.said.some((line) => /QUIC to .* failed .*HTTP\/3 off/.test(line)),
		JSON.stringify(
			result.said
				.filter((line) => line.startsWith('Stomp:'))
				.map((line) => line.slice(0, 120)),
		),
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

offServer.kill();
fixture.close();
await done(browser, pageErrors);
