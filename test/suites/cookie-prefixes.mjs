// Cookie name prefixes, as Chrome keeps them: __Secure- needs Secure,
// __Host- Secure, no Domain and Path=/, __Http- Secure and HttpOnly and is
// never set from script, __Host-Http- all of them, each in any case. The
// worker's jar keeps what Chrome keeps, from Set-Cookie and from
// document.cookie, and the server is sent the same cookies. Compared with
// the same page loaded natively. Same-origin mode.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const target = `${FIXTURE}pages/hdr-prefix.html`;

async function report(page) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				.evaluate(() => window.__result ?? null)
				.catch(() => null);
			if (found) return found;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
console.log('native', JSON.stringify(native));
ok(
	'natively, the prefixed cookies that meet their prefix are kept',
	native?.sent.includes('__Host-i=1') && !native?.sent.includes('__Secure-j'),
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
	document.body.append(element);
	await window.controller.createFrame(element).go(url);
}, target);
const proxied = await report(page);
console.log('proxied', JSON.stringify(proxied));
ok(
	'the server is sent the prefixed cookies Chrome keeps, as natively',
	proxied?.sent === native?.sent,
	JSON.stringify({ native: native?.sent, proxied: proxied?.sent }),
);
ok(
	'document.cookie reads the prefixed cookies Chrome keeps, as natively',
	proxied?.script === native?.script,
	JSON.stringify({ native: native?.script, proxied: proxied?.script }),
);
await done(browser, errors);
