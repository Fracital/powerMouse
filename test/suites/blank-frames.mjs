// An about:blank frame the parser makes after an external script is its
// parent's document, like any about:blank frame: the parent reaches its
// document and its cookies (it came out as an opaque origin's: its
// contentDocument was null, WPT cookies/navigated-away.html). And a srcset
// in such a frame whose smallest candidate is missing: the image fails at
// first and loads the other candidate once the frame is wide enough for it.
// Every value is compared with the same page loaded natively; both demo
// modes.
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

const target = `${FIXTURE}pages/blank-frame-origin.html`;

async function report(page) {
	let value = null;
	for (let i = 0; i < 100 && !value; i++) {
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
	'natively, the frame is its parent document and the image loads once the frame is wide',
	native?.document === '[object HTMLDocument]' &&
		native?.cookie === true &&
		native?.narrow === 'error' &&
		native?.wide === 'load',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	const pick = (value, keys) => JSON.stringify(keys.map((key) => value?.[key]));
	const frame = ['document', 'cookie', 'origin', 'href', 'parent', 'error'];
	ok(
		`${mode}: an about:blank frame made after an external script is its parent's document, as natively`,
		pick(proxied, frame) === pick(native, frame),
		JSON.stringify({ native, proxied }),
	);
	const image = ['narrow', 'wide', 'shown'];
	ok(
		`${mode}: a srcset in the frame with a missing candidate loads the other one, as natively`,
		pick(proxied, image) === pick(native, image),
		JSON.stringify({ native, proxied }),
	);
	await page.close();
}
await done(browser);
