// A frame's csp and credentialless attributes, as Chrome applies them. csp
// (CSP Embedded Enforcement): the request says the policy (Sec-Required-CSP),
// and the document is refused unless it accepts it (Allow-CSP-From naming
// its parent's origin or *, which applies the policy to it, or a policy of
// its own at least as strict); the attribute reads back through the
// property. credentialless: the frame's requests carry no cookies, and its
// document reads none of its site's cookies or storage. Compared with the
// same page loaded natively. Same-origin mode.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

// (a credentialless frame's partition, through every store, is measured by
// the credentialless suite)
const KNOWN_OPEN = new Set();

const target = `${FIXTURE}pages/hdr-frame-attrs.html`;

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
ok('natively, the page reports', native !== null, JSON.stringify(native));

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
	if (KNOWN_OPEN.has(key))
		console.log(
			`OPEN ${key}: ${JSON.stringify({ native: native[key], proxied: proxied?.[key] })}`,
		);
	else
		ok(
			`${key}: as natively`,
			JSON.stringify(proxied?.[key]) === JSON.stringify(native[key]),
			JSON.stringify({ native: native[key], proxied: proxied?.[key] }),
		);
await done(browser, errors);
