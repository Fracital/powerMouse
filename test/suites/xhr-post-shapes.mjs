// A cross-origin POST reaches the origin through the proxy exactly as the
// browser sent it: the same method, content-type, custom header and body
// bytes. The shapes are the ones a Cloudflare Turnstile challenge submits and
// the ones most likely to trip a proxy (empty body, url-encoded form,
// text/plain, application/json, application/octet-stream, a non-ASCII binary
// body, a credentialed JSON POST with a custom header that forces a preflight,
// and a ReadableStream (duplex) body). The page is on 127.0.0.1 and posts to
// localhost (a cross-origin host, the same fixture), loaded natively and then
// through the proxy in both modes; what reached /echo-post is compared
// byte-for-byte. This settles whether the proxy forwards a Turnstile-shaped
// POST faithfully (so a 400 from such a submission is the origin's), or alters
// it.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
// the page's own origin is A (127.0.0.1); it posts cross-origin to B (the
// same fixture under localhost, a distinct origin to Chrome)
const A = new URL(FIXTURE).origin + '/';
const B = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin + '/';
const SHAPES = [
	'empty',
	'form',
	'text',
	'json',
	'octet',
	'binary',
	'credentialed',
	'stream',
];
// the fields that decide whether the origin sees the browser's own request
const FIELDS = ['method', 'contentType', 'bodyHex', 'custom', 'origin'];

const log = (k) => fetch(`${A}echo-post/log?k=${k}`).then((r) => r.json());

async function measure(run, open, k) {
	const getFrame = await open(
		`${A}pages/xhr-post-shapes.html?to=${encodeURIComponent(B)}&k=${k}`,
	);
	let shapes = null;
	for (let i = 0; i < 80; i++) {
		shapes = await getFrame()
			?.evaluate(() => window.__shapes ?? null)
			.catch(() => null);
		if (shapes && shapes.length >= SHAPES.length) break;
		await sleep(250);
	}
	return { shapes, recorded: await log(k) };
}

const nativePage = await browser.newPage();
const native = await measure(
	'native',
	async (url) => {
		await nativePage.goto(url);
		return () => nativePage.mainFrame();
	},
	'native',
);
await nativePage.close();
// every fixed-body shape is sent natively; the duplex ReadableStream is not,
// because Chrome refuses request streaming over HTTP/1.1 (it needs HTTP/2), so
// natively it throws and nothing reaches the origin. The proxy buffers such a
// body to a Blob and sends it, which is the point of the stream check below.
const FIXED = SHAPES.filter((s) => s !== 'stream');
ok(
	'natively: every fixed-body shape was sent and recorded',
	!!native.recorded && FIXED.every((s) => native.recorded[s]),
	JSON.stringify({
		shapes: native.shapes,
		got: Object.keys(native.recorded ?? {}),
	}),
);
ok(
	'natively: a duplex ReadableStream POST is refused over HTTP/1.1 (not sent)',
	!native.recorded?.stream,
	JSON.stringify(native.shapes),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const key = `prox-${mode}`;
	const page = await openDemo(browser, base);
	const proxied = await measure(
		key,
		async (url) => {
			await submitLanding(page, url);
			return () => frameOf(page);
		},
		key,
	);
	for (const shape of FIXED) {
		const n = native.recorded?.[shape];
		const p = proxied.recorded?.[shape];
		const diffs = p
			? FIELDS.filter((f) => (n?.[f] ?? null) !== (p?.[f] ?? null)).map(
					(f) =>
						`${f}: native ${JSON.stringify(n?.[f] ?? null)} proxied ${JSON.stringify(p?.[f] ?? null)}`,
				)
			: ['did not arrive'];
		ok(
			`${mode}: a ${shape} POST reaches the origin as the browser sent it`,
			!!p && diffs.length === 0,
			diffs.join('; ') +
				(p
					? ` | len native=${n?.contentLength} proxied=${p?.contentLength} te=${p?.transferEncoding}`
					: ''),
		);
	}
	// the duplex stream native could not send: the proxy buffers it and
	// delivers the exact bytes it enqueued ("str" + fe ff 00), with a
	// Content-Length, as a POST of its content type
	const s = proxied.recorded?.stream;
	ok(
		`${mode}: a duplex ReadableStream POST is buffered and delivered byte-intact`,
		!!s &&
			s.method === 'POST' &&
			s.bodyHex === '737472feff00' &&
			s.contentType === 'application/octet-stream' &&
			s.contentLength === '6',
		JSON.stringify(s),
	);
	await page.close();
}

await done(browser);
