// What a page's policy's report-to endpoints receive, natively and through
// the proxy in both modes: the Reporting API's uploads (src/server/
// reportUploads.ts, src/inject/dom/violationDelivery.ts). An https page
// (the Reporting API sends nothing for an http one) of mixed.test, served
// in TLS natively and in plain http to the demo's test transport
// (test/mixed-servers.mjs), under two policies: one whose report-to names
// an endpoint of the page's origin, one an endpoint of another origin
// (rep.h3.mixed.test), which answers the CORS preflight. The page makes
// violations at once and a moment later, the same one twice from one
// place, and so does a frame of it, which it removes soon after. Chrome
// 157 uploads the first report at once, the frame's at once when the frame
// is gone, and the rest together about a minute after the first, each
// document's for one endpoint in one POST of application/reports+json, the
// other origin's after a preflight and without cookies, the page's own
// with them. Compared: each upload's endpoint, method, the header
// names (the transport's own aside), its Content-Type, Origin, Referer and
// cookies, when it came (at once or about a minute later), and its reports
// (their bodies, and their age, by the same two classes).
import { createServer as createHTTP } from 'node:http';
import { createServer as createHTTPS } from 'node:https';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { certificate, tlsOrPlain } from '../mixed-servers.mjs';

/** how long the suite waits for the uploads after the first (Chrome's about a minute, and room) */
const BATCH_WAIT_MS = 75_000;

/** each key's requests of /r, with when they came after the key's page */
const uploads = new Map();
const served = new Map();

const handler = (req, res) => {
	const url = new URL(req.url, 'http://mixed.test/');
	const key = url.searchParams.get('k') ?? '';
	if (url.pathname === '/doc' || url.pathname === '/frame') {
		if (url.pathname === '/doc') served.set(key, Date.now());
		const other = `https://rep.h3.mixed.test:${port}`;
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('set-cookie', 'reports=1; Path=/; Secure; SameSite=None');
		res.appendHeader(
			'content-security-policy',
			"script-src 'self' 'unsafe-inline'; report-to same",
		);
		res.appendHeader(
			'content-security-policy',
			"img-src 'self'; report-to other",
		);
		res.setHeader(
			'reporting-endpoints',
			`same="/r?e=same&k=${key}", other="${other}/r?e=other&k=${key}"`,
		);
		if (url.pathname === '/frame') {
			res.end(`<!doctype html><title>frame</title><script>
try { eval('3 + 3'); } catch (e) {}
new Image().src = '${other}/img.png?n=3';
</script>`);
			return;
		}
		res.end(`<!doctype html><title>reports</title><script>
const image = (n) => { new Image().src = '${other}/img.png?n=' + n; };
for (let i = 0; i < 2; i++) try { eval('1 + 1'); } catch (e) {}
image(1);
setTimeout(() => {
	const frame = document.createElement('iframe');
	frame.src = '/frame?k=${key}';
	document.body.append(frame);
	setTimeout(() => frame.remove(), 1500);
}, 100);
setTimeout(() => {
	try { eval('2 + 2'); } catch (e) {}
	image(2);
}, 300);
</script>`);
		return;
	}
	if (url.pathname === '/r') {
		res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
		res.setHeader('access-control-allow-methods', 'POST');
		res.setHeader('access-control-allow-headers', 'content-type');
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const h = req.headers;
			if (!uploads.has(key)) uploads.set(key, []);
			uploads.get(key).push({
				endpoint: url.searchParams.get('e'),
				method: req.method,
				at: Date.now() - (served.get(key) ?? Date.now()),
				// (the transport's own: how the connection and body are framed)
				names: Object.keys(h)
					.filter(
						(name) =>
							![
								'host',
								'connection',
								'content-length',
								'accept-encoding',
							].includes(name),
					)
					.sort()
					.join(','),
				type: h['content-type'] ?? null,
				origin: h.origin ?? null,
				referer: h.referer ?? null,
				cookie: h.cookie ?? null,
				body: Buffer.concat(chunks).toString(),
			});
			res.statusCode = 204;
			res.end();
		});
		return;
	}
	res.statusCode = 404;
	res.end();
};
const tls = createHTTPS(certificate(), handler);
const plain = createHTTP(handler);
const both = tlsOrPlain(tls, plain);
const port = await new Promise((resolve) =>
	both.listen(0, '127.0.0.1', () => resolve(both.address().port)),
);
const pageURL = (key) => `https://mixed.test:${port}/doc?k=${key}`;

/** a time as compared: at once, or about a minute later */
const when = (ms) =>
	ms < 8000
		? 'at once'
		: ms > 50_000 && ms < 72_000
			? 'a minute later'
			: `${ms} ms`;

/** what of `key`'s uploads is compared, sorted */
function uploadsOf(key) {
	return (uploads.get(key) ?? [])
		.map(({ at, body, ...upload }) => {
			let reports = body;
			try {
				reports = JSON.parse(body)
					.map(({ age, body, ...report }) =>
						JSON.stringify({
							...report,
							age: when(age),
							body: {
								...body,
								// (the page's URL, whose key differs)
								documentURL: body.documentURL?.replace(/k=[\w-]+/, 'k=K'),
								...(body.referrer && {
									referrer: body.referrer.replace(/k=[\w-]+/, 'k=K'),
								}),
							},
							url: report.url?.replace(/k=[\w-]+/, 'k=K'),
						}),
					)
					.sort();
			} catch (error) {
				// a preflight's empty body, or no JSON
			}
			return JSON.stringify({ ...upload, when: when(at), reports });
		})
		.sort();
}

const nativeBrowser = await launch([
	'--ignore-certificate-errors',
	'--host-resolver-rules=MAP mixed.test 127.0.0.1, MAP *.mixed.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
]);
const browser = await launch();

// natively, and through the demo in both modes, at the same time: each
// waits a minute for its later uploads
const runs = {
	native: (async () => {
		const page = await nativeBrowser.newPage();
		await page.goto(pageURL('native'));
		await sleep(BATCH_WAIT_MS);
		await page.close();
	})(),
	...Object.fromEntries(
		[
			['same-origin', PROXY],
			['isolated', HOST],
		].map(([mode, base]) => [
			mode,
			(async () => {
				const page = await openDemo(browser, base);
				await submitLanding(page, pageURL(mode));
				await sleep(BATCH_WAIT_MS);
				await page.close();
			})(),
		]),
	),
};
await Promise.all(Object.values(runs));

const native = uploadsOf('native');
ok(
	"natively, the first report and the gone frame's are uploaded at once and the rest a minute later, the other origin after a preflight",
	native.some((upload) => upload.includes('"when":"at once"')) &&
		native.some((upload) => upload.includes('"when":"a minute later"')) &&
		native.some(
			(upload) =>
				upload.includes('/frame?k=K') && upload.includes('"when":"at once"'),
		) &&
		native.some((upload) => upload.includes('"method":"OPTIONS"')),
	native.join('\n'),
);
for (const mode of ['same-origin', 'isolated']) {
	const proxied = uploadsOf(mode);
	ok(
		`${mode}: the report-to endpoints receive what they do natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		[
			'missing:',
			...native.filter((upload) => !proxied.includes(upload)),
			'extra:',
			...proxied.filter((upload) => !native.includes(upload)),
		].join('\n'),
	);
}

await nativeBrowser.close();
both.close();
await done(browser);
