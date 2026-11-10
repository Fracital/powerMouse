// localStorage from a frame with no URL of its own to resolve against
// reads and writes as natively. A srcdoc frame runs its own inject, whose
// synchronous bridge resolved the proxy's route against the frame's
// location, about:srcdoc, and threw "Failed to construct 'URL': Invalid
// URL" (an imgur ad script). A written about:blank frame and a blob: frame
// are compared too. Compared with the page loaded natively. Both modes.
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
const PAGE = `${FIXTURE}pages/frame-storage.html`;

async function measure(frames) {
	for (let i = 0; i < 60; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(
					() => Object.keys(window.__fs ?? {}).length === 3 && window.__fs,
				)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

// the frames report in whichever order they load: compare by key
const canonical = (value) =>
	JSON.stringify(value && Object.fromEntries(Object.entries(value).sort()));

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	"natively: every frame reads the top's key and its own",
	native?.blank === 'top,blank' &&
		native?.srcdoc === 'top,srcdoc' &&
		native?.blob === 'top,blob',
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
		`${mode}: localStorage in a written, srcdoc and blob: frame answers as natively`,
		canonical(proxied) === canonical(native),
		`native ${JSON.stringify(native)} proxied ${JSON.stringify(proxied)}`,
	);
	await page.close();
}

await done(browser);
