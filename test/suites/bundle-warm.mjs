// The controller fetches the document bundle (injectDocument.js) once it is
// up, by the URL a proxied document's shell loads it with, so the first
// document finds it in the HTTP cache: that document downloaded all 510 KB of
// it, its parser waiting between its first byte and its first script (200 ms
// of a cold first paint on a 20 Mbit/s link). The demo serves the bundle
// no-cache, so the document still asks whether it changed: a 304, a few
// hundred bytes. The page is the cold-start fixture, compared with its
// native load.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/cold-start.html`;
const BUNDLE = /\/injectDocument(Full)?\.js(\?|$)/;
const read = (frame) =>
	frame.evaluate(() => ({
		title: document.title,
		ready: window.__cold?.ready,
	}));

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
await nativePage.waitForFunction(() => window.__cold?.ready === true);
const native = await read(nativePage.mainFrame());
await nativeBrowser.close();

const browser = await launch();
const page = await openDemo(browser, PROXY);
const cdp = await page.context().newCDPSession(page);
const responses = new Map();
cdp.on('Network.responseReceived', ({ requestId, response }) => {
	if (BUNDLE.test(response.url))
		responses.set(requestId, {
			url: response.url,
			status: response.status,
			cached: response.fromDiskCache || response.fromMemoryCache,
		});
});
cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
	const entry = responses.get(requestId);
	if (entry) entry.bytes = encodedDataLength;
});
await cdp.send('Network.enable');
// the demo's own fetch of the bundle, done (none before this change)
const warmed = await page
	.waitForFunction(
		(source) =>
			performance
				.getEntriesByType('resource')
				.some((entry) => new RegExp(source).test(entry.name)),
		BUNDLE.source,
		{ timeout: 15000 },
	)
	.then(
		() => true,
		() => false,
	);
const before = new Set(responses.keys());
await submitOmni(page, target);
const top = await waitActive(page, `window.__cold?.ready === true`);
const proxied = await read(top);
await sleep(200);
const first = [...responses]
	.filter(([id]) => !before.has(id))
	.map(([, r]) => r);
ok(
	'the demo fetched the document bundle before any document asked for it',
	warmed,
);
ok(
	'the first proxied document had its bundle from the HTTP cache: a revalidation, not the whole file',
	first.length >= 1 &&
		// a revalidated response reports the cached status, with the 304's bytes
		first.every((r) => (r.bytes ?? Infinity) < 4096),
	JSON.stringify(first),
);
ok(
	'the proxied page loads as natively',
	JSON.stringify(proxied) === JSON.stringify(native),
	`${JSON.stringify(proxied)}, natively ${JSON.stringify(native)}`,
);
ok(
	'nothing threw loading the page',
	page.errors.length === 0,
	JSON.stringify(page.errors),
);
await done(browser);
