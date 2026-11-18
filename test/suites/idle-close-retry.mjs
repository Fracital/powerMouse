// A request that goes out on a kept-alive connection just as the server
// closes it for idling, against Chrome 157. The server's close crosses the
// request: the request reaches it, and the connection ends with no byte of a
// response. Chrome sends such a request again, on another connection
// (net/http/http_network_transaction.cc HandleIOError, ShouldResendRequest:
// the connection was reused and no response head came), whatever its method
// (a POST's or a PUT's body is in memory and goes out again), as many times
// as it finds kept connections; so too a 408 on a kept HTTP/1 connection,
// and a stream an HTTP/2 server refused (twice at most, from any
// connection). A request whose response had begun, or that was the first
// on its connection, fails. Through the proxy (measured 2026-11-18) epoxy
// sent nothing again, and STomp's transport wrapper sent a GET, HEAD or
// OPTIONS again up to four times whatever came before the close (a fresh
// connection's, a truncated head's) and nothing else: a POST the server's
// idle timer caught failed, a GET a fresh connection dropped reached the
// server five times. Epoxy now sends again what Chrome does (deploy/epoxy
// patches hyper 0052, hyper-util-wasm 0052, epoxy-tls 0073), and the
// wrapper sends again only what a lost wisp connection took.
//
// The HTTP/1 server is raw TCP, so it decides when a connection ends: a
// request that arrives on a connection that has answered before, the first
// time its id arrives, is the one the idle timer caught (the connection
// closes with a FIN, or a RST, or after part of a response or a 408); the
// first request on a fresh connection is never dropped there. A second
// server drops the first request of every connection. An HTTP/2 server
// over TLS (a certificate from a test CA the controller's epoxy is told to
// trust, natively taken with --ignore-certificate-errors) refuses a
// stream, sends GOAWAY below it, or closes its connection under it. The
// servers count each id's arrivals, and the same page runs natively and in
// a proxied frame.
import { constants, createSecureServer } from 'node:http2';
import { createServer } from 'node:net';
import { done, launch, ok, PROXY, sleep } from '../lib.mjs';

// the test CA and a certificate for ::1 and 127.0.0.1 it issued (P-256,
// valid until 2126; the epoxy-ipv6 suite's)
const CA = `-----BEGIN CERTIFICATE-----
MIIBljCCAT2gAwIBAgIUIqwTGjkLTyRMFrG8OJ7NoJUH6VUwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNc3RvbXAgdGVzdCBDQTAgFw0yNjExMTAxOTE0MzFaGA8yMTI2
MTAxNzE5MTQzMVowGDEWMBQGA1UEAwwNc3RvbXAgdGVzdCBDQTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABMdw7oRl1fB4NxIDtn7k7S4dgO8r4b4+w6SPj8/wyd+r
LPB/Di5EWJ76f2lhVlCzn+XX/uXkDAZKfo9/zCZrxAOjYzBhMB0GA1UdDgQWBBSr
cBeylZqqxH2Pi9hpqv3o2W3jSzAfBgNVHSMEGDAWgBSrcBeylZqqxH2Pi9hpqv3o
2W3jSzAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDAKBggqhkjOPQQD
AgNHADBEAiB5JmPUrop3FHOWpz3xZjJC08xb0Uhq8nci+wpYqVI1EQIgPiVEP2Wq
yoLLloM7eDc6wr5DuZatY7munzK6Ez0Bxgw=
-----END CERTIFICATE-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBwTCCAWegAwIBAgIUPYJNCP72ZKeettJ5DVEBl5PpJrQwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNc3RvbXAgdGVzdCBDQTAgFw0yNjExMTAxOTE0MzFaGA8yMTI2
MTAxNzE5MTQzMVowDjEMMAoGA1UEAwwDOjoxMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAElbOYhM6EYDSndlBjujJp8mc1gzAYVnAEQTvtxJyKXGRtvzGxL4HWc8UJ
HmIg3OhaAsuVAyVu4ogGx0AbhoHRW6OBljCBkzAJBgNVHRMEAjAAMA4GA1UdDwEB
/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAhBgNVHREEGjAYhxAAAAAAAAAA
AAAAAAAAAAABhwR/AAABMB0GA1UdDgQWBBToYdgAEYTrKgzjTEP3Z1Us87PXTzAf
BgNVHSMEGDAWgBSrcBeylZqqxH2Pi9hpqv3o2W3jSzAKBggqhkjOPQQDAgNIADBF
AiEAtkEjUjKnANHGRSsu+86RiCG6WPL+Css8PlJs/V24pOYCIBZCYQGoKoZObLpe
o7b4mFaOiw4KhmxBgu/h+riZgk3Q
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghX9CBofM+VE06wRU
D9TqZV9vqPKA6cKjmPBbaP5XCFahRANCAASVs5iEzoRgNKd2UGO6MmnyZzWDMBhW
cARBO+3EnIpcZG2/MbEvgdZzxQkeYiDc6FoCy5UDJW7iiAbHQBuGgdFb
-----END PRIVATE KEY-----
`;

