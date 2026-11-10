// A proxied page reads the browser window's outer size and screen
// position, as a page in any frame does natively: the top-level window's.
// They were spoofed to the frame's inner size at 0,0, a window with no
// toolbar (outerHeight equal to innerHeight), which a real one never is
// outside fullscreen and which fingerprinting scripts take for headless.
// The page's values are compared with the host page's own (the same
// window) and the outer/inner relation with the page loaded natively, in
// both modes. Every page here has a real window, no viewport emulation:
// Playwright's makes outerHeight equal innerHeight natively too.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/window-geometry.html`;
const browser = await launch();

async function measure(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(() => window.__geometry ?? null)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage({ viewport: null });
// the first page of a new browser can run its scripts before the window's
// bounds reach it (a slow runner read 0 0 0 0 0 0 there); the proxied pages
// load into a window that has been up for seconds, so the native one waits
// for its window too
const timeout = 30000;
await nativePage.waitForFunction(() => outerWidth > 0, null, { timeout });
await nativePage.goto(PAGE);
const native = await measure(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	'natively: the window is taller than its viewport',
	native?.toolbar === true,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	await waitForServer(base);
	const page = await browser.newPage({ viewport: null });
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	const window = await page.evaluate(() =>
		[outerWidth, outerHeight, screenX, screenY, screenLeft, screenTop].join(
			' ',
		),
	);
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	ok(
		`${mode}: outer size and position are the browser window's`,
		proxied?.outer === window,
		JSON.stringify({ window, proxied }),
	);
	ok(
		`${mode}: the window is taller than the viewport and as wide, as natively`,
		proxied?.toolbar === native?.toolbar && proxied?.wider === native?.wider,
		JSON.stringify({ native, proxied }),
	);
	await page.close();
}
await done(browser);
