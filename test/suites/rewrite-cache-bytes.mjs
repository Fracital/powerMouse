// A script kept in the rewrite cache goes out as the store's bytes: its key
// is a digest of the body as it came (not of its decoded text), and a hit is
// never decoded or encoded again in the worker (YouTube's bundle, 10 MB in
// and 20 MB out, was read, decoded and encoded on every load, and the
// length of every rewritten body was counted in JS: 0.4 s of the worker's
// time per load). A UTF-8 script with a byte order mark and characters of
// two, three and four bytes runs the same, and goes out byte for byte the
// same with a matching Content-Length, rewritten and from the cache.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
const PAGE = `${FIXTURE}pages/utf8-script.html`;
const SCRIPT = `${FIXTURE}pages/utf8-script.js.bin`;
const responses = [];
page.context().on('response', async (response) => {
	if (!/\/stomp\/[\w-]+\/js:generic\//.test(response.url())) return;
	const body = await response.body().catch(() => null);
	responses.push({
		body: body ? body.toString('hex') : null,
		bytes: body?.length ?? null,
		length: Number(response.headers()['content-length'] ?? NaN),
	});
});
await page.evaluate(() => {
	window.__log = [];
	window.controller.addEventListener('request', (event) => {
		if (event.detail.destination === 'script') window.__log.push(event.detail);
	});
});

const value = async () => {
	for (let i = 0; i < 80; i++) {
		await sleep(100);
		const found = await page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			?.evaluate(() => window.__utf8 ?? null)
			.catch(() => null);
		if (found) return found;
	}
	return null;
};
const outcomes = () =>
	page.evaluate(
		(script) => window.__log.splice(0).filter((entry) => entry.url === script),
		SCRIPT,
	);

await submitLanding(page, PAGE);
const first = await value();
await sleep(300);
const firstLog = await outcomes();
const firstResponses = responses.splice(0);
await submitOmni(page, PAGE);
await sleep(500);
const second = await value();
await sleep(300);
const secondLog = await outcomes();
const secondResponses = responses.splice(0);

const expected = JSON.stringify(['café ✓ 😀', 'object']);
const detail = JSON.stringify({
	first,
	second,
	firstLog: firstLog.map((e) => e.rewriteCache),
	secondLog: secondLog.map((e) => e.rewriteCache),
	firstResponses: firstResponses.map((r) => [r.bytes, r.length]),
	secondResponses: secondResponses.map((r) => [r.bytes, r.length]),
});
ok(
	'the script runs with its text intact, rewritten and from the rewrite cache',
	JSON.stringify(first) === expected && JSON.stringify(second) === expected,
	detail,
);
ok(
	'the second load is a rewrite cache hit',
	firstLog[0]?.rewriteCache === 'miss' && secondLog[0]?.rewriteCache === 'hit',
	detail,
);
ok(
	'the cached output is byte for byte the rewritten one, its Content-Length its own',
	firstResponses.length > 0 &&
		secondResponses.length > 0 &&
		[...firstResponses, ...secondResponses].every(
			(r) => r.body === firstResponses[0].body && r.length === r.bytes,
		),
	detail,
);

await done(browser, page.errors);