/**
 * The page's cases, in order: the server (`h1`; `fresh`, which drops the
 * first request of every connection; `h2`; `h2cold`, a server of the
 * case's own whose first stream is dropped), the request, how its
 * connection ends (`close`) the first time it arrives on a connection that
 * answered before (with `every`, each time it does), and how many times it
 * reached the server from Chrome 157 (`chrome`, measured 2026-11-18)
 */
const CASES = [
	{ name: 'GET, FIN', method: 'GET', close: 'fin', chrome: 2 },
	{ name: 'GET, RST', method: 'GET', close: 'rst', chrome: 2 },
	{
		name: 'POST, FIN',
		method: 'POST',
		body: 'post-1',
		close: 'fin',
		chrome: 2,
	},
	{
		name: 'POST, RST',
		method: 'POST',
		body: 'post-2',
		close: 'rst',
		chrome: 2,
	},
	{ name: 'PUT, FIN', method: 'PUT', body: 'put', close: 'fin', chrome: 2 },
	{ name: 'DELETE, FIN', method: 'DELETE', close: 'fin', chrome: 2 },
	// the status line and a field, no blank line after them
	{
		name: 'GET, part of the head then FIN',
		method: 'GET',
		close: 'head',
		chrome: 1,
	},
	// a whole head with Content-Length 10, then 3 bytes of body
	{
		name: 'GET, the head and part of the body then FIN',
		method: 'GET',
		close: 'body',
		chrome: 1,
	},
	// a whole 408 (Request Timeout) with Connection: close, then FIN
	{ name: 'GET, 408 then FIN', method: 'GET', close: '408', chrome: 2 },
	{
		name: 'POST, 408 then FIN',
		method: 'POST',
		body: 'post-408',
		close: '408',
		chrome: 2,
	},
	{
		name: 'GET, the first request of a fresh connection, FIN',
		method: 'GET',
		close: 'fin',
		server: 'fresh',
		chrome: 1,
	},
	{
		name: 'POST, the first request of a fresh connection, FIN',
		method: 'POST',
		body: 'post-fresh',
		close: 'fin',
		server: 'fresh',
		chrome: 1,
	},
	{
		name: 'GET, 408 on the first request of a fresh connection',
		method: 'GET',
		close: '408',
		server: 'fresh',
		chrome: 1,
	},
	// six connections kept alive (Chrome's most to an HTTP/1 server), and
	// each that has answered before drops the request: it goes on each, then
	// on a fresh one
	{
		name: 'GET, every kept-alive connection drops it',
		method: 'GET',
		close: 'fin',
		every: true,
		warm: 6,
		chrome: 7,
	},
	{
		name: 'HTTP/2 GET, RST_STREAM REFUSED_STREAM',
		method: 'GET',
		close: 'refused',
		server: 'h2',
		chrome: 2,
	},
	{
		name: 'HTTP/2 POST, RST_STREAM REFUSED_STREAM',
		method: 'POST',
		body: 'h2-refused',
		close: 'refused',
		server: 'h2',
		chrome: 2,
	},
	// Chrome sends a refused stream again twice at most (kMaxRetryAttempts)
	{
		name: 'HTTP/2 GET, every stream refused',
		method: 'GET',
		close: 'refused',
		every: true,
		server: 'h2',
		chrome: 3,
	},
	{
		name: 'HTTP/2 GET, GOAWAY below its stream',
		method: 'GET',
		close: 'goaway',
		server: 'h2',
		chrome: 2,
	},
	{
		name: 'HTTP/2 POST, GOAWAY below its stream',
		method: 'POST',
		body: 'h2-goaway',
		close: 'goaway',
		server: 'h2',
		chrome: 2,
	},
	{
		name: 'HTTP/2 GET, the connection closes under it',
		method: 'GET',
		close: 'destroy',
		server: 'h2',
		chrome: 2,
	},
	{
		name: 'HTTP/2 POST, the connection closes under it',
		method: 'POST',
		body: 'h2-destroy',
		close: 'destroy',
		server: 'h2',
		chrome: 2,
	},
	{
		name: 'HTTP/2 GET, a fresh connection closes under it',
		method: 'GET',
		close: 'destroy',
		server: 'h2cold',
		chrome: 1,
	},
	// a refused stream goes again from a fresh connection too
	{
		name: 'HTTP/2 GET, REFUSED_STREAM on a fresh connection',
		method: 'GET',
		close: 'refused',
		server: 'h2cold',
		chrome: 2,
	},
	{
		name: 'HTTP/2 GET, GOAWAY below it on a fresh connection',
		method: 'GET',
		close: 'goaway',
		server: 'h2cold',
		chrome: 1,
	},
	// a 408 over HTTP/2 is the page's
	{
		name: 'HTTP/2 GET, 408 on a kept-alive connection',
		method: 'GET',
		close: '408',
		server: 'h2',
		chrome: 1,
	},
];

