// A style attribute on an element that is not HTML (SVG, MathML, another
// namespace), in a frame no service worker controls, throws nothing. The
// copy the inject makes of an inline style's url() loads read the element's
// declaration through HTMLElement's own getter, which throws "Illegal
// invocation" on any other kind of element (imgur's ads, in a written
// about:blank frame). Compared with the page loaded natively. Both modes.
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
const PAGE = `${FIXTURE}pages/inline-style-kinds.html`;

async function measure(frames) {
	for (let i = 0; i < 60; i++) {
		for (const frame of frames()) {
			const value = await frame.evaluate(() => window.__isk).catch(() => null);
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
	'natively: nothing throws and every style attribute reads back',
	native?.errors.length === 0 && native?.fill === 'red',
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
		`${mode}: a style attribute on an SVG, MathML or other element throws nothing, as natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		`native ${JSON.stringify(native)} proxied ${JSON.stringify(proxied)}`,
	);
	await page.close();
}

await done(browser);
