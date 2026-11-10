// An SVG <style> in an HTML page applies CSS like an HTML one, so its text
// must load through the proxy and the hooks must not treat it as an HTML
// <style>. Wikipedia inserted inline SVG holding a <style> (about one load in
// six), and the insertion hook read the SVG element's sheet through
// HTMLStyleElement's own getter: an uncaught "Illegal invocation" from the
// page's appendChild. The page (svg-style.html) inserts that shape into a
// connected parent by appendChild, append, innerHTML and insertAdjacentHTML;
// natively nothing throws and each rect is red. It then puts CSS text with an
// @import and a background url(), each marked ?style=<way>, into an SVG
// <style> every way a script can; natively every way loads both, and through
// the proxy none may be a raw request and every one must reach the worker.
// What each style reads back is compared with the native load. Both modes.
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
	for (let i = 0; i < 120 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__svgStyle)
				.catch(() => null);
			if (value) state = value;
		}
	}
	return state;
}

// what a style reads back: its text and its rules
const text = (read) =>
	read && { textContent: read.textContent, rules: read.rules };

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
}, `${FIXTURE}pages/svg-style.html?k=native`);
const nativeState = await report(nativePage);
await sleep(1000);
const fired = new Set(
	nativeRecorder.log.map((entry) => wayOf(entry.url)).filter(Boolean),
);
await nativeContext.close();
const shapes = Object.keys(nativeState?.fills ?? {});
ok(
	'natively, the inserted shape throws nothing and every rect is red',
	shapes.length === 4 &&
		Object.keys(nativeState.errors).length === 0 &&
		nativeState.uncaught.length === 0 &&
		shapes.every((way) => nativeState.fills[way] === 'rgb(255, 0, 0)'),
	JSON.stringify(nativeState && [nativeState.fills, nativeState.errors]),
);
const ways = nativeState?.ways ?? [];
const missing = ways.flatMap((way) =>
	[way, `${way}-import`].filter((mark) => !fired.has(mark)),
);
ok(
	'natively, every way loads its image and its import',
	ways.length > 10 && missing.length === 0,
	`missing ${missing.join(', ')}`,
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
	await submitLanding(page, `${FIXTURE}pages/svg-style.html?k=${mode}`);
	const state = await report(page);
	await sleep(1500);
	const served = await page.evaluate(() => window.__served);
	const through = new Set(served.map(wayOf).filter(Boolean));
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost);
	const bypassed = [...new Set(raw.map((entry) => wayOf(entry.url)))];
	ok(
		`${mode}: the page ran every way`,
		state?.done === true && !state.fatal,
		state?.fatal,
	);
	ok(
		`${mode}: nothing throws where it does not natively`,
		unkey(state?.errors) === unkey(nativeState?.errors) &&
			unkey(state?.uncaught) === unkey(nativeState?.uncaught),
		`native ${unkey([nativeState?.errors, nativeState?.uncaught])}; proxied ${unkey([state?.errors, state?.uncaught])}`,
	);
	for (const way of shapes)
		ok(
			`${mode}: the ${way} shape's rect is red`,
			state?.fills?.[way] === 'rgb(255, 0, 0)',
			JSON.stringify(state?.fills?.[way]),
		);
	ok(
		`${mode}: no SVG style text loads past the proxy`,
		bypassed.length === 0,
		`bypassed: ${bypassed.join(', ')}`,
	);
	const lost = [...fired].filter((mark) => !through.has(mark));
	ok(
		`${mode}: every way's image and import load through the proxy`,
		lost.length === 0,
		`lost: ${lost.join(', ')}`,
	);
	for (const way of ways)
		ok(
			`${mode}: ${way} reads back as natively`,
			unkey(text(state?.read?.[way])) === unkey(text(nativeState.read[way])),
			`native ${unkey(text(nativeState.read[way]))}\n      proxied ${unkey(text(state?.read?.[way]))}`,
		);
	// markup parsed in an SVG element's context is parsed in an HTML one
	// through the proxy (a known gap): its style is an HTML one
	const kinds = ways.filter(
		(way) =>
			!way.startsWith('svg-') &&
			state?.read?.[way]?.namespace !== nativeState.read[way]?.namespace,
	);
	ok(
		`${mode}: every other way's style is an SVG one, as natively`,
		kinds.length === 0,
		kinds.join(', '),
	);
	await page.close();
}
await done(browser);