// Checks known to differ from Chrome, by why. A check on the list that now
// reads as natively fails too: take it off.
const KNOWN_BY_REASON = {
	// Chrome takes a truncated head over plain HTTP for a response (the
	// fields it has, an empty body: HttpStreamParser's
	// HEADER_ALLOWED_TRUNCATED_HEADERS; over HTTPS it is
	// ERR_RESPONSE_HEADERS_TRUNCATED); hyper fails the request
	'a truncated response head over plain HTTP is an error': [
		'GET, part of the head then FIN: outcome',
	],
};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

/** what reached the servers, by request id */
const arrivals = new Map();
const reports = new Map();
let connections = 0;

const pageHtml = (
	run,
	origins,
) => `<!doctype html><title>IDLE CLOSE</title><script>
const run = ${JSON.stringify(run)};
const origins = ${JSON.stringify(origins)};
const CASES = ${JSON.stringify(CASES)};
(async () => {
	const out = {};
	for (const [n, c] of CASES.entries()) {
		const id = run + '-' + n;
		const origin = origins[c.server === 'h2cold' ? 'h2cold-' + n : c.server ?? 'h1'];
		// a connection that has answered, idle when the request goes (the
		// fresh server's only connection is the request's)
		const warm = c.server === 'h2' ? origin : origins.h1;
		if (c.server !== 'h2cold')
			await Promise.all(
				Array.from({ length: c.warm ?? 1 }, (_, i) =>
					fetch(warm + '/warm?d=' + (c.warm ? 300 : 0) + '&id=' + id + '-w' + i, { cache: 'no-store' }).then((r) => r.text()),
				),
			);
		const url = origin + '/t?id=' + id + '&close=' + c.close + (c.every ? '&every' : '');
		let outcome;
		try {
			const r = await fetch(url, { method: c.method, body: c.body, cache: 'no-store' });
			try {
				outcome = 'status ' + r.status + ' ' + JSON.stringify(await r.text());
			} catch (error) {
				outcome = 'status ' + r.status + ', body ' + error.name;
			}
		} catch (error) {
			outcome = 'rejected ' + error.name;
		}
		out[c.name] = outcome;
	}
	await fetch('/report?run=' + run, { method: 'POST', body: JSON.stringify(out), cache: 'no-store' });
})();
</script>`;

