// WebTransport sessions carried through the proxy (docs/webtransport.md):
// a proxied page's session travels from the transport worker as QUIC on a
// wisp UDP stream (stomp-h3's WebTransport client), and the page's streams,
// datagrams, closes and errors are the browser's own as natively. The
// suite's WebTransport server (test/wtserver.mjs, run in this process) is
// the far end for both: the same page runs natively and proxied (both demo
// modes), and every answer is compared, with what the server saw of each
// session.
//
// The cases: a bidirectional stream echoed (small writes of every buffer
// kind, a large one, its end, the page's streams' kinds), the server's own
// streams and what its CONNECT request carried (the page's real origin, no
// cookie), a unidirectional stream each way, datagrams (echo, the numbers,
// one too large, one that is no buffer), a close by the page and one by the
// server with their codes and reasons, the server's reset and stop-sending
// and the page's, a refused session (404 and 403), the protocol the server
// picks, a server that does not read (the writer's `ready` stalls, then goes
// on), a certificate the WebPKI takes rather than a pinned hash, a hash that
// is not the certificate's, a session in a dedicated worker, and one the
// content blocker refuses (test/pages/adblock-run.txt), which the server
// refuses natively and never hears of through the proxy.
//
// Natively Chrome takes the server's certificate with a pinned hash, or with
// both --ignore-certificate-errors-spki-list and --origin-to-force-quic-on
// for its address; through the proxy, the demo's test transport trusts the
// server's root (demo/public/test/mixed-transport.mjs).
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';
import { STOMP_H3, webTransportClient } from '../webtransport-env.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

if (!webTransportClient) {
	// an epoxy-transport released before its stomp-h3 had a WebTransport
	// client: proxied sessions fail as the stand-in alone does, which the
	// webtransport suite holds them to
	console.log(
		`SKIP webtransport-live: the stomp-h3 epoxy-transport ships has no WebTransport client (${STOMP_H3} exports no connect_webtransport)`,
	);
	process.exit(0);
}

const server = await startWebTransportServer();
const browser = await launch([
	`--ignore-certificate-errors-spki-list=${server.spki}`,
	`--origin-to-force-quic-on=127.0.0.1:${server.port}`,
]);

let runs = 0;
function run(name, realm) {
	const id = `l${++runs}`;
	const search = new URLSearchParams({
		case: name,
		port: server.port,
		hash: server.certHash,
		run: id,
		...(realm ? { realm } : {}),
	});
	return { id, url: `${FIXTURE}pages/webtransport-live.html?${search}` };
}
async function answer(frame, id, timeout = 40000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const target = await frame();
		const value = await target
			?.evaluate((run) => (window.__wt?.run === run ? window.__wt : null), id)
			.catch(() => null);
		if (value) return value.result;
		await sleep(150);
	}
	return { probeError: 'the page never answered' };
}
/** what the server saw of a run's sessions, without what differs by connection (ports, times) */
async function seen(id) {
	await sleep(400);
	return server.events
		.filter((event) => String(event.path ?? '').includes(`run=${id}`))
		.map((event) => {
			// (the address a session came from is the browser's or the wisp server's)
			const rest = { ...event };
			if (typeof rest.remote === 'string') delete rest.remote;
			// a GREASE setting's id and value are random (0x1f * n + 0x21)
			if (Array.isArray(rest.settings))
				rest.settings = rest.settings.filter(
					([id]) => (BigInt(id) - 0x21n) % 0x1fn !== 0n,
				);
			return rest;
		})
		.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

/** a run's answers and what the server saw, without the run's own id */
const unrun = (value) =>
	JSON.parse(JSON.stringify(value).replace(/run=l\d+/g, 'run=*'));

async function natively(name, realm) {
	const made = run(name, realm);
	const page = await browser.newPage();
	await page.goto(made.url);
	const result = await answer(() => page.mainFrame(), made.id);
	await page.close();
	return unrun({ result, server: await seen(made.id) });
}

/** a tab of the demo, navigated again for each run */
function proxiedTab(base) {
	let page = null;
	return async (name, realm) => {
		const made = run(name, realm);
		if (!page) {
			page = await openDemo(browser, base);
			await submitLanding(page, made.url);
		} else await submitOmni(page, made.url);
		const result = await answer(() => activeFrame(page), made.id);
		return unrun({ result, server: await seen(made.id) });
	};
}

const brief = (value) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text === undefined
		? 'undefined'
		: text.length > 600
			? `${text.slice(0, 600)}...`
			: text;
};
function differences(native, proxied, path = '') {
	if (
		native !== null &&
		proxied !== null &&
		typeof native === 'object' &&
		typeof proxied === 'object' &&
		Array.isArray(native) === Array.isArray(proxied)
	) {
		const out = [];
		for (const key of new Set([
			...Object.keys(native),
			...Object.keys(proxied),
		]))
			out.push(
				...differences(
					native[key],
					proxied[key],
					path ? `${path}.${key}` : key,
				),
			);
		return out;
	}
	const [a, b] = [native, proxied].map((value) =>
		typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined'),
	);
	return a === b ? [] : [`${path}: native ${brief(a)} proxied ${brief(b)}`];
}

/** [case, realm, what it shows] */
const CASES = [
	['echo', undefined, 'a bidirectional stream echoed'],
	['push', undefined, "the server's streams and its CONNECT request"],
	['uni', undefined, 'a unidirectional stream each way'],
	['datagrams', undefined, 'datagrams'],
	['closeByPage', undefined, 'a close by the page'],
	['closeByServer', undefined, 'a close by the server'],
	[
		'closeByServerGone',
		undefined,
		'a close by the server, its streams reset first',
	],
	['reset', undefined, "the server's reset and stop-sending"],
	['abort', undefined, "the page's reset and stop-sending"],
	['refused', undefined, 'a refused session'],
	['protocol', undefined, 'the protocol the server picks'],
	['backpressure', undefined, 'a server that does not read'],
	['webpki', undefined, 'a certificate the WebPKI takes'],
	['wrongHash', undefined, 'a pinned hash that is not the certificate'],
	['blocked', undefined, "a session the content blocker's list refuses"],
	['echo', 'worker', 'a bidirectional stream echoed, in a worker'],
];

const native = [];
for (const [name, realm, what] of CASES) {
	const answered = await natively(name, realm);
	native.push(answered);
	ok(
		`natively: ${what}: the page answered`,
		answered.result !== null &&
			typeof answered.result === 'object' &&
			!answered.result.probeError,
		brief(answered.result),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const tab = proxiedTab(base);
	for (const [index, [name, realm, what]] of CASES.entries()) {
		const proxied = await tab(name, realm);
		const expected = native[index];
		const differ = differences(expected.result, proxied.result);
		ok(
			`${mode}: ${what}: as natively`,
			differ.length === 0,
			differ.slice(0, 12).join('\n     '),
		);
		if (name === 'blocked') {
			// natively the server refuses it; through the proxy it never
			// hears of it
			ok(
				`${mode}: ${what}: the server never heard of it`,
				expected.server.length > 0 && proxied.server.length === 0,
				`native ${brief(expected.server)} proxied ${brief(proxied.server)}`,
			);
			continue;
		}
		const heard = differences(expected.server, proxied.server);
		ok(
			`${mode}: ${what}: the server saw what it sees natively`,
			heard.length === 0,
			heard.slice(0, 12).join('\n     '),
		);
	}
}

server.close();
await done(browser);
