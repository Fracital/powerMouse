// A fetch's credentials mode reaches the jar the way the browser applies its
// own: `omit` sends no cookies and stores none from the response, `same-origin`
// sends them only when the real origins agree, `include` and the default send
// them. And the proxy's own origin is one more site (proxy-ception,
// docs/proxyception.md): a fetch of it answers what it answers natively, and
// a frame of it shows the proxied demo, never the host's own page.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const proxy = new URL(PROXY).origin;
const target = `${FIXTURE}pages/credentials.html?proxy=${encodeURIComponent(proxy)}`;
// the page's reads of the proxy origin, loaded natively
const native = await (async () => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(target);
	let value = {};
	for (let i = 0; i < 60 && !value.done; i++) {
		await sleep(250);
		value = (await page.evaluate(() => window.__cred)) || {};
	}
	await context.close();
	return value;
})();
const page = await openDemo(browser);
await submitLanding(page, target);
let cred = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		cred = (await frame.evaluate(() => window.__cred)) || {};
	} catch (error) {
		cred = {};
	}
	if (cred.done) break;
}
const has = (value, name) =>
	typeof value === 'string' && value.includes(`${name}=1`);
ok(
	'the default, same-origin and include modes send the jar cookies',
	has(cred.defaultMode, 'cred') &&
		has(cred.sameOrigin, 'cred') &&
		has(cred.include, 'cred'),
	JSON.stringify([cred.defaultMode, cred.sameOrigin, cred.include]),
);
ok(
	'credentials: omit sends no cookies',
	cred.omit === null || cred.omit === '',
	JSON.stringify(cred.omit),
);
ok(
	'a Set-Cookie answered to an omit request is not stored',
	has(cred.afterOmitSet, 'cred') && !has(cred.afterOmitSet, 'omitted'),
	JSON.stringify(cred.afterOmitSet),
);
ok(
	'a fetch of the proxy origin answers what it answers natively',
	native.done &&
		JSON.stringify(cred.self) === JSON.stringify(native.self) &&
		cred.selfFrame === native.selfFrame,
	JSON.stringify({
		proxied: [cred.self, cred.selfFrame],
		native: [native.self, native.selfFrame],
	}),
);
// the frame is the proxied demo (its route unrouted is the proxy origin's
// own page), a document the proxy injected, not the host's real page
const nested = page.frames().find((f) => f.url().includes('html:nested'));
const nestedRead = nested
	? await nested
			.evaluate(() => ({
				title: document.title,
				landing: !!document.getElementById('landing'),
			}))
			.catch((error) => String(error))
	: 'no frame';
const nestedReal = nested
	? await page.evaluate((u) => window.controller.unroute(u), nested.url())
	: null;
ok(
	'a frame navigated to the proxy origin shows the proxied demo, not the host page',
	nestedReal === `${proxy}/` &&
		nestedRead?.landing === true &&
		/powerMouse/i.test(nestedRead.title),
	JSON.stringify([nestedReal, nestedRead]),
);
ok(
	'the fixture ran to completion',
	cred.done === true && !cred.error,
	cred.error,
);
await done(browser, page.errors);