/** what the request is and where it came, for the counts; whether to drop it */
function arrive(id, connection, reused, method, body, q, fresh) {
	if (!arrivals.has(id)) arrivals.set(id, []);
	const list = arrivals.get(id);
	list.push({ connection, reused, method, body });
	const dropped = fresh
		? !reused && (fresh === 'every' || list.length === 1)
		: reused && (q.has('every') || list.length === 1);
	return { dropped, count: list.length };
}

const HEAD = 'Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\n';
function answer(socket, type, body) {
	const bytes = Buffer.from(body);
	socket.write(
		`HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\n${HEAD}\r\n`,
	);
	socket.write(bytes);
	socket.$served++;
}

/** end the connection the way `how` says, with no whole response */
function drop(socket, how) {
	socket.$dropped = true;
	if (how === 'rst') return socket.resetAndDestroy();
	if (how === 'head')
		return socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n');
	if (how === 'body')
		return socket.end(
			`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n${HEAD}\r\nabc`,
		);
	if (how === '408')
		return socket.end(
			`HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 7\r\n${HEAD}\r\ntimeout`,
		);
	socket.end();
}

function handle(socket, method, target, body, fresh) {
	const url = new URL(target, 'http://x/');
	const q = url.searchParams;
	if (url.pathname === '/page')
		return answer(
			socket,
			'text/html',
			pageHtml(q.get('run'), JSON.parse(q.get('origins'))),
		);
	if (url.pathname === '/report') {
		reports.set(q.get('run'), JSON.parse(body));
		return answer(socket, 'text/plain', 'ok');
	}
	if (url.pathname === '/warm')
		return setTimeout(
			() => {
				if (!socket.destroyed) answer(socket, 'text/plain', 'warm');
			},
			+q.get('d') || 0,
		);
	if (url.pathname !== '/t') {
		socket.write(`HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n${HEAD}\r\n`);
		return socket.$served++;
	}
	const { dropped, count } = arrive(
		q.get('id'),
		socket.$id,
		socket.$served > 0,
		method,
		body,
		q,
		fresh,
	);
	if (dropped) return drop(socket, q.get('close'));
	answer(socket, 'text/plain', `answered ${count}`);
}

/** a raw HTTP/1.1 server: requests with a Content-Length body, kept alive */
function rawServer(fresh) {
	return createServer((socket) => {
		socket.$id = ++connections;
		socket.$served = 0;
		socket.on('error', () => {});
		let buffer = Buffer.alloc(0);
		socket.on('data', (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (!socket.$dropped && !socket.destroyed) {
				const end = buffer.indexOf('\r\n\r\n');
				if (end < 0) return;
				const [line, ...fields] = buffer
					.subarray(0, end)
					.toString('latin1')
					.split('\r\n');
				const length = Number(
					fields
						.find((field) => /^content-length:/i.test(field))
						?.split(':')[1] ?? 0,
				);
				if (buffer.length < end + 4 + length) return;
				const body = buffer.subarray(end + 4, end + 4 + length).toString();
				buffer = buffer.subarray(end + 4 + length);
				const [method, target] = line.split(' ');
				handle(socket, method, target, body, fresh);
			}
		});
	});
}

/** an HTTP/2 server over TLS; `cold`, a server whose only session is the request's */
function h2Server(cold) {
	const h2 = createSecureServer({ cert: CERT + CA, key: KEY });
	h2.on('session', (session) => {
		session.$id = ++connections;
		session.$served = 0;
		session.on('error', () => {});
	});
	h2.on('stream', (stream, headers) => {
		stream.on('error', () => {});
		const session = stream.session;
		const url = new URL(headers[':path'], 'https://x/');
		const q = url.searchParams;
		const reply = (status, text) => {
			stream.respond({
				':status': status,
				'content-type': 'text/plain',
				'cache-control': 'no-store',
				'access-control-allow-origin': '*',
			});
			stream.end(text);
			session.$served++;
		};
		if (url.pathname === '/warm') return reply(200, 'warm');
		if (url.pathname !== '/t') return reply(404, '');
		const chunks = [];
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('end', () => {
			const { dropped, count } = arrive(
				q.get('id'),
				session.$id,
				session.$served > 0,
				headers[':method'],
				Buffer.concat(chunks).toString(),
				q,
				cold,
			);
			if (!dropped) return reply(200, `answered ${count}`);
			const how = q.get('close');
			if (how === 'refused')
				return stream.close(constants.NGHTTP2_REFUSED_STREAM);
			if (how === '408') return reply(408, 'timeout');
			if (how === 'goaway') {
				// the last stream it took is the one before this request's
				session.goaway(constants.NGHTTP2_NO_ERROR, Math.max(0, stream.id - 2));
				return setTimeout(() => session.destroy(), 100);
			}
			session.destroy();
		});
	});
	return h2;
}

