// The site pool (docs/site-pool.md) with two tabs of the host open: each
// tab has an agent of its own in a slot both show a site from, and the
// slot's one worker answers both. Natively a tab closing changes nothing
// for another tab of the same site: its frame's next page of that site
// loads. Through the demo (its own controller, on a pool of five even in a
// run without one: test/run.mjs), the second tab shows the site, closes, and the first tab's frame
// goes to another page of the site, which is to come and report its URL
// (frame.url) as it did before the second tab opened. The slot's worker
// asked the host's cookie jar over the newest tab's port only, so once the
// newer tab closed the older tab's documents of that slot waited for good
// on their first cookie read (the demo's bookmarks then saw no page in the
// tab, and a reload brought back the page before it).
import {
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
	SLOT_PORTS,
} from '../lib.mjs';

const A = `${FIXTURE}pages/bookmark-a.html`;
const B = `${FIXTURE}pages/bookmark-b.html`;
/** how long the frame's next page may take: far more than it does with one tab */
const COME_MS = 10000;

const browser = await launch();
const context = await browser.newContext();
const errors = [];

// --- natively: two tabs of the fixture, the second closes, the first's frame goes on ---
const nativeFirst = await context.newPage();
await nativeFirst.goto(A);
const nativeOther = await context.newPage();
await nativeOther.goto(A);
await nativeOther.close();
const nativeMs = await nativeFirst.evaluate(
	(url) =>
		new Promise((resolve) => {
			const start = performance.now();
			const frame = document.createElement('iframe');
			frame.onload = () => resolve(Math.round(performance.now() - start));
			frame.src = url;
			document.body.append(frame);
			setTimeout(() => resolve(null), 10000);
		}),
	B,
);
ok(
	'natively, a frame of the first tab loads the site after its other tab closed',
	typeof nativeMs === 'number',
	`${nativeMs} ms`,
);
await nativeFirst.close();

// --- proxied: the demo's page in two tabs ---
const pages = [];
/** a tab of the demo with its controller up */
async function tab() {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	pages.push(page);
	await page.goto(PROXY);
	await page.waitForFunction(
		() => window.controller && window.controller.isReady,
		null,
		{ timeout: 45000 },
	);
	return page;
}
/** a frame of the tab's controller sent to `url`: the URL it reports, the src it got, and how long it took */
const show = (page, url) =>
	page.evaluate(
		async ([url, ms]) => {
			window.shown ??= (() => {
				const element = document.createElement('iframe');
				element.style.cssText = 'width: 400px; height: 300px';
				document.body.append(element);
				return { element, frame: window.controller.createFrame(element) };
			})();
			const start = performance.now();
			await Promise.race([
				window.shown.frame.go(url),
				new Promise((resolve) => setTimeout(resolve, ms)),
			]);
			return {
				url: window.shown.frame.url,
				src: window.shown.element.src,
				ms: Math.round(performance.now() - start),
			};
		},
		[url, COME_MS],
	);
const inSlot = (src) =>
	SLOT_PORTS.some((port) => src.startsWith(`http://127.0.0.1:${port}/`));

const first = await tab();
const before = await show(first, A);
ok(
	'the first tab shows the site',
	before.url === A && inSlot(before.src),
	JSON.stringify(before),
);
const other = await tab();
const there = await show(other, A);
ok(
	'the second tab shows it too, from the same slot',
	there.url === A && new URL(there.src).origin === new URL(before.src).origin,
	JSON.stringify(there),
);
await other.close();
await sleep(500);
const after = await show(first, B);
ok(
	'with the second tab closed, the first tab frame next page of the site comes and reports its URL',
	after.url === B && after.ms < COME_MS,
	`proxied ${JSON.stringify(after)}, native ${nativeMs} ms`,
);
// and again, as the page goes on being used
const again = await show(first, A);
ok(
	'and the one after it',
	again.url === A && again.ms < COME_MS,
	JSON.stringify(again),
);

await done(browser, errors);
