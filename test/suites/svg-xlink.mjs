// SVG's legacy xlink:href under another prefix (x:href, q:href: the
// browser finds the attribute by its namespace) and SMIL animations of an
// href, on a fixture page (svg-xlink.html) loaded natively and through the
// proxy. The hooks used to know the attribute only as xlink:href, so a
// script by x:href loaded and ran as the page wrote it, an animated href
// whose target appeared later loaded its raw URL, and href.baseVal wrote an
// href where the browser writes the xlink:href the element has. Through
// the proxy the same scripts must run, the same loads must reach the
// worker (none past it), and every element must read back as natively,
// an animation's animVal included. Both modes.
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
const wayOf = (url) => {
	const way = /[?&]w=([^&#]+)/.exec(url)?.[1];
	return way === undefined ? null : decodeURIComponent(way);
};

/** the page's report, from whichever frame holds it */
async function report(page) {
	let state = null;
	for (let i = 0; i < 120 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__svgXlink)
				.catch(() => null);
			if (value) state = value;
		}
	}
	return state;
}

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
}, `${FIXTURE}pages/svg-xlink.html`);
const nativeState = await report(nativePage);
await sleep(1000);
const fired = [...new Set(nativeRecorder.log.map((entry) => wayOf(entry.url)))]
	.filter(Boolean)
	.sort();
await nativeContext.close();
ok(
	'natively, the page ran, x:href scripts run and animated hrefs load',
	nativeState?.done === true &&
		fired.includes('late image') &&
		nativeState.ran.includes('setAttributeNS x:href'),
	JSON.stringify({ fired, ran: nativeState?.ran }),
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
	await submitLanding(page, `${FIXTURE}pages/svg-xlink.html`);
	const state = await report(page);
	await sleep(1500);
	const served = await page.evaluate(() => window.__served);
	const through = [...new Set(served.map(wayOf))].filter(Boolean).sort();
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost)
		.map((entry) => wayOf(entry.url) ?? entry.url);
	ok(`${mode}: the page ran`, state?.done === true, JSON.stringify(state));
	ok(`${mode}: nothing loads past the proxy`, raw.length === 0, raw.join(', '));
	ok(
		`${mode}: the loads that start are the native ones, through the proxy`,
		JSON.stringify(through) === JSON.stringify(fired),
		`native only: ${fired.filter((way) => !through.includes(way)).join(', ')}; proxied only: ${through.filter((way) => !fired.includes(way)).join(', ')}`,
	);
	ok(
		`${mode}: the scripts that run are the native ones`,
		JSON.stringify(state?.ran) === JSON.stringify(nativeState?.ran),
		`native ${JSON.stringify(nativeState?.ran)}\n      proxied ${JSON.stringify(state?.ran)}`,
	);
	for (const [name, native] of Object.entries(nativeState?.read ?? {}))
		ok(
			`${mode}: ${name} reads back as natively`,
			JSON.stringify(state?.read?.[name]) === JSON.stringify(native),
			`native ${JSON.stringify(native)}\n      proxied ${JSON.stringify(state?.read?.[name])}`,
		);
	await page.close();
}
await done(browser);
