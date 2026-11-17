// A rewritten body must not outlive the worker that made it: the browser's
// HTTP cache would otherwise keep a rewritten script for as long as the origin
// allowed (a year, here), with an old rewriter's output or old helper names
// in it. Rewritten responses go out `cache-control: no-cache`, so the browser
// asks the worker again and the worker answers from its own caches: a reload
// asks the worker without an upstream request. A rewritten script that a
// renderer's memory cache keeps goes out no-cache without validators as
// well: the worker keeps that cache per site (cache.ts MemoryCache), and the
// browser must neither hand it to another site's document nor revalidate
// another site's copy. An image the worker does not rewrite goes to the
// browser with the origin's caching, under a route that carries the mark of
// its document's site (src/memoryMark.ts): the renderer keeps it for the
// site's next document, as natively, and no other site's document names
// that URL (memory-cache-share).
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
		// the routed URL carries the controller's id before the kind, and the
		// kind its marks
		kind: /\/stomp\/[\w-]+\/([^/;]+)/.exec(url)?.[1] ?? '',
		mark: /\/stomp\/[\w-]+\/[^/;]+;m=([\w-]+)\//.exec(url)?.[1] ?? null,
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
	'a rewritten script served with a year of immutable freshness reaches the browser no-cache, without validators',
	first === `${FIXTURE}pages/cached.html` &&
		script?.fromWorker === true &&
		script?.cacheControl === 'no-cache' &&
		script?.etag === null,
	JSON.stringify([first, script]),
);
ok(
	'the rewritten document is no-cache too',
	html?.cacheControl === 'no-cache',
	JSON.stringify(html),
);
ok(
	`the image the worker did not rewrite goes out as the origin sent it (${UPSTREAM}), by a route of its site's mark`,
	image?.cacheControl === UPSTREAM &&
		typeof image?.mark === 'string' &&
		image.mark.length === 16 &&
		script?.mark === null,
	JSON.stringify([image, script]),
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
