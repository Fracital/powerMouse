// An IPv6 literal (`https://[::1]:port/`) loads through epoxy as natively.
// Epoxy handed the URL's host with its brackets to rustls, which took
// `[::1]` for neither a DNS name nor an address and refused the connection
// ("invalid DNS name"), and to the wisp server, which could not resolve it;
// http, https and wss to an IPv6 address all failed (measured 2026-11-10,
// fixed by deploy/epoxy/patches/epoxy-tls). A server of the suite's own on
// ::1 speaks http, https (a certificate for the address, from a CA the
// controller's epoxy is told to trust) and wss; the suite loads a page from
// each through the proxy, checks the Host field the server read (Chrome
// sends `[::1]:port`), and makes raw transport requests with no STomp in
// the path. A machine with no IPv6 loopback skips it.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PROXY } from '../lib.mjs';

// a test CA and a certificate for ::1 and 127.0.0.1 it issued (P-256,
// valid until 2126); epoxy trusts the CA through its pem_files option
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
const TIMEOUT_MS = 10000;

/** the Host field of each request, by path */
const hosts = {};
const handler = (req, res) => {
	const path = new URL(req.url, 'http://x/').pathname;
	hosts[path] = req.headers.host;
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end(`<!doctype html><title>V6 ${path}</title><p>${path}</p>`);
};
const listen = (server) =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '::1', () => resolve(server.address().port));
	});

let ports;
const plain = createHttp(handler);
const secure = createHttps({ cert: CERT + CA, key: KEY }, handler);
try {
	ports = { http: await listen(plain), https: await listen(secure) };
} catch (error) {
	console.log(`SKIP epoxy-ipv6: no IPv6 loopback here (${error.code})`);
	process.exit(0);
}
const sockets = new WebSocketServer({ server: secure });
sockets.on('connection', (ws, req) => {
	hosts['/ws'] = req.headers.host;
	ws.on('message', (data) => ws.send(`echo ${data}`));
});

const HTTP = `http://[::1]:${ports.http}`;
const HTTPS = `https://[::1]:${ports.https}`;
const WSS = `wss://[::1]:${ports.https}/ws`;

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const result = await page.evaluate(
	async ({ ca, urls, wss, timeoutMs }) => {
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
		const timeout = () =>
			new Promise((resolve) => setTimeout(() => resolve('HUNG'), timeoutMs));
		const out = { pages: {}, raw: {} };
		for (const url of urls) {
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			out.pages[url] = await Promise.race([
				frame.go(url).then(() => element.contentDocument?.title ?? null),
				timeout(),
			]).catch((error) => String(error).slice(0, 120));
			out.raw[url] = await Promise.race([
				controller.transport
					.request(new URL(url), 'GET', null, [], undefined)
					.then(async (response) => {
						const text = await new Response(response.body).text();
						return `${response.status} ${/<title>(.*?)</.exec(text)?.[1]}`;
					}),
				timeout(),
			]).catch((error) => String(error).slice(0, 120));
		}
		// a WebSocket from the proxied https page, to the same server
		const win = document.querySelector('iframe:last-of-type').contentWindow;
		out.ws = await Promise.race([
			new Promise((resolve) => {
				const ws = new win.WebSocket(wss);
				ws.onopen = () => ws.send('hi');
				ws.onmessage = (event) => resolve(String(event.data));
				ws.onerror = () => resolve('error');
			}),
			timeout(),
		]);
		return out;
	},
	{
		ca: CA,
		urls: [`${HTTP}/plain`, `${HTTPS}/secure`],
		wss: WSS,
		timeoutMs: TIMEOUT_MS,
	},
);

ok(
	'http://[::1]:port/ loads through the proxy',
	result.pages[`${HTTP}/plain`] === 'V6 /plain',
	JSON.stringify(result.pages),
);
ok(
	'https://[::1]:port/ loads through the proxy (TLS to an address, its certificate verified)',
	result.pages[`${HTTPS}/secure`] === 'V6 /secure',
	JSON.stringify(result.pages),
);
ok(
	'raw transport requests to http and https IPv6 literals answer',
	result.raw[`${HTTP}/plain`] === '200 V6 /plain' &&
		result.raw[`${HTTPS}/secure`] === '200 V6 /secure',
	JSON.stringify(result.raw),
);
ok(
	'the server read Host as [::1]:port, as Chrome sends it',
	hosts['/plain'] === `[::1]:${ports.http}` &&
		hosts['/secure'] === `[::1]:${ports.https}`,
	JSON.stringify(hosts),
);
ok(
	'a wss://[::1]:port/ WebSocket from the proxied page opens and echoes',
	result.ws === 'echo hi' && hosts['/ws'] === `[::1]:${ports.https}`,
	`${JSON.stringify(result.ws)} host ${hosts['/ws']}`,
);
ok('no page errors', errors.length === 0, errors.join(' | '));

sockets.close();
plain.close();
secure.close();
await done(browser);
