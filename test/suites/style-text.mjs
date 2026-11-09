// CSS text a script puts into a connected <style> loads its URLs through the
// proxy, whichever way the text gets there, and the element reads back as
// on the real site. chess.com fills its board's <style> with `innerHTML`:
// the board and every piece went straight to the site's image host, past
// the service worker (a blank board where the network refused it). The page
// (style-text.html) writes one rule per way, each with a background marked
// `?style=<way>`; natively every way loads its image, and through the proxy
// none may be a raw request and every one must reach the worker. What each
// element's innerHTML, textContent and first rule read back is compared with
// the native load. Both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const fixtureHost = new URL(FIXTURE).host;
const wayOf = (url) => /[?&]style=([\w-]+)/.exec(url)?.[1] ?? null;

/** the page's report, from whichever frame holds it */
async function report(page) {
	let state = null;
	for (let i = 0; i < 80 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__styleText)
				.catch(() => null);
			if (value) state = value;
		}
	}
	return state;
}

// the run's own key in a URL, so native and proxied reads compare
const unkey = (value) =>
	JSON.stringify(value ?? null).replace(/\?k=[\w-]+/g, '?k=KEY');

const browser = await launch();

// the ground truth: the page natively, framed as the proxied page is
const nativeContext = await browser.newContext();
const nativeRecorder = await recordRequests(nativeContext);
const nativePage = await nativeContext.newPage();
await nativePage.goto(`${FIXTURE}pages/hist-1.html`);
await nativePage.evaluate((url) => {
	const frame = document.createElement('iframe');
	frame.src = url;
	document.body.append(frame);
}, `${FIXTURE}pages/style-text.html?k=native`);
const nativeState = await report(nativePage);
await sleep(1000);
const fired = new Set(
	nativeRecorder.log.map((entry) => wayOf(entry.url)).filter(Boolean),
);
await nativeContext.close();
const ways = Object.keys(nativeState?.read ?? {});
ok(
	'natively, every way loads its image',
	ways.length > 10 && ways.every((way) => fired.has(way)),
	`ways ${ways.join(', ')}; fired ${[...fired].join(', ')}; errors ${JSON.stringify(nativeState?.errors)}`,
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await page.evaluate(() => {
		window.__served = [];
		window.controller.addEventListener('request', (event) =>
			window.__served.push(event.detail.url),
		);
	});
	await submitLanding(page, `${FIXTURE}pages/style-text.html?k=${mode}`);
	const state = await report(page);
	await sleep(1500);
	const served = await page.evaluate(() => window.__served);
	const through = new Set(served.map(wayOf).filter(Boolean));
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost);
	const bypassed = [...new Set(raw.map((entry) => wayOf(entry.url)))];
	ok(`${mode}: the page ran every way`, state?.done === true);
	ok(
		`${mode}: no style text loads past the proxy`,
		bypassed.length === 0,
		`bypassed: ${bypassed.join(', ')}`,
	);
	const lost = [...fired].filter((way) => !through.has(way));
	ok(
		`${mode}: every way's image loads through the proxy`,
		lost.length === 0,
		`lost: ${lost.join(', ')}; errors ${JSON.stringify(state?.errors)}`,
	);
	for (const way of ways)
		ok(
			`${mode}: ${way} reads back as natively`,
			unkey(state?.read?.[way]) === unkey(nativeState.read[way]),
			`native ${unkey(nativeState.read[way])}\n      proxied ${unkey(state?.read?.[way])}`,
		);
	ok(
		`${mode}: no way throws where it does not natively`,
		unkey(state?.errors) === unkey(nativeState?.errors),
		`native ${unkey(nativeState?.errors)}; proxied ${unkey(state?.errors)}`,
	);
	await page.close();
}
await done(browser);
