// Document Picture-in-Picture (test/pages/document-pip.html), natively and
// through the proxy. Chrome opens the window only for a top-level document:
// a proxied page shown in the host's frame is refused as a frame is
// natively, and a proxied popup the browser opened (a host that takes no
// tabs) is a top-level document of the proxy origin, which gets the
// window. That window is an about:blank of the proxy origin: uninjected,
// its code would read the proxy origin's storage and cookies, every site's.
// It is the requesting page's, injected as a popup of its own is: its
// origin, storage, cookies, base URL and the links written into it are
// compared with the same page's natively.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const PAGE = `${FIXTURE}pages/document-pip.html`;
const KEYS = [
	'same',
	'href',
	'origin',
	'ownOrigin',
	'ownHref',
	'opener',
	'openerNull',
	'top',
	'parent',
	'storage',
	'ownStorage',
	'cookie',
	'ownCookie',
	'baseURI',
	'ownBase',
	'realm',
	'written',
];

/** click `#open` in `frame` (once it is there) and wait for its report */
async function report(frame) {
	for (let i = 0; i < 80; i++) {
		const ready = await frame
			.evaluate(() => window.__pipReady === true)
			.catch(() => false);
		if (ready) break;
		await sleep(250);
	}
	await sleep(500);
	await frame.click('#open').catch(() => {});
	for (let i = 0; i < 80; i++) {
		const value = await frame.evaluate(() => window.__pip).catch(() => null);
		if (value) return value;
		await sleep(250);
	}
	return null;
}

/** the popup page `page`'s context opens next */
const nextPopup = (context) =>
	new Promise((resolve) => context.once('page', resolve));

const browser = await launch();
const nativePage = await browser.newPage();
const nativePopupShown = nextPopup(nativePage.context());
await nativePage.goto(`${PAGE}?popup`);
const native = await report(nativePage.mainFrame());
const nativePopupPage = await nativePopupShown;
await nativePopupPage.waitForLoadState();
const nativePopup = await report(nativePopupPage.mainFrame());
await nativePage.close();
ok(
	'natively, a top-level page and its popup each get the window, a frame is refused',
	typeof native?.window === 'object' &&
		typeof nativePopup?.window === 'object' &&
		/^NotAllowedError/.test(native?.framed),
	JSON.stringify({ native, nativePopup }),
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
const proxiedPopupShown = nextPopup(page.context());
// a controller with no onOpen: the browser opens the page's popups
await page.evaluate(async (url) => {
	const element = document.createElement('iframe');
	// above the demo's own page, which would take the click
	element.style.cssText =
		'position: fixed; top: 0; left: 0; z-index: 2147483647; width: 800px; height: 600px';
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
}, `${PAGE}?popup`);
let framed = null;
for (let i = 0; i < 120 && !framed; i++) {
	await sleep(250);
	framed =
		page
			.frames()
			.find((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url())) ?? null;
}
const proxied = framed ? await report(framed) : null;
const popupPage = await Promise.race([proxiedPopupShown, sleep(20000)]);
let proxiedPopup = null;
if (popupPage) {
	popupPage.on('pageerror', (error) => errors.push(`popup: ${error.message}`));
	await popupPage.waitForLoadState();
	proxiedPopup = await report(popupPage.mainFrame());
}
ok(
	'the proxied page in its frame is refused the window, as a frame is natively',
	proxied?.window === native?.framed && proxied?.framed === native?.framed,
	JSON.stringify({ native: native?.framed, proxied }),
);
const pick = (value) =>
	JSON.stringify(
		typeof value?.window === 'object'
			? KEYS.map((key) => value.window[key])
			: value?.window,
	);
ok(
	"a proxied popup's window is its own origin's, with its storage, cookies and base URL, as natively",
	pick(proxiedPopup) === pick(nativePopup),
	JSON.stringify({ native: pick(nativePopup), proxied: pick(proxiedPopup) }),
);
await done(browser, errors);
