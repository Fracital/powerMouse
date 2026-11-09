// Inserting a node runs none of the page's own getters on it or on its new
// parent. The insertion hooks read a parent's isConnected and a node's
// nodeType as properties, under a native prototype swapped in: a getter
// the page put on the instance itself still ran, with its prototype chain
// gone, so YouTube's Polymer logging getter threw "Cannot read properties
// of undefined (reading 'toLowerCase')" from appendChild. Compared with the
// page loaded natively, where the browser reads its own state. Both modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const PAGE = `${FIXTURE}pages/own-getters.html`;

async function measure(frames) {
	for (let i = 0; i < 60; i++) {
		for (const frame of frames()) {
			const value = await frame.evaluate(() => window.__own).catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	'natively: no own getter runs and nothing throws',
	native?.calls === 0 && native?.error === null && native?.children === 3,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => page.frames());
	ok(
		`${mode}: inserting runs none of the element's own getters, as natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		`native ${JSON.stringify(native)} proxied ${JSON.stringify(proxied)}`,
	);
	await page.close();
}

await done(browser);
