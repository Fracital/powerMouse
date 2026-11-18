// Fields and key shares epoxy sends next to Chrome's, read by a server of
// the suite's own (HTTP/2 over TLS on 127.0.0.1, its certificate from a CA
// the controller's epoxy is told to trust) for the same page loaded
// natively and through the proxy:
//
// - Cookie over HTTP/2: Chrome's HPACK encoder sends one field per cookie
//   (its crumbs, RFC 9113 8.2.3); epoxy sent one joined field.
// - Content-Length on an empty request: Chrome says 0 for POST and PUT
//   only; epoxy's HTTP/2 client said 0 for OPTIONS (the CORS preflight)
//   and PATCH too.
// - The X25519 key share: Chrome's is a key of its own, epoxy's was the
//   classical half of its X25519MLKEM768 share (the last 32 bytes equal).
//
// Measured 2026-11-17 with Chrome 157 against a capture server
// (deploy/epoxy patches h2-wasm 0053, hyper 0051, epoxy-tls 0070 and 0071).
import { createSecureServer } from 'node:http2';
import { createServer as createNet } from 'node:net';
import { done, launch, ok, PROXY, sleep } from '../lib.mjs';

// a test CA and a certificate for 127.0.0.1 it issued (P-256, valid until
// 2126); epoxy trusts the CA through its pem_files option
const CA = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT2gAwIBAgIUD/TZJvS1lO4SDUtoA2hagvsdG1QwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNc3RvbXAgdGVzdCBDQTAgFw0yNjExMTcyMjU1MjJaGA8yMTI2
MTAyNDIyNTUyMlowGDEWMBQGA1UEAwwNc3RvbXAgdGVzdCBDQTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABP5Drt4SXWv6lqfqgEZGJvbqoHAuerKtoWpD0HkSsV5v
po8AkdHb5uLQ+ouyGnXbaEEdVikdC/utMDJsbvSv8JyjYzBhMB0GA1UdDgQWBBTd
Yz5YR+1KwujJmDZOJcIDbYCs9zAfBgNVHSMEGDAWgBTdYz5YR+1KwujJmDZOJcID
bYCs9zAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDAKBggqhkjOPQQD
AgNJADBGAiEAr0TK/4GbC9zi+YVVMkFDakB3cp8JrxXw0Sy8+6r2h3oCIQCRAOdV
/jRul+R8Lxq1//MXZ61XnUuLHnWvPnXnaMiEmA==
-----END CERTIFICATE-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUWW3bqfu+gSq0vK+Ho16PyQzRO88wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNc3RvbXAgdGVzdCBDQTAgFw0yNjExMTcyMjU1MjJaGA8yMTI2
MTAyNDIyNTUyMlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAElgt4A1t/OAU3Uew6aLfrVBkoD2dkVvgusWn0a4dRAyq+Yvtm
GnibYSB4X4ZS1sDeNl5lxFSuxksF1HoHEKNPGqOBhDCBgTAJBgNVHRMEAjAAMA4G
A1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAPBgNVHREECDAGhwR/
AAABMB0GA1UdDgQWBBRLahZBk/genhwHHQxzRSJfvYGE3DAfBgNVHSMEGDAWgBTd
Yz5YR+1KwujJmDZOJcIDbYCs9zAKBggqhkjOPQQDAgNIADBFAiEAxMI+DgZwPzud
BxxUuO6i6xLYDWiQVmdB3hEU93DhdjYCIHpx+Pk6szOr5VnH6Gq7LtZNeGB7vDIG
pnoQrPmvLMxE
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgr5imIISJT7/v1Vk3
G3BrMmRuQLwCWUfAt0+vtVFoeLmhRANCAASWC3gDW384BTdR7Dpot+tUGSgPZ2RW
+C6xafRrh1EDKr5i+2YaeJthIHhfhlLWwN42XmXEVK7GSwXUegcQo08a
-----END PRIVATE KEY-----
`;
const TIMEOUT_MS = 20000;
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const PAGE = `<!doctype html><title>fields</title><script>
const run = new URLSearchParams(location.search).get('k');
document.cookie = 'a=1; path=/';
document.cookie = 'b=2; path=/';
(async () => {
	await fetch('/f?k=' + run + '&t=cookie');
	for (const method of ${JSON.stringify(METHODS)})
		await fetch('/f?k=' + run + '&t=empty-' + method, { method });
	document.title = 'done';
})();
</script>`;

/** per run: each request's cookie fields and Content-Length, by its t */
const seen = { native: {}, proxied: {} };
/** each connection's key shares, by the client's port */
const shares = new Map();
/** the run each connection served, by the client's port */
const runOf = new Map();

/** group -> share bytes, from the ClientHello at the start of `bytes` */
function keyShares(bytes) {
	const out = {};
	let hs = Buffer.alloc(0);
	for (let p = 0; p + 5 <= bytes.length && bytes[p] === 22;) {
		const length = bytes.readUInt16BE(p + 3);
		hs = Buffer.concat([hs, bytes.subarray(p + 5, p + 5 + length)]);
		p += 5 + length;
	}
	if (hs[0] !== 1) return out;
	let p = 4 + 2 + 32;
	p += 1 + hs[p];
	p += 2 + hs.readUInt16BE(p);
	p += 1 + hs[p];
	const end = p + 2 + hs.readUInt16BE(p);
	for (p += 2; p + 4 <= end;) {
		const type = hs.readUInt16BE(p);
		const length = hs.readUInt16BE(p + 2);
		if (type === 51) {
			const body = hs.subarray(p + 4, p + 4 + length);
			for (let q = 2; q + 4 <= body.length;) {
				const size = body.readUInt16BE(q + 2);
				out[body.readUInt16BE(q)] = body.subarray(q + 4, q + 4 + size);
				q += 4 + size;
			}
		}
		p += 4 + length;
	}
	return out;
}

/** true once `bytes` holds the whole handshake message the first record starts */
function helloComplete(bytes) {
	if (bytes.length < 9) return false;
	const needed = bytes.readUIntBE(6, 3) + 4;
	let have = 0;
	for (let p = 0; p + 5 <= bytes.length;) {
		const length = bytes.readUInt16BE(p + 3);
		if (p + 5 + length > bytes.length) break;
		have += length;
		p += 5 + length;
	}
	return have >= needed;
}

const h2 = createSecureServer({ cert: CERT + CA, key: KEY });
h2.on('stream', (stream, headers, _flags, rawHeaders) => {
	const url = new URL(headers[':path'], 'https://x/');
	const run = url.searchParams.get('k');
	const port = stream.session.socket.remotePort;
	if (run in seen) runOf.set(port, run);
	if (url.pathname === '/page') {
		stream.respond({ ':status': 200, 'content-type': 'text/html' });
		stream.end(PAGE);
		return;
	}
	const fields = [];
	for (let i = 0; i < rawHeaders.length; i += 2)
		fields.push([rawHeaders[i].toLowerCase(), rawHeaders[i + 1]]);
	if (run in seen)
		seen[run][url.searchParams.get('t')] = {
			cookies: fields.filter(([n]) => n === 'cookie').map(([, v]) => v),
			length: fields.find(([n]) => n === 'content-length')?.[1] ?? null,
		};
	stream.resume();
	stream.respond({ ':status': 200, 'content-type': 'text/plain' });
	stream.end('ok');
});
// the ClientHello is read off the socket before TLS takes it
const front = createNet((socket) => {
	let bytes = Buffer.alloc(0);
	const onData = (chunk) => {
		bytes = Buffer.concat([bytes, chunk]);
		if (!helloComplete(bytes) && bytes.length < 65536) return;
		socket.removeListener('data', onData);
		socket.pause();
		shares.set(socket.remotePort, keyShares(bytes));
		socket.unshift(bytes);
		h2.emit('connection', socket);
	};
	socket.on('data', onData);
});
const port = await new Promise((resolve, reject) => {
	front.once('error', reject);
	front.listen(0, '127.0.0.1', () => resolve(front.address().port));
});
const ORIGIN = `https://127.0.0.1:${port}`;

