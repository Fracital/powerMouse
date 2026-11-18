// The worker's jar keeps each domain's cookies as it last read them until a
// write of that domain, not until any write: a popup of another host writes
// a cookie of its own before each of the page's requests, and the page's
// requests read the page's host from what was kept (an ad-heavy page sets
// the ad networks' cookies all the time, and every request read the jar's
// IndexedDB again). Counted in the browser's trace (IndexedDB index reads,
// the jar's only ones), in same-origin mode, where every document shares the
// one worker, with a controller that has no `onOpen` (the demo's own takes
// popups as tabs), as the popup-opener suite. What each request carries and
// what the documents read is compared with native Chrome, the page's own
// write included.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const target = `${FIXTURE}pages/jar-kept-domains.html`;
const TURNS = 20;

async function top(page, proxied) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames.reverse()) {
			const value = await frame.evaluate(() => window.__jk).catch(() => null);
			if (value?.ready) return frame;
		}
	}
	return null;
}

/** IndexedDB index reads anywhere in the browser while `run` runs */
async function indexReads(browser, run) {
	const cdp = await browser.newBrowserCDPSession();
	let reads = 0;
	cdp.on('Tracing.dataCollected', ({ value }) => {
		for (const event of value)
			if (event.name === 'IDBIndex::getAllRequestSetup') reads++;
	});
	const complete = new Promise((resolve) =>
		cdp.once('Tracing.tracingComplete', resolve),
	);
	await cdp.send('Tracing.start', {
		transferMode: 'ReportEvents',
		traceConfig: {
			includedCategories: ['IndexedDB'],
			excludedCategories: ['*'],
		},
	});
	let result;
	try {
		result = await run();
	} finally {
		await cdp.send('Tracing.end');
		await complete;
		await cdp.detach().catch(() => {});
	}
	return { result, reads };
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const nativeTop = await top(nativePage, false);
await nativeTop?.evaluate(() => window.__open());
const native = await nativeTop?.evaluate((n) => window.__run(n), TURNS);
await nativeTop?.evaluate(() => window.__close());
await nativePage.close();
ok(
	"natively, each request carries the page's cookies and the last one its new write",
	native?.first === 'jkown=0' &&
		native?.last === `jkown=${TURNS - 1}` &&
		native?.framed === `jkf0=16; jkf1=17; jkf2=18; jkf3=19`,
	JSON.stringify(native),
);

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (url) => {
	const element = document.createElement('iframe');
	element.style.cssText = 'width: 800px; height: 600px';
	document.body.append(element);
	const config = window.STOMP_CONFIG || {};
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: {
			module: config.testTransport
				? '/test/mixed-transport.mjs'
				: '/epoxy/index.mjs',
			options: [
				{
					wisp:
						config.wisp || `${location.origin.replace(/^http/, 'ws')}/wisp/`,
				},
			],
		},
		directory: window.controller.directory.pathname,
		codec: 'xor',
	});
	await controller.wait();
	await controller.createFrame(element).go(url);
}, target);
const frame = await top(page, true);
ok('the page loaded and its popup opened', !!frame);
if (frame) {
	await frame.evaluate(() => window.__open());
	const { result: proxied, reads } = await indexReads(browser, () =>
		frame.evaluate((n) => window.__run(n), TURNS),
	);
	ok(
		'each request carries what it does natively, and each document reads what it does natively',
		JSON.stringify(proxied) === JSON.stringify(native),
		JSON.stringify({ native, proxied }),
	);
	// before, every turn's request read the page's host again (a read a
	// turn); now the first requests and the one after the page's own write
	ok(
		"a write of the other host's cookies leaves what the jar kept of the page's",
		reads < TURNS / 2,
		JSON.stringify({ reads, turns: TURNS }),
	);
	await frame.evaluate(() => window.__close()).catch(() => {});
}
await page.close();
await done(browser, errors);
