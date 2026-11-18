// An inline style declaration's methods (setProperty, getPropertyValue,
// getPropertyPriority, removeProperty, item) are the prototype's own
// functions on every read, as natively, and take whatever receiver they are
// called on: the page's declaration is a Proxy (the named properties have
// per-instance setters), and a method bound to its target on each read was
// a new function every time that ignored its receiver (a.style.setProperty
// called on b.style wrote a's style). The values read back are the page's
// URLs. Compared with the page loaded natively. Both modes.
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
const PAGE = `${FIXTURE}pages/declaration-methods.html`;

async function measure(frames) {
	for (let i = 0; i < 60; i++) {
		for (const frame of frames()) {
			const value = await frame.evaluate(() => window.__dm).catch(() => null);
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
	"natively: every method is the prototype's and takes its receiver",
	native?.['same read'] === true &&
		native?.["setProperty is the prototype's"] === true &&
		native?.['set through another declaration']?.[1] === 'blue',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => page.frames());
	for (const key of Object.keys(native ?? {}))
		ok(
			`${mode}: ${key} as natively`,
			JSON.stringify(proxied?.[key]) === JSON.stringify(native[key]),
			`native ${JSON.stringify(native[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	await page.close();
}

await done(browser);
