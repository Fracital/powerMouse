// A rewritten body must not outlive the worker that made it: the browser's
// HTTP cache would otherwise keep a rewritten script for as long as the origin
// allowed (a year, here), with an old rewriter's output or old helper names
// in it. Rewritten responses go out `cache-control: no-cache` with the
// origin's validators kept, so the browser asks the worker again and the
// worker answers from its own cache of the upstream bytes: a reload revalidates
// without an upstream request. A body the worker did not rewrite (the image)
// keeps the origin's headers.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const UPSTREAM = 'public, max-age=31536000, immutable';
const browser = await launch();
const page = await openDemo(browser);
const responses = [];
page.on('response', (response) => {
	const url = response.url();
	if (!url.includes('/stomp/')) return;
	responses.push({
		// the routed URL carries the controller's id before the kind
		kind: /\/stomp\/[\w-]+\/([^/]+)\//.exec(url)?.[1] ?? '',
		status: response.status(),
		cacheControl: response.headers()['cache-control'] ?? null,
		etag: response.headers()['etag'] ?? null,
		fromWorker: response.fromServiceWorker(),
	});
});
const frameOf = () =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
const loaded = async () => {
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		const value = await frameOf()
			?.evaluate(() => window.__cached)
			.catch(() => null);
		if (value) return value;
	}
	return null;
};
const upstreamHits = async () =>
	(await (await fetch(`${FIXTURE}requests`)).json()).filter(
		(path) => path === '/pages/cached.js',
	).length;

await submitLanding(page, `${FIXTURE}pages/cached.html`);
const first = await loaded();
const firstResponses = responses.splice(0);
const script = firstResponses.find((r) => r.kind === 'js:generic');
const html = firstResponses.find((r) => r.kind === 'html');
const image = firstResponses.find((r) => r.kind === 'binary');
ok(
	'a rewritten script served with a year of immutable freshness reaches the browser no-cache, validators kept',
	first === `${FIXTURE}pages/cached.html` &&
		script?.fromWorker === true &&
		script?.cacheControl === 'no-cache' &&
		script?.etag === '"cached-1"',
	JSON.stringify([first, script]),
);
ok(
	'the rewritten document is no-cache too; the image the worker did not rewrite keeps the origin headers',
	html?.cacheControl === 'no-cache' &&
		image?.cacheControl === UPSTREAM &&
		image?.etag === '"cached-svg-1"',
	JSON.stringify([html, image]),
);
const hitsBefore = await upstreamHits();
await page.evaluate(() => window.controller.frames[0].reload());
await sleep(500);
const second = await loaded();
const secondResponses = responses.splice(0);
const again = secondResponses.find((r) => r.kind === 'js:generic');
const hitsAfter = await upstreamHits();
ok(
	'a reload revalidates the script against the worker, which answers from its own cache without an upstream request',
	second === `${FIXTURE}pages/cached.html` &&
		again?.fromWorker === true &&
		[200, 304].includes(again?.status) &&
		again?.cacheControl === 'no-cache' &&
		hitsBefore === 1 &&
		hitsAfter === 1,
	JSON.stringify({ second, again, hitsBefore, hitsAfter }),
);
await done(browser, page.errors);
