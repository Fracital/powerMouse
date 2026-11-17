// X-Frame-Options, as Chrome applies it: a frame whose document sends DENY,
// SAMEORIGIN with an ancestor of another origin, or a conflicting list is
// refused, unless the document's enforced Content Security Policy has a
// frame-ancestors (which replaces it); ALLOWALL, ALLOW-FROM and nonsense
// let it in. The worker drops the header (it would refuse the proxy's own
// frame) and judges it against the frame's real ancestors instead, so a
// proxied site cannot frame another that relies on it, with that site's
// cookies (clickjacking across proxied sites). Every case is compared with
// the same page loaded natively. Same-origin mode.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const target = `${FIXTURE}pages/hdr-xfo.html`;

async function report(page) {
	for (let i = 0; i < 160; i++) {
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
	'natively, DENY, a cross-origin SAMEORIGIN and a conflict refuse the frame',
	native?.deny === 'refused' &&
		native?.['sameorigin-cross'] === 'refused' &&
		native?.conflict === 'refused' &&
		native?.sameorigin === 'loaded' &&
		native?.allowall === 'loaded' &&
		native?.['deny-with-frame-ancestors'] === 'loaded',
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
	await window.controller.createFrame(element).go(url);
}, target);
const proxied = await report(page);
console.log('proxied', JSON.stringify(proxied));
for (const key of Object.keys(native ?? {}))
	ok(
		`X-Frame-Options ${key}: the frame is ${native[key]}, as natively`,
		proxied?.[key] === native[key],
		`native ${native[key]}, proxied ${proxied?.[key]}`,
	);
await done(browser, errors);
