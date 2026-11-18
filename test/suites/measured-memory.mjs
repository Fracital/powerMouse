// performance.measureUserAgentSpecificMemory() in a cross-origin isolated
// proxied page, against Chrome. The call exists only under cross-origin
// isolation, and what it answers a proxied page with (the page's own URLs,
// its frames' `src` as the page wrote them, nothing of the host's) is a
// deferred part of the document bundle (src/inject/dom/measuredMemory.ts,
// called by src/inject/dom/modules/Isolation.ts). The fixture serves a page
// with COOP and an embedder policy (test/coi-server.mjs, running
// test/pages/measured-memory.js), which makes a frame of its own origin
// that measures: natively, and through the proxy in both demo modes (the
// demo's host is isolated), the frame's result has the native shape, names
// the page's own URLs and never a proxy URL, and gives the frame's `src` as
// the page wrote it, its own element's (in its parent) as its frame's. A
// counting stand-in every document gets for the browser's function before
// any script of its own (so before the inject takes it) sees the one call.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	SLOTS,
	submitLanding,
	waitActive,
} from '../lib.mjs';

// (the collector is the page's to call, so the measurement comes at once)
const browser = await launch(['--js-flags=--expose-gc']);

const COOP = 'cross-origin-opener-policy:same-origin';
const COEP = 'cross-origin-embedder-policy:require-corp';
const pageURL = (key) =>
	`${FIXTURE}coi/doc?h=${encodeURIComponent(COOP)}&h=${encodeURIComponent(
		COEP,
	)}&script=/pages/measured-memory.js&k=${key}`;
const PROXY_ORIGINS = [PROXY, HOST, ...SLOTS].map((url) => new URL(url).origin);

/** a counting stand-in for the browser's function, in every document */
function countNatives() {
	const reached = (window.__nativeReached = []);
	const prototype = window.Performance?.prototype;
	const native = prototype?.measureUserAgentSpecificMemory;
	if (typeof native !== 'function') return;
	prototype.measureUserAgentSpecificMemory = function (...args) {
		reached.push('measureUserAgentSpecificMemory');
		return Reflect.apply(native, this, args);
	};
}

// natively
const context = await browser.newContext();
const nativePage = await context.newPage();
await nativePage.addInitScript(countNatives);
await nativePage.goto(pageURL('native'));
await nativePage.waitForFunction(() => window.__ready === true);
const native = await nativePage.evaluate(() => window.__child('measuring'));
await context.close();
const nativeOk = ok(
	"natively, the isolated page's frame measures, through the browser",
	native.isolated === true &&
		native.promise === 'resolved' &&
		native.reached?.join() === 'measureUserAgentSpecificMemory',
	JSON.stringify(native),
);

/** the fields of a result compared with the native one */
const SHAPE = [
	'isolated',
	'parentIsolated',
	'type',
	'returned',
	'promise',
	'keys',
	'bytes',
	'sums',
	'breakdownKeys',
	'types',
	'frozen',
	'reached',
];
/** the containers a result names */
const containers = (out) =>
	(out?.attribution ?? [])
		.map((text) => JSON.parse(text).container)
		.filter((container) => container !== null);
const shape = (out) =>
	Object.fromEntries(SHAPE.map((key) => [key, JSON.stringify(out?.[key])]));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.addInitScript(countNatives);
	await submitLanding(page, pageURL(mode));
	const top = await waitActive(page, `window.__ready === true`, 60000);

	const proxied = await top.evaluate(() => window.__child('measuring'));
	if (nativeOk) {
		const wanted = shape(native);
		const got = shape(proxied);
		ok(
			`${mode}, the result has the native shape, through the browser`,
			SHAPE.every((key) => wanted[key] === got[key]),
			JSON.stringify(
				SHAPE.filter((key) => wanted[key] !== got[key]).map(
					(key) => `${key}: ${wanted[key]} -> ${got[key]}`,
				),
			),
		);
		ok(
			`${mode}, the attribution names what it does natively`,
			JSON.stringify(proxied.attribution) ===
				JSON.stringify(native.attribution),
			JSON.stringify({
				native: native.attribution,
				proxied: proxied.attribution,
			}),
		);
	}
	ok(
		`${mode}, no URL of the result is the proxy's`,
		Array.isArray(proxied.raw) &&
			proxied.raw.length > 0 &&
			!proxied.raw.some((url) =>
				PROXY_ORIGINS.some((origin) => url.includes(origin)),
			),
		JSON.stringify(proxied.raw),
	);
	// (the measuring frame's own element, in its parent's document, and its
	// inner frame's, in its own)
	const written = { measuring: proxied.written, inner: proxied.innerWritten };
	const named = containers(proxied);
	ok(
		`${mode}, a frame's src is the one the page wrote`,
		named.length > 0 &&
			named.every((container) => container.src === written[container.id]),
		JSON.stringify({ named, written }),
	);
	await page.close();
}

await done(browser);
