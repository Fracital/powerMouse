// The Priority field (RFC 9218) a page's worker scripts go out with over
// HTTP/2, read by a server of the suite's own (TLS on 127.0.0.1, its
// certificate from a CA the controller's epoxy is told to trust) for the
// same page loaded natively and through the proxy. Chrome sends u=4, i for a
// dedicated or a shared worker's script, classic or module; the proxy sent
// none (urgency 3), so a worker a page starts during a big download waited
// behind it at a different urgency than natively. A fetch (u=1, i) is the
// control.
//
// Measured 2026-11-19 with Chrome 157 (net log, over HTTP/3 to a real site
// and over HTTP/2 here).
import { createSecureServer } from 'node:http2';
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
const KINDS = ['classic', 'module', 'shared', 'sharedmodule', 'fetch'];

const PAGE = `<!doctype html><title>workers</title><script>
const run = new URLSearchParams(location.search).get('k');
const at = (t) => '/w?k=' + run + '&t=' + t;
new Worker(at('classic'));
new Worker(at('module'), { type: 'module' });
new SharedWorker(at('shared'));
new SharedWorker(at('sharedmodule'), { type: 'module' });
fetch(at('fetch')).then(() => (document.title = 'started'));
</script>`;

/** per run: the Priority each request sent (null for none), by its t */
const seen = { native: {}, proxied: {} };

const h2 = createSecureServer({ cert: CERT + CA, key: KEY });
h2.on('stream', (stream, headers) => {
	const url = new URL(headers[':path'], 'https://x/');
	const run = url.searchParams.get('k');
	if (url.pathname === '/page') {
		stream.respond({ ':status': 200, 'content-type': 'text/html' });
		stream.end(PAGE);
		return;
	}
	if (run in seen)
		seen[run][url.searchParams.get('t')] = headers.priority ?? null;
	stream.resume();
	stream.respond({ ':status': 200, 'content-type': 'text/javascript' });
	stream.end('// a worker that does nothing\n');
});
const port = await new Promise((resolve, reject) => {
	h2.once('error', reject);
	h2.listen(0, '127.0.0.1', () => resolve(h2.address().port));
});
const ORIGIN = `https://127.0.0.1:${port}`;

/** until each kind's request reached the server for `run`, or the timeout */
async function allSeen(run) {
	const until = Date.now() + TIMEOUT_MS;
	while (Date.now() < until && !KINDS.every((t) => t in seen[run]))
		await sleep(100);
}

const browser = await launch();
const errors = [];

// natively
const nativeContext = await browser.newContext({ ignoreHTTPSErrors: true });
const nativePage = await nativeContext.newPage();
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(`${ORIGIN}/page?k=native`);
await allSeen('native');
await nativeContext.close();

// through the proxy, with an epoxy that trusts the suite's CA
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(`proxied: ${error.message}`));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
await page.evaluate(
	async ({ ca, url }) => {
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
	},
	{ ca: CA, url: `${ORIGIN}/page?k=proxied` },
);
await allSeen('proxied');

const native = seen.native;
const proxied = seen.proxied;
ok(
	'the page started its workers natively and through the proxy',
	KINDS.every((t) => t in native && t in proxied),
	`native ${JSON.stringify(native)}; proxied ${JSON.stringify(proxied)}`,
);
ok(
	"natively, a worker's script says u=4, i and a fetch u=1, i",
	KINDS.every((t) => native[t] === (t === 'fetch' ? 'u=1, i' : 'u=4, i')),
	JSON.stringify(native),
);
for (const t of KINDS)
	ok(
		`the ${t === 'fetch' ? 'fetch' : `${t} worker's script`} says Priority ${native[t] ?? 'nothing'} through the proxy, as natively`,
		t in native && t in proxied && native[t] === proxied[t],
		`native ${native[t]} proxied ${proxied[t]}`,
	);
ok('no page errors', errors.length === 0, errors.join(' | '));

await new Promise((resolve) => h2.close(resolve));
await done(browser);
