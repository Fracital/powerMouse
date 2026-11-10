// Markup a page sets parses in the element's own context, as the browser's
// fragment parser does, and the insertAdjacent methods behave as natively.
// The innerHTML, outerHTML and insertAdjacentHTML hooks parsed every string
// as the body's content: a <tbody>'s rows lost their <tr> and <td> (only
// the text was left, so browserleaks' tables ran their cells together), an
// <svg>'s children were HTML elements, a <textarea>'s or <title>'s markup
// became elements. insertAdjacentText, insertAdjacentElement and
// insertAdjacentHTML took only lowercase positions, returned nothing,
// wrote "undefined" into an empty element for afterbegin, and threw other
// errors than Chrome's. test/pages/fragment-context.html reads each result
// back by shape; compared with the page loaded natively, in both modes.
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

const PAGE = `${FIXTURE}pages/fragment-context.html`;
const browser = await launch();

async function measure(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(() => window.__fragment ?? null)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
const nativeErrors = [];
nativePage.on('pageerror', (error) => nativeErrors.push(error.message));
await nativePage.goto(PAGE);
const native = await measure(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	'natively: a tbody keeps its rows and the page ran every case',
	native?.tbody?.startsWith('xhtml:tr(') && nativeErrors.length === 0,
	JSON.stringify({ native, nativeErrors }),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	for (const name of Object.keys(native ?? {}))
		ok(
			`${mode}: ${name} as natively`,
			proxied?.[name] === native[name],
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied?.[name])}`,
		);
	ok(
		`${mode}: no page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await done(browser);
