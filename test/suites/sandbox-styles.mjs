// A frame sandboxed without allow-scripts keeps its inline styles. The
// shell writes the page's markup with each <style> held in a small script
// that puts it back (so the parser never fetches the rule's loads from the
// proxy origin), and in such a frame the script policy lets only the
// inject's nonce run: the scripts carried none, every inline style was
// lost (a CSP error in the console; browserleaks' rects frame lost its
// positioned box). Compared with the page loaded natively, in both modes.
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

const PAGE = `${FIXTURE}pages/sandbox-styles.html`;
const browser = await launch();

async function measure(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(() => window.__sandboxStyles ?? null)
				.catch(() => null);
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
	'natively: both inline styles apply in the frame',
	native?.head === 'rgb(1, 2, 3)' && native?.body === 'rgb(4, 5, 6)',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const violations = [];
	page.on('console', (message) => {
		if (/Content Security Policy/.test(message.text()))
			violations.push(message.text());
	});
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			.filter((f) => !/sandbox-styles-child/.test(f.url())),
	);
	ok(
		`${mode}: the frame's inline styles apply, as natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		JSON.stringify({ native, proxied }),
	);
	ok(
		`${mode}: no script of the inject is refused`,
		violations.length === 0,
		JSON.stringify(violations.slice(0, 3)),
	);
	await page.close();
}
await done(browser);
