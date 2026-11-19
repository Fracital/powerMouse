// A proxied page's window is a top-level page's: its outer size is its
// viewport plus the browser's own UI around the host's (outerWidth -
// innerWidth and outerHeight - innerHeight of the host's page), and its
// screen position is the browser window's moved by where the frame's
// viewport is in the host's, as if the host's UI around the frame were not
// there. It was the browser window's own outer size, which counted the
// demo's two 48 px bars as browser UI: outerHeight - innerHeight about 200
// in a normal window, which Discord takes for its devtools docked (over
// 160), and it took its token out of storage on every load. Before that it
// was the frame's inner size at 0,0, a window with no toolbar (outerHeight
// equal to innerHeight), which a real one never is outside fullscreen and
// which fingerprinting scripts take for headless. Read as the page's first
// script runs, at its load, in a frame of the page (natively the top's
// window), and in a resize listener after the browser window grew; the
// outer/inner relation compared with the page loaded natively. Both modes,
// with the site pool and without. Every page here has a real window, no
// viewport emulation: Playwright's makes outerHeight equal innerHeight
// natively too.
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

/** `read` in `frame`, once it answers */
async function poll(frame, read) {
	for (let i = 0; i < 80; i++) {
		const value = await frame.evaluate(read).catch(() => null);
		if (value) return value;
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage({ viewport: null });
await nativePage.goto(PAGE);
// a new top-level document can run its scripts before its window's bounds
// reach it, and under load it does (CI and a loaded machine read 0 0 0 0 0 0
// there); a proxied page is a frame of a top-level page that has had them
// for seconds. The native reading is taken once the window has them
await nativePage.waitForFunction(() => outerWidth > 0, null, {
	timeout: 30000,
});
const native = await nativePage.evaluate(() => window.__measureGeometry());
await nativePage.close();
ok(
	'natively: the window is taller than its viewport',
	native?.toolbar === true,
	JSON.stringify(native),
);
ok(
	"natively: a frame of the page reads the top's window",
	native?.child === native?.outer,
	JSON.stringify(native),
);
ok(
	'natively: no devtools by the outer size (Discord)',
	native?.devtools === false,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['same-origin, no pool', `${PROXY}?nopool`],
	['isolated', HOST],
	['isolated, no pool', `${HOST}?nopool`],
]) {
	await waitForServer(base);
	const page = await browser.newPage({ viewport: null });
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	/** the host's page: the browser's UI around its viewport, its window's position */
	const hostWindow = () =>
		page.evaluate(() => ({
			chrome: [outerWidth - innerWidth, outerHeight - innerHeight].join(' '),
			screen: [screenX, screenY],
		}));
	await submitLanding(page, PAGE);
	// (a routed URL names its page encoded: the page is the one that has a reading)
	let frame = null;
	let proxied = null;
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		for (const candidate of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))) {
			proxied = await candidate
				.evaluate(() => window.__geometry ?? null)
				.catch(() => null);
			if (proxied) {
				frame = candidate;
				break;
			}
		}
	}
	if (!proxied) {
		ok(`${mode}: the page loaded`, false);
		await page.close();
		continue;
	}
	const early = await frame.evaluate(() => window.__early);
	const host = await hostWindow();
	const element = await frame.frameElement();
	/** where the frame's viewport is in the host's */
	const at = await element.evaluate((own) => {
		const rect = own.getBoundingClientRect();
		const style = getComputedStyle(own);
		return [
			Math.round(rect.left + own.clientLeft + parseFloat(style.paddingLeft)),
			Math.round(rect.top + own.clientTop + parseFloat(style.paddingTop)),
		];
	});
	const position = (reading) => reading.outer.split(' ').slice(2).map(Number);
	ok(
		`${mode}: outer size is the viewport and the browser's UI around the host's, as the first script and the load read it`,
		proxied.chrome === host.chrome && early?.chrome === host.chrome,
		JSON.stringify({ host, early, proxied }),
	);
	ok(
		`${mode}: screen position is the window's moved by where the frame is in the host's viewport`,
		JSON.stringify(position(proxied)) ===
			JSON.stringify([
				host.screen[0] + at[0],
				host.screen[1] + at[1],
				host.screen[0] + at[0],
				host.screen[1] + at[1],
			]),
		JSON.stringify({ host, at, proxied }),
	);
	ok(
		`${mode}: no devtools by the outer size (Discord), as natively`,
		proxied.devtools === native?.devtools &&
			early?.devtools === native?.devtools,
		JSON.stringify({ native, early, proxied }),
	);
	ok(
		`${mode}: the window is taller than the viewport and as wide, as natively`,
		proxied.toolbar === native?.toolbar && proxied.wider === native?.wider,
		JSON.stringify({ native, proxied }),
	);
	ok(
		`${mode}: a frame of the page reads its window, as natively the top's`,
		proxied.child === proxied.outer,
		JSON.stringify(proxied),
	);

	// the browser window grows: the page's resize listener reads the new
	// viewport with the same browser UI around it
	const cdp = await page.context().newCDPSession(page);
	const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
	await cdp.send('Browser.setWindowBounds', {
		windowId,
		bounds: { width: bounds.width + 120, height: bounds.height + 80 },
	});
	const resized = await poll(frame, () => window.__resizes.at(-1));
	await sleep(500);
	const after = await frame.evaluate(() => window.__measureGeometry());
	const hostAfter = await hostWindow();
	ok(
		`${mode}: after a resize, the resize listener and the page read the browser's UI around the new viewport`,
		!!resized &&
			resized.inner !== proxied.inner &&
			resized.chrome === hostAfter.chrome &&
			after.chrome === hostAfter.chrome &&
			after.child === after.outer,
		JSON.stringify({ hostAfter, proxied, resized, after }),
	);
	await cdp.detach().catch(() => {});
	await page.close();
}
await done(browser);
