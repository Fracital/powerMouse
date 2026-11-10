// Markup the inject parses or copies only to rewrite or serialize it (the
// shell's parse of the whole page, the copy it serializes, every innerHTML,
// outerHTML, insertAdjacentHTML, getHTML, XMLSerializer and document.write)
// must not outlive its use, and must not load anything. A <source media>
// listens to its media query in any document of the window, a DOMParser's
// or an inert one's, and Blink keeps a listened MediaQueryList alive as a
// pending activity; an <img> can listen to its document's viewport. Either
// kept such a copy for the page's life with its whole tree (Wikipedia kept
// three copies of its page, Notion its whole markup, and each write or read
// of markup with a <picture> kept one more), and the shell's copy, made in
// the page's own document, fetched every video and audio a second time.
// Measured as the DOM nodes left after a GC and the media requests the
// fixture saw, against the same page loaded natively, in same-origin mode,
// where the proxied frame shares the page's renderer and its node count.
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

const small = `${FIXTURE}landed?markup-copies`;
const target = `${FIXTURE}pages/markup-copies.html`;
const ROUTE = /\/stomp\/[\w-]+\/html\//;

/** the DOM nodes of the page's renderer once a full GC has run */
async function nodesAfterGC(cdp) {
	for (let i = 0; i < 2; i++) {
		await cdp.send('HeapProfiler.collectGarbage');
		await sleep(100);
	}
	const { metrics } = await cdp.send('Performance.getMetrics');
	return metrics.find((metric) => metric.name === 'Nodes').value;
}

/** how often the fixture served the page's media file so far */
const mediaHits = async () =>
	(await (await fetch(`${FIXTURE}hits`)).json())['media-session.wav']
		?.requests ?? 0;

async function until(get, pred, timeout = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await get().catch(() => null);
		if (pred(value)) return value;
		await sleep(250);
	}
	return null;
}

/**
 * The nodes the big page keeps over the small one, the media it fetched, and
 * what each case leaves behind, in the page `page` with `frame()` its
 * document
 */
async function measure(page, frame, navigate) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	await cdp.send('HeapProfiler.enable');
	await until(
		() => frame().evaluate(() => document.title),
		(title) => title === 'LANDED',
	);
	await sleep(500);
	const before = await nodesAfterGC(cdp);
	const hits = await mediaHits();
	await navigate(target);
	const ready = await until(
		() => frame().evaluate(() => window.__ready === true && !!window.__run),
		(value) => value === true,
	);
	await sleep(2000);
	const media = (await mediaHits()) - hits;
	const loaded = await nodesAfterGC(cdp);
	const cases = {};
	if (ready) {
		const names = await frame().evaluate(() => window.__cases);
		let last = loaded;
		for (const name of names) {
			await frame().evaluate((n) => window.__run(n), name);
			await sleep(300);
			const now = await nodesAfterGC(cdp);
			cases[name] = now - last;
			last = now;
		}
	}
	await cdp.detach();
	return { ready, media, page: loaded - before, cases };
}

const browser = await launch(['--autoplay-policy=no-user-gesture-required']);

const nativePage = await browser.newPage();
await nativePage.goto(small);
const native = await measure(
	nativePage,
	() => nativePage.mainFrame(),
	(url) => nativePage.goto(url),
);
await nativePage.close();
ok('natively, the fixture runs', native.ready, JSON.stringify(native));

const page = await openDemo(browser, PROXY);
await submitLanding(page, small);
let current = null;
const frame = () => {
	const found = page.frames().findLast((f) => ROUTE.test(f.url()));
	if (found) current = found;
	return current ?? page.mainFrame();
};
await until(
	async () => frame() !== page.mainFrame(),
	(value) => value === true,
);
const proxied = await measure(page, frame, (url) => submitOmni(page, url));
ok('proxied, the fixture runs', proxied.ready, JSON.stringify(proxied));

ok(
	'the page fetches its media as often as natively',
	native.media > 0 && proxied.media === native.media,
	`proxied ${proxied.media} native ${native.media}`,
);
// a kept copy of the page is about 3,300 nodes (it kept two); the proxy's
// own nodes (the host's UI, a frame's overhead) are far under that
ok(
	'the page keeps no copy of its markup',
	proxied.page - native.page < 1500,
	`proxied ${proxied.page} native ${native.page}`,
);
// a case's markup is about 810 nodes and a case writes or reads it ROUNDS
// (20) times: a case that keeps its copies keeps 16,000 or more. Something
// holding on to the last one (a written frame's document is kept until the
// next) is bounded, so the check allows a few
const COPY = 810;
for (const name of Object.keys(native.cases))
	ok(
		`${name} leaves no copies behind`,
		proxied.cases[name] !== undefined &&
			proxied.cases[name] - native.cases[name] < 3 * COPY,
		`proxied ${proxied.cases[name]} native ${native.cases[name]}`,
	);

await done(browser);
