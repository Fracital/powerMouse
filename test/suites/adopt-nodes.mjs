// Elements another parser made (DOMParser, Document.parseHTMLUnsafe, an
// XHR's document), adopted or imported into the page's document and never
// inserted (adopt-nodes.html). Natively the browser starts some of their
// loads at once (images, media, an SVG use) and runs their error handlers;
// the proxy used to route and rewrite such nodes only when they were
// inserted into a connected tree, so those loads left the proxy as the page
// wrote them and the handlers ran unrewritten. Through the proxy the same
// loads must reach the worker (and no other: a link, a script, a frame, an
// object stay unloaded as natively), the same handlers must run, and a
// moved image must read back what the page wrote. Both modes.
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
				?.evaluate(() => window.__adopt)
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
}, `${FIXTURE}pages/adopt-nodes.html`);
const nativeState = await report(nativePage);
await sleep(1000);
const fired = [...new Set(nativeRecorder.log.map((entry) => wayOf(entry.url)))]
	.filter(Boolean)
	.sort();
await nativeContext.close();
ok(
	'natively, the page ran and moved nodes load and run their handlers',
	nativeState?.done === true &&
		fired.includes('DOMParser adoptNode img') &&
		nativeState.ran.includes('DOMParser importNode img'),
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
	await submitLanding(page, `${FIXTURE}pages/adopt-nodes.html`);
	const state = await report(page);
	await sleep(1500);
	const served = await page.evaluate(() => window.__served);
	const through = [...new Set(served.map(wayOf))].filter(Boolean).sort();
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost)
		.map((entry) => wayOf(entry.url) ?? entry.url);
	ok(`${mode}: the page ran`, state?.done === true, JSON.stringify(state));
	ok(
		`${mode}: no moved node loads past the proxy`,
		raw.length === 0,
		raw.join(', '),
	);
	ok(
		`${mode}: the loads that start are the native ones, through the proxy`,
		JSON.stringify(through) === JSON.stringify(fired),
		`native only: ${fired.filter((way) => !through.includes(way)).join(', ')}; proxied only: ${through.filter((way) => !fired.includes(way)).join(', ')}`,
	);
	ok(
		`${mode}: the handlers that run are the native ones`,
		JSON.stringify(state?.ran) === JSON.stringify(nativeState?.ran),
		`native ${JSON.stringify(nativeState?.ran)}\n      proxied ${JSON.stringify(state?.ran)}`,
	);
	for (const [name, native] of Object.entries(nativeState?.read ?? {}))
		ok(
			`${mode}: the ${name} image reads back as natively`,
			JSON.stringify(state?.read?.[name]) === JSON.stringify(native),
			`native ${JSON.stringify(native)}\n      proxied ${JSON.stringify(state?.read?.[name])}`,
		);
	await page.close();
}
await done(browser);
