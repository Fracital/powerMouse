// Connection timing and sizes of a page's own loads, against Chrome 157:
// the protocol each answer came over (nextHopProtocol), the connection's
// steps (a fresh connection's lookup, connect, TLS start and end in order;
// one that carried a request before has them all at the fetch's start, TLS
// too), and the bytes a compressed body came as (encodedBodySize, with no
// Content-Length to say it) and decoded. A service worker's answer has
// none of these in the browser: the worker marks what the transport says
// (stomp-protocol, stomp-connection, stomp-size: src/transport/
// responseFacts.ts, the transport's own counts from deploy/epoxy) and the
// inject shows them (src/inject/modules/ResourceTiming.ts).
//
// The suite's servers on 127.0.0.1: an HTTP/2 one over TLS (a certificate
// from a test CA the controller's epoxy is told to trust, natively taken
// with --ignore-certificate-errors) and an HTTP/1 one. Each serves a page
// sent with brotli and no Content-Length, which loads a script sent the
// same way, then fetches a small text twice; the page reports its entries.
// Times themselves are never compared, only their shape.
import { createServer as createHttp } from 'node:http';
import { createSecureServer } from 'node:http2';
import { brotliCompressSync } from 'node:zlib';
import { done, launch, ok, PROXY, sleep } from '../lib.mjs';

// the test CA and a certificate for ::1 and 127.0.0.1 it issued (the
// connection-limits suite's)
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

const reports = new Map();

/** what each page reports of its entries */
const reportScript = (tag) => `
addEventListener('load', async () => {
	await fetch('/plain?n=1', { cache: 'no-store' }).then((r) => r.text());
	await fetch('/plain?n=2', { cache: 'no-store' }).then((r) => r.text());
	await new Promise((resolve) => setTimeout(resolve, 200));
	const https = location.protocol === 'https:';
	const shape = (e) => {
		const steps = [e.fetchStart, e.domainLookupStart, e.domainLookupEnd, e.connectStart, e.connectEnd, e.requestStart, e.responseStart];
		const url = new URL(e.name);
		return {
			kind: e.entryType === 'navigation' ? 'document' : e.initiatorType + ' ' + url.pathname + url.search.replace(/run=[^&]*&?/, ''),
			protocol: e.nextHopProtocol,
			encoding: e.contentEncoding,
			encoded: e.encodedBodySize,
			decoded: e.decodedBodySize,
			transferred: e.transferSize,
			'steps in order': steps.every((t, i) => i === 0 || t >= steps[i - 1]),
			'a connection made': e.connectEnd > e.connectStart,
			'TLS within the connection': https
				? e.secureConnectionStart >= e.connectStart && e.secureConnectionStart <= e.connectEnd && e.secureConnectionStart > 0
				: e.secureConnectionStart === 0,
			'every step at the fetch start':
				[e.domainLookupStart, e.domainLookupEnd, e.connectStart, e.connectEnd].every((t) => t === e.fetchStart) &&
				(https ? e.secureConnectionStart === e.fetchStart : e.secureConnectionStart === 0),
			'toJSON as the getters': ['nextHopProtocol', 'secureConnectionStart', 'connectStart', 'encodedBodySize'].every((k) => e.toJSON()[k] === e[k]),
		};
	};
	const entries = [
		...performance.getEntriesByType('navigation'),
		...performance.getEntriesByType('resource').filter((e) => /\\/(script|plain)/.test(e.name)),
	].map(shape);
	fetch('/report?run=${tag}', { method: 'POST', body: JSON.stringify(entries) });
});`;

const SCRIPT = `globalThis.loaded = ${JSON.stringify('x'.repeat(4000))}.length;`;

function handler(req, res) {
	const url = new URL(req.url, 'http://x/');
	const tag = url.searchParams.get('run') ?? '';
	const head = { 'cache-control': 'no-store' };
	// a body sent compressed, in two writes and without a Content-Length
	const compressed = (type, text) => {
		const bytes = brotliCompressSync(Buffer.from(text));
		res.writeHead(200, {
			...head,
			'content-type': type,
			'content-encoding': 'br',
		});
		res.write(bytes.subarray(0, 10));
		setTimeout(() => res.end(bytes.subarray(10)), 20);
	};
	if (url.pathname === '/page.html')
		return compressed(
			'text/html',
			`<!doctype html><title>TIMING</title><p>${'text '.repeat(400)}</p><script src="/script.js?run=${tag}"></script><script>${reportScript(tag)}</script>`,
		);
	if (url.pathname === '/script.js')
		return compressed('text/javascript', SCRIPT);
	if (url.pathname === '/plain') {
		res.writeHead(200, { ...head, 'content-type': 'text/plain' });
		return res.end('plain');
	}
	if (url.pathname === '/report') {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			reports.set(tag, JSON.parse(body));
			res.writeHead(200, head);
			res.end('ok');
		});
		return;
	}
	res.writeHead(404, head);
	res.end();
}

const listen = (server) =>
	new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
	);
const h1 = createHttp({ keepAliveTimeout: 60000 }, handler);
const h2 = createSecureServer({ cert: CERT + CA, key: KEY }, handler);
const SERVERS = [
	['an HTTP/2 server over TLS', `https://127.0.0.1:${await listen(h2)}`],
	['an HTTP/1 server', `http://127.0.0.1:${await listen(h1)}`],
];

const browser = await launch(['--ignore-certificate-errors']);

async function measure(mode, go) {
	const out = {};
	for (const [index, [name, origin]] of SERVERS.entries()) {
		// (as long in both modes: the page's text holds it)
		const tag = `${mode[0]}${index}`;
		await go(`${origin}/page.html?run=${tag}`);
		for (let i = 0; i < 300 && !reports.has(tag); i++) await sleep(100);
		out[name] = reports.get(tag) ?? null;
	}
	return out;
}

const nativeContext = await browser.newContext({ ignoreHTTPSErrors: true });
const nativePage = await nativeContext.newPage();
const native = await measure('native', (url) => nativePage.goto(url));
await nativeContext.close();
console.log('native', JSON.stringify(native));

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
		document.querySelector('iframe')?.remove();
		const element = document.createElement('iframe');
		document.body.append(element);
		window.controller.createFrame(element).go(url);
	}, url),
);
console.log('proxied', JSON.stringify(proxied));

ok(
	'natively, each page reported its document, its script and two fetches',
	SERVERS.every(([name]) => native[name]?.length === 4),
	JSON.stringify(native),
);
// A plain connection to 127.0.0.1 is made within the timer's step natively
// (its connect reads 0 ms or 0.1), and Chrome sometimes opens a second one
// for the next fetch while the first is still being let go, so whether an
// HTTP/1 load made a connection is not compared: through the proxy it is
// the wisp stream's, a round trip. Its order, protocol and sizes are.
const UNMEASURED = (name, field) =>
	name === 'an HTTP/1 server' &&
	(field === 'a connection made' || field === 'every step at the fetch start');
for (const [name] of SERVERS)
	for (const entry of native[name] ?? []) {
		const other = (proxied[name] ?? []).find((e) => e.kind === entry.kind);
		for (const [field, value] of Object.entries(entry))
			if (!UNMEASURED(name, field))
				ok(
					`${name}, ${entry.kind}: ${field}, as natively`,
					JSON.stringify(other?.[field]) === JSON.stringify(value),
					`native ${JSON.stringify(value)}, proxied ${JSON.stringify(other?.[field])}`,
				);
	}

await done(browser, errors);
