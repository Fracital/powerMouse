// A TLS connection whose Wisp stream the relay refused fails with the
// relay's reason, at once, as natively. holyWisp answers a CONNECT it will
// not open (a name on its block list, a port that refuses the connection)
// with a CLOSE and a reason; epoxy's TLS over that stream read it as the
// stream's end, and the page's request failed with a plain
// `Io(Custom { kind: UnexpectedEof, error: "tls handshake eof" })`, which
// RevivingTransport takes for a throttled stream and sent again four times
// over about a second. An agent fetching
// https://raw.githubusercontent.com/... through the controller's transport
// in a test run (whose wisp server blocks the content blocker's list
// servers, test/run.mjs LIST_SERVERS) met exactly that, while
// https://cdn.jsdelivr.net/... answered, and took it for a TLS fault of
// Fastly's: wisp-mux's MuxStreamAsyncRW asked its write side for the close
// reason, which has one only once the whole connection has ended (fixed by
// deploy/epoxy/patches/epoxy-tls 0085).
//
// No network: the suite's own TLS server on 127.0.0.1 (a certificate from a
// CA epoxy is told to trust) is the control, before and after the refusals;
// a port of 127.0.0.1 nothing listens on is refused by the destination; the
// first name the run's wisp server blocks (WISP_BLOCK_HOSTS, which test/run.mjs
// gives the demo server and the suite, raw.githubusercontent.com among them;
// holyWisp refuses it before any lookup) is refused by the relay; and a TCP
// server that reads the ClientHello and closes is a server dropping the
// handshake, which must still read as one, with no refusal reason.
import { createServer as createHttps } from 'node:https';
import { createServer as createNet } from 'node:net';
import { done, launch, ok, PROXY } from '../lib.mjs';

// (the epoxy-ipv6 suite's test CA, and its certificate for ::1 and 127.0.0.1)
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
const TIMEOUT_MS = 15000;
// what the retries of a throttled stream add up to (RevivingTransport
// BACKOFF_MS: 920 ms); a refusal that is not retried ends well before
const AT_ONCE_MS = 600;

const listen = (server) =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server.address().port));
	});

const secure = createHttps({ cert: CERT + CA, key: KEY }, (req, res) => {
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('control');
});
// reads a ClientHello's first bytes and closes, as a server dropping the
// handshake does; counts the connections it was asked for
let dropped = 0;
const dropper = createNet((socket) => {
	dropped++;
	socket.once('data', () => socket.destroy());
	socket.on('error', () => {});
});
const closed = createNet();
const ports = {
	secure: await listen(secure),
	dropper: await listen(dropper),
	closed: await listen(closed),
};
await new Promise((resolve) => closed.close(resolve));

// raw.githubusercontent.com, the name the report was about, when the run
// blocks it, else the first name it blocks
const BLOCKS = (process.env.WISP_BLOCK_HOSTS ?? '')
	.split(',')
	.map((name) => name.trim())
	.filter(Boolean);
const BLOCKED = BLOCKS.includes('raw.githubusercontent.com')
	? 'raw.githubusercontent.com'
	: BLOCKS[0];

const URLS = {
	control: `https://127.0.0.1:${ports.secure}/`,
	closed: `https://127.0.0.1:${ports.closed}/`,
	dropped: `https://127.0.0.1:${ports.dropper}/`,
	...(BLOCKED && { blocked: `https://${BLOCKED}/` }),
};

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const result = await page.evaluate(
	async ({ ca, urls, timeoutMs }) => {
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
		const ask = async (url) => {
			const start = performance.now();
			const answer = await Promise.race([
				controller.transport
					.request(new URL(url), 'GET', null, [], undefined)
					.then(
						async (response) =>
							`${response.status} ${await new Response(response.body).text()}`,
					),
				new Promise((resolve) => setTimeout(() => resolve('HUNG'), timeoutMs)),
			]).catch((error) => `ERR ${error?.message ?? error}`);
			return { answer, ms: Math.round(performance.now() - start) };
		};
		const out = { first: await ask(urls.control) };
		for (const [name, url] of Object.entries(urls))
			if (name !== 'control') out[name] = await ask(url);
		out.after = await ask(urls.control);
		return out;
	},
	{ ca: CA, urls: URLS, timeoutMs: TIMEOUT_MS },
);
const show = (row) => JSON.stringify(row);
/** the wisp close reason a refused request's error names, if any */
const reasonOf = (row) =>
	/WispCloseReason\((\w+)/.exec(row?.answer ?? '')?.[1] ?? null;

ok(
	'the control: the suite TLS server answers through epoxy',
	result.first.answer === '200 control',
	show(result.first),
);
ok(
	'a port nothing listens on: the error names the relay CLOSE reason (the destination refused it), not a bare "tls handshake eof"',
	result.closed.answer.startsWith('ERR ') &&
		/^ServerStream(?:ConnectionRefused|Unreachable)$/.test(
			reasonOf(result.closed),
		),
	show(result.closed),
);
ok(
	'a port nothing listens on: the request fails at once, not after the backoff of a throttled stream',
	result.closed.ms < AT_ONCE_MS,
	show(result.closed),
);
if (BLOCKED) {
	ok(
		`a name the relay blocks (${BLOCKED}): the error names the relay CLOSE reason, ServerStreamBlockedAddress`,
		result.blocked.answer.startsWith('ERR ') &&
			reasonOf(result.blocked) === 'ServerStreamBlockedAddress',
		show(result.blocked),
	);
	ok(
		`a name the relay blocks (${BLOCKED}): the request fails at once, not after the backoff of a throttled stream`,
		result.blocked.ms < AT_ONCE_MS,
		show(result.blocked),
	);
} else
	console.log(
		'SKIP the blocked-name rows: WISP_BLOCK_HOSTS names no host here (test/run.mjs sets it)',
	);
ok(
	'a server that drops the ClientHello still fails as a dropped handshake ("tls handshake eof"), with no refusal reason',
	result.dropped.answer.startsWith('ERR ') &&
		result.dropped.answer.includes('tls handshake eof') &&
		!/^ServerStream/.test(reasonOf(result.dropped) ?? ''),
	`${show(result.dropped)} connections ${dropped}`,
);
ok(
	'the control after the refusals: the same transport still answers',
	result.after.answer === '200 control',
	show(result.after),
);

secure.close();
dropper.close();
await done(browser);