const browser = await launch();
const errors = [];

// natively
const nativeContext = await browser.newContext({ ignoreHTTPSErrors: true });
const nativePage = await nativeContext.newPage();
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(`${ORIGIN}/page?k=native`);
await nativePage
	.waitForFunction(() => document.title === 'done', null, {
		timeout: TIMEOUT_MS,
	})
	.catch(() => {});
await nativeContext.close();

// through the proxy, with an epoxy that trusts the suite's CA
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(`proxied: ${error.message}`));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const title = await page.evaluate(
	async ({ ca, url, timeoutMs }) => {
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
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = controller.createFrame(element);
		await frame.go(url);
		const until = Date.now() + timeoutMs;
		while (Date.now() < until) {
			const title = element.contentDocument?.title;
			if (title === 'done') return title;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return element.contentDocument?.title ?? null;
	},
	{ ca: CA, url: `${ORIGIN}/page?k=proxied`, timeoutMs: TIMEOUT_MS },
);
await sleep(300);

const native = seen.native;
const proxied = seen.proxied;
ok(
	'the page loaded natively and through the proxy and made its requests',
	!!native.cookie && !!proxied.cookie && title === 'done',
	`title ${title}; native ${Object.keys(native)}; proxied ${Object.keys(proxied)}`,
);
ok(
	'natively, Cookie over HTTP/2 is one field per cookie',
	JSON.stringify(native.cookie?.cookies) === '["a=1","b=2"]',
	JSON.stringify(native.cookie),
);
ok(
	'through the proxy, Cookie over HTTP/2 is one field per cookie, as natively',
	JSON.stringify(proxied.cookie?.cookies) ===
		JSON.stringify(native.cookie?.cookies),
	`native ${JSON.stringify(native.cookie?.cookies)} proxied ${JSON.stringify(proxied.cookie?.cookies)}`,
);
for (const method of METHODS) {
	const t = `empty-${method}`;
	ok(
		`an empty ${method} says Content-Length ${native[t]?.length ?? 'nothing'} through the proxy, as natively`,
		!!native[t] && !!proxied[t] && native[t].length === proxied[t].length,
		`native ${native[t]?.length} proxied ${proxied[t]?.length}`,
	);
}
const reuse = (run) =>
	[...shares]
		.filter(([client]) => runOf.get(client) === run)
		.map(([, share]) =>
			share[4588] && share[29]
				? Buffer.compare(share[4588].subarray(1184), share[29]) === 0
				: null,
		);
ok(
	'natively, the X25519 share is a key apart from the X25519MLKEM768 one',
	reuse('native').length > 0 && reuse('native').every((r) => r === false),
	JSON.stringify(reuse('native')),
);
ok(
	"through the proxy, the X25519 share is a key of its own, as Chrome's",
	reuse('proxied').length > 0 && reuse('proxied').every((r) => r === false),
	JSON.stringify(reuse('proxied')),
);
ok('no page errors', errors.length === 0, errors.join(' | '));

h2.close();
front.close();
await done(browser);
