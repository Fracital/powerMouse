// A page's localStorage writes while no other realm holds a copy of the
// store go to the worker without waiting for it (each a beacon with the
// operation in its URL, which Chrome sends even when the page unloads in the
// same task), and keep what native Chrome keeps: in one task, the page and
// an about:blank frame it made (one realm) write the same keys in turn and
// read them back; a frame added after the writes reads them as its first
// script runs; first of all, an <object>'s document (whose bundle runs at
// a blob: URL) writes and reads back, and the page reads that once the
// object is gone; a popup writes in the task that closes it, and a frame added
// then reads that; the page writes in the task that navigates away, a value
// over the bridge's budget among them, and the next page reads them. Every
// read is compared with the same pages loaded natively, and the page's
// writes make no synchronous request of the bridge. Same-origin mode, with a
// controller that has no `onOpen` (the demo's own takes popups as tabs), as
// the popup-opener suite.
import {
	bridgeRequests,
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
} from '../lib.mjs';

const prefix = `sw${Date.now().toString(36)}`;
const target = `${FIXTURE}pages/storage-writes.html?p=${prefix}`;

async function find(page, name) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames().reverse()) {
			const value = await frame
				.evaluate((name) => window[name] ?? null, name)
				.catch(() => null);
			if (value) return { frame, value };
		}
	}
	return { frame: null, value: null };
}

// what a run calls after a step
const marks = {};

async function run(page) {
	const { frame } = await find(page, '__sw');
	if (!frame) return null;
	const result = {};
	// first, while no document but the object's holds the store
	result.object = await frame.evaluate(() => window.__object());
	marks.object?.();
	result.order = await frame.evaluate(() => window.__order());
	result.frame = await frame.evaluate(() => window.__frame());
	await frame.evaluate(() => window.__close());
	result.closed = await frame.evaluate(() => window.__frame());
	await frame.evaluate(() => window.__leave());
	result.next = (await find(page, '__report')).value;
	return result;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await run(nativePage);
await nativePage.close();
ok(
	'natively, every write is read back, by a later frame and by the next page',
	native?.next?.[`${prefix}large`] === '49152 chars' &&
		native?.next?.[`${prefix}closed`] === 'before closing' &&
		JSON.stringify(native?.order?.mine) ===
			JSON.stringify(native?.order?.theirs),
	JSON.stringify(native),
);

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// the synchronous bridge's requests (05: sealed in the beacon's URL, or in
// its body)
const sent = [];
page.on('request', (request) => {
	if (/\/xhr$/.test(new URL(request.url()).pathname)) sent.push(request);
});
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
	window.__swController = controller;
	await controller.wait();
	await controller.createFrame(element).go(url);
}, target);
// (an <object>'s document, the first step, waits for the bridge: see
// orderedURL in src/inject/dom/modules/Storage.ts)
let afterObject = 0;
marks.object = () => (afterObject = sent.length);
const proxied = await run(page).catch((error) => String(error));
const carried = (
	await bridgeRequests(
		page,
		sent.slice(afterObject),
		await page.evaluate(() => window.__swController.config.names.client),
	)
).filter(Boolean);
// those of a write
const syncWrites = carried.filter((request) =>
	/Storage\/(setItem|removeItem)$/.test(request.data?.url ?? ''),
).length;
ok(
	'the page loaded and ran every step',
	proxied !== null && typeof proxied === 'object',
	String(proxied),
);
const same = (key) =>
	JSON.stringify(proxied?.[key]) === JSON.stringify(native?.[key]);
const shown = (key) =>
	JSON.stringify({ native: native?.[key], proxied: proxied?.[key] });
ok(
	'the page and its about:blank frame read their writes in the order made, as natively',
	same('order'),
	shown('order'),
);
ok(
	'a frame added after the writes reads them, as natively',
	same('frame'),
	shown('frame'),
);
ok(
	"an <object>'s document writes and reads back, and the page reads that, as natively",
	same('object'),
	shown('object'),
);
ok(
	'a popup that writes as it closes leaves its writes, as natively',
	same('closed'),
	shown('closed'),
);
ok(
	'writes made as the page navigates away are on the next page, as natively',
	same('next'),
	shown('next'),
);
ok(
	'no write of the page waits for the bridge while no other realm holds the store',
	// (the page's first reads ask the bridge: its requests were read)
	carried.length > 0 && syncWrites === 0,
	JSON.stringify({ syncWrites, requests: carried.length }),
);
await page.close();
await done(browser, errors);
