// A popup the browser opens for a page (a host that takes no tabs, the
// default) and the window that opened it. One of another origin reads
// nothing of its opener but what the browser allows across origins: its
// about:blank was the opener's document, and the opener stayed readable to
// the site the popup then loaded (its globals, its location, its document).
// Every value is compared with the same pages loaded natively. Same-origin
// mode, with a controller that has no `onOpen` (the demo's own takes popups
// as tabs).
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const target = `${FIXTURE}pages/popup-opener.html`;

async function report(page) {
	let value = null;
	for (let i = 0; i < 80 && !value; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				?.evaluate(() => window.__result)
				.catch(() => null);
			if (found) value = found;
		}
	}
	return value;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the popup of another origin is refused its opener and the other one reads it',
	native?.cross?.marker === 'throws SecurityError' &&
		native?.cross?.openerOpener === true &&
		native?.same?.marker === 1 &&
		native?.same?.top === true &&
		native?.same?.hops === 1,
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
	// the demo's worker, and a transport described as the demo describes its
	// own (hosted in the transport worker)
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
const proxied = await report(page);
const pick = (value, keys) => JSON.stringify(keys.map((key) => value?.[key]));
const same = (who, keys) =>
	pick(proxied?.[who], keys) === pick(native?.[who], keys);
const shown = (who, keys) =>
	JSON.stringify({
		native: pick(native?.[who], keys),
		proxied: pick(proxied?.[who], keys),
	});
const reads = ['has', 'marker', 'href', 'document'];
ok(
	'a popup of another origin reads of its opener only what the browser allows, as natively',
	same('cross', reads),
	shown('cross', reads),
);
ok(
	"a popup of the opener's origin reads its globals, location and document, as natively",
	same('same', reads),
	shown('same', reads),
);
ok(
	'each popup is the source of its message, as natively',
	proxied?.crossSource === native?.crossSource &&
		proxied?.sameSource === native?.sameSource &&
		proxied?.opened === native?.opened,
	JSON.stringify({ native, proxied }),
);
await done(browser, errors);
