// No request a proxied page makes bypasses the proxy. The page fires every
// request API and element known to load something (bypass.html), each
// marked `?bypass=<vector>`, at its own (real) origin; the browser-side
// recorder sees every request of the context, and any that goes straight to
// that origin, not through the service worker, is a bypass. The worker's
// request log shows which vectors went through; a vector seen by neither
// fired nothing here and is listed. Both demo modes.
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

const VECTORS = [
	...['markup-stylesheet', 'prefetch', 'preload', 'modulepreload', 'icon'],
	...['style-import', 'style-font', 'style-url', 'image-set', 'speculation'],
	...['inline-style', 'markup-img', 'markup-srcset', 'picture-source'],
	...['input-image', 'poster', 'markup-video', 'track', 'markup-audio'],
	...['markup-object', 'markup-embed', 'svg-image', 'svg-use', 'fe-image'],
	...['svg-use-xlink'],
	...['ping', 'ping-navigation', 'ping-absolute', 'ping-absolute-navigation'],
	...['form', 'meta-refresh', 'header-refresh'],
	...['srcdoc-img', 'dynamic-import', 'fetch', 'fetch-keepalive', 'xhr'],
	...['beacon', 'eventsource', 'websocket', 'websocketstream', 'dedicated'],
	...['shared', 'importScripts', 'dedicated-fetch', 'shared-fetch', 'img'],
	...['image-object', 'script', 'link-stylesheet', 'link-prefetch', 'iframe'],
	...['object', 'embed', 'video', 'audio', 'audio-object', 'font-face'],
	...['css-insert', 'inner-html', 'document-write', 'paint-worklet'],
	...['audio-worklet', 'import', 'open'],
];
const fixtureHost = new URL(FIXTURE).host;
const vectorOf = (url) => /[?&]bypass=([\w-]+)/.exec(url)?.[1] ?? null;

/** the page's report, from whichever frame holds it */
async function report(page) {
	let state = null;
	for (let i = 0; i < 60 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__bypass)
				.catch(() => null);
			if (value) state = value;
		}
	}
	return state;
}

/** the vectors a run saw: marked requests, and the sockets that opened */
function vectorsOf(urls, state) {
	const seen = new Set(urls.map(vectorOf).filter(Boolean));
	for (const [name, value] of Object.entries(state?.opened ?? {}))
		if (value) seen.add(name);
	return seen;
}

const browser = await launch();

// the ground truth: what this browser fires for the page on the real site,
// framed as the proxied page is (a frame fires no speculation rules and
// loads no icon)
const nativeContext = await browser.newContext();
const nativeRecorder = await recordRequests(nativeContext);
const nativePage = await nativeContext.newPage();
await nativePage.goto(`${FIXTURE}pages/hist-1.html`);
await nativePage.evaluate((url) => {
	const frame = document.createElement('iframe');
	frame.src = url;
	document.body.append(frame);
}, `${FIXTURE}pages/bypass.html?k=native`);
const nativeState = await report(nativePage);
await sleep(4000);
const fired = vectorsOf(
	nativeRecorder.log.map((entry) => entry.url),
	nativeState,
);
await nativeContext.close();
ok(
	'the page fires its vectors natively',
	fired.size > 40,
	`${fired.size} fired; not here: ${VECTORS.filter((v) => !fired.has(v)).join(', ')}; errors ${JSON.stringify(nativeState?.errors ?? {})}`,
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
	await submitLanding(page, `${FIXTURE}pages/bypass.html?k=${mode}`);
	const state = await report(page);
	// late loads (a refresh, a worker's fetch) and the request log's grace
	await sleep(4000);
	const served = await page.evaluate(() => window.__served);
	const through = vectorsOf(served, state);
	// a raw request the page named: marked, or to the page's real host
	const raw = recorder
		.raw()
		.filter(
			(entry) => vectorOf(entry.url) || new URL(entry.url).host === fixtureHost,
		);
	const bypassed = new Map();
	for (const entry of raw) {
		const vector = vectorOf(entry.url) ?? `unmarked ${entry.url.slice(0, 80)}`;
		if (!bypassed.has(vector)) bypassed.set(vector, entry);
	}
	ok(
		`${mode}: the page ran every vector`,
		state?.done === true,
		JSON.stringify(state),
	);
	ok(
		`${mode}: no request bypasses the proxy`,
		bypassed.size === 0,
		JSON.stringify(
			[...bypassed].map(([vector, entry]) => [
				vector,
				entry.type,
				entry.source,
			]),
		),
	);
	// what fires on the real site fires through the proxy too
	const lost = [...fired].filter((v) => !through.has(v) && !bypassed.has(v));
	ok(
		`${mode}: every vector that fires natively goes through the proxy`,
		lost.length === 0,
		`lost: ${lost.join(', ')}; page errors: ${JSON.stringify(state?.errors ?? {})}`,
	);
	// a ping carries the page's URLs (Ping-From, Ping-To) as the browser
	// would send them on the real site, the run's key aside
	const pingHeaders = async (key) => {
		const response = await fetch(
			`${FIXTURE}echo-headers/recorded?k=ping-${key}`,
		);
		const headers = (await response.json()) ?? {};
		const pick = (name) => headers[name]?.replace(`k=${key}`, 'k=KEY') ?? null;
		return {
			from: pick('ping-from'),
			to: pick('ping-to'),
			type: pick('content-type'),
		};
	};
	const nativePing = await pingHeaders('native');
	const proxiedPing = await pingHeaders(mode);
	ok(
		`${mode}: a ping names the page's URLs as on the real site`,
		nativePing.from !== null &&
			JSON.stringify(nativePing) === JSON.stringify(proxiedPing),
		JSON.stringify({ native: nativePing, proxied: proxiedPing }),
	);
	ok(
		`${mode}: a ping attribute reads back as the page wrote it`,
		JSON.stringify(state?.pingRead) === JSON.stringify(nativeState?.pingRead),
		JSON.stringify({ native: nativeState?.pingRead, proxied: state?.pingRead }),
	);
	const extra = [...through].filter((v) => !fired.has(v));
	if (extra.length)
		console.log(`  ${mode}: through the proxy only: ${extra.join(', ')}`);
	await page.close();
}
await done(browser);
