// A popup the page opens on its own host reads document.cookie, and a
// response then sets the cookie again: a second popup of the same URL reads
// the new value, as natively. STomp keeps one view of the jar per document
// URL for every document its bundle runs (a page, its about:blank frames,
// the popups the browser opens for it), and the first popup's view outlived
// its window: the page that heard of the change dropped only its own view,
// so the second popup read the first one's copy (wpt-cookies-more,
// cookies/samesite/window-open.https.html, its redirecting cases). And a
// popup's fetch sets the cookie and tells the page, which reads it at once
// (cookies/samesite/fetch.https.html's puppet). Same-origin
// mode, with a controller that has no `onOpen` (the demo's own takes popups
// as tabs), as the popup-opener suite.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const target = `${FIXTURE}pages/popup-cookie-reads.html`;

async function top(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames().reverse()) {
			const value = await frame.evaluate(() => window.__pcr).catch(() => null);
			if (value?.ready) return frame;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const nativeTop = await top(nativePage);
const native = await nativeTop?.evaluate(() => window.__run());
const nativeFetch = await nativeTop?.evaluate(() => window.__runFetch());
await nativePage.close();
ok(
	'natively, the second popup reads the cookie the response set again',
	native?.first === 'hcseen=1' && native?.second === 'hcseen=2',
	JSON.stringify(native),
);
const counted = Array.from({ length: 12 }, (_, i) => `hcseen=${i + 1}`);
ok(
	"natively, the page reads each cookie its popup's fetch set on the popup's message",
	JSON.stringify(nativeFetch) === JSON.stringify(counted),
	JSON.stringify(nativeFetch),
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
const frame = await top(page);
ok('the page loaded', !!frame);
const proxied = await frame?.evaluate(() => window.__run()).catch(String);
ok(
	'each popup reads the cookie as natively',
	JSON.stringify(proxied) === JSON.stringify(native),
	JSON.stringify({ native, proxied }),
);
// the worker tells the page of the change by a message of its own, which
// the popup's could overtake: the page read without the cookie about once
// in two hundred reads under load (JAR_MARKER)
const proxiedFetch = await frame
	?.evaluate(() => window.__runFetch())
	.catch(String);
ok(
	"the page reads each cookie its popup's fetch set on the popup's message, as natively",
	JSON.stringify(proxiedFetch) === JSON.stringify(nativeFetch),
	JSON.stringify({ nativeFetch, proxiedFetch }),
);
await done(browser, errors);