const listen = (server) =>
	new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
	);
const ORIGINS = {
	h1: `http://127.0.0.1:${await listen(rawServer(false))}`,
	fresh: `http://127.0.0.1:${await listen(rawServer('every'))}`,
	h2: `https://127.0.0.1:${await listen(h2Server(false))}`,
};
// a server of its own for each case on a fresh HTTP/2 connection
for (const [n, c] of CASES.entries())
	if (c.server === 'h2cold')
		ORIGINS[`h2cold-${n}`] =
			`https://127.0.0.1:${await listen(h2Server(true))}`;

/** what each case came to: the page's outcome and what reached the server */
function summary(run) {
	const report = reports.get(run);
	const out = {};
	for (const [n, c] of CASES.entries()) {
		const list = arrivals.get(`${run}-${n}`) ?? [];
		out[c.name] = {
			outcome: report?.[c.name] ?? 'no report',
			arrivals: list.length,
			'first on a kept-alive connection': list[0]?.reused ?? null,
			'every arrival carried the body':
				c.body === undefined || list.every((a) => a.body === c.body),
		};
	}
	return out;
}

async function measure(run, go) {
	await go(
		`${ORIGINS.h1}/page?run=${run}&origins=${encodeURIComponent(JSON.stringify(ORIGINS))}`,
	);
	for (let i = 0; i < 600 && !reports.has(run); i++) await sleep(100);
	return summary(run);
}

const browser = await launch(['--ignore-certificate-errors']);

const nativeContext = await browser.newContext({ ignoreHTTPSErrors: true });
const nativePage = await nativeContext.newPage();
const native = await measure('native', (url) => nativePage.goto(url));
await nativeContext.close();
console.log('native', JSON.stringify(native, null, 1));

// what Chrome does, so a change in the browser shows here first
for (const { name, chrome } of CASES)
	ok(
		`natively, ${name}: reached the server ${chrome === 1 ? 'once' : `${chrome} times`}`,
		native[name].arrivals === chrome,
		JSON.stringify(native[name]),
	);

const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
await page.evaluate(async (ca) => {
	const { StompController } = await import('/stomp/controller.mjs');
	const registration = await StompController.register('/stomp/');
	const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
	const controller = new StompController({
		serviceworker: registration,
		transport: {
			module: '/epoxy/index.mjs',
			options: [{ wisp, pem_files: [ca] }],
		},
		directory: '/stomp/',
		codec: 'xor',
	});
	await controller.wait();
	window.controller = controller;
}, CA);
const proxied = await measure('proxied', (url) =>
	page.evaluate((url) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		window.controller.createFrame(element).go(url);
	}, url),
);
console.log('proxied', JSON.stringify(proxied, null, 1));

for (const { name } of CASES)
	for (const [field, value] of Object.entries(native[name])) {
		const check = `${name}: ${field}`;
		const same =
			JSON.stringify(proxied[name]?.[field]) === JSON.stringify(value);
		const detail = `native ${JSON.stringify(value)}, proxied ${JSON.stringify(proxied[name]?.[field])}`;
		if (KNOWN.has(check))
			ok(
				`KNOWN (${KNOWN.get(check)}): ${check}`,
				!same,
				`${detail}; reads as natively now, take it off the list`,
			);
		else ok(`${check}, as natively`, same, detail);
	}

await done(browser, errors);
