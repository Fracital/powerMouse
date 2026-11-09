// innerHTML replaces every child an element had. The hooked setter removed
// the old children while iterating the live childNodes list, which skips
// every other node: a div of four children set to new markup kept two of
// them next to it. markup-replace.html sets innerHTML on elements of the
// page's markup, on a template and on a built element, and records what
// each holds afterwards; compared with the page loaded natively (framed as
// the proxied page is), both demo modes.
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

/** the page's report, from whichever frame holds it */
async function report(page) {
	let state = null;
	for (let i = 0; i < 80 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__markupReplace)
				.catch(() => null);
			if (value) state = value;
		}
	}
	return state;
}

const browser = await launch();

const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
await nativePage.goto(`${FIXTURE}pages/hist-1.html`);
await nativePage.evaluate((url) => {
	const frame = document.createElement('iframe');
	frame.src = url;
	document.body.append(frame);
}, `${FIXTURE}pages/markup-replace.html`);
const native = await report(nativePage);
await nativeContext.close();
const cases = Object.keys(native?.result ?? {});
ok('natively, every case ran', cases.length === 5, JSON.stringify(native));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/markup-replace.html`);
	const state = await report(page);
	ok(`${mode}: the page ran`, state?.done === true);
	for (const name of cases)
		ok(
			`${mode}: ${name} holds only the new markup, as natively`,
			JSON.stringify(state?.result?.[name]) ===
				JSON.stringify(native.result[name]),
			`native ${JSON.stringify(native.result[name])}; proxied ${JSON.stringify(state?.result?.[name])}`,
		);
	await page.close();
}
await done(browser);
