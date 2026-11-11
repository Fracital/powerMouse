// The same-origin policy between two proxied sites, against Chrome. A page
// on one site (the fixture on 127.0.0.1) reaches another (the fixture on
// localhost) every way the policy governs (test/pages/sop.js): fetch and
// XMLHttpRequest under CORS (preflights, the Access-Control-* answers,
// credentials, no-cors opacity, redirects), canvas and WebGL tainting,
// Cross-Origin-Resource-Policy, muted script errors, font CORS,
// Timing-Allow-Origin, the document's origins and document.domain, another
// site's storage, channels and locks, and workers. Every proxied site shares
// the proxy's one real origin, so the browser enforces none of it: the
// proxy must. Each case's result is compared with the same page loaded
// natively, in both modes, and so is what reached the other site's server.
//
// SOP_ONLY=<prefix> runs the cases under one prefix (fetch/, canvas/, ...).
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
} from '../lib.mjs';

// Cases known to differ from Chrome, by why (docs/same-origin-policy.md). A
// case on the list that now reads as natively fails too: take it off.
const KNOWN_BY_REASON = {
	"a video or sound copied for a document no service worker controls keeps a blob: URL the page's process can fetch while the element shows it: its loads go on (a seek, a replay), and Chrome resolves a blob: URL again for each (docs/same-origin-policy.md)":
		[
			'gate/the URL a video of another site has in a written about:blank frame, fetched',
		],
	"a page that sends COOP and COEP is not cross-origin isolated: its frame is in the host's browsing context group":
		['coi/a page that sends COOP and COEP'],
	'the tracks of a stream captured from a canvas end when the canvas is tainted (their player shows nothing), where Chrome keeps them live and sends them no more frames (their player keeps the last one)':
		['canvas/the tracks of a stream captured before its canvas was tainted'],
};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

const other = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const only = process.env.SOP_ONLY ?? '';
const pageURL = (k) =>
	`${FIXTURE}pages/sop.html?b=${encodeURIComponent(other)}&k=${k}${
		only ? `&only=${encodeURIComponent(only)}` : ''
	}`;

/** the battery's report, from whichever frame holds it */
async function report(page) {
	for (let i = 0; i < 600; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame?.evaluate(() => window.__sop).catch(() => null);
			if (value?.done) return value.cases;
		}
	}
	return null;
}

// a run's own keys and the proxy's ports say nothing about the policy
const normal = (value) =>
	JSON.stringify(value ?? null).replace(/k=[\w-]+/g, 'k=KEY');

// (media plays without a gesture, so Web Audio has an element's sound to hear)
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);

// what a realm the inject's hooks do not run in would hold: the browser's
// own functions, taken before anything else runs in each document (the
// gate/ cases)
const NATIVES = `window.__sopNative = {
	fetch: window.fetch,
	text: Response.prototype.text,
	getAttribute: Element.prototype.getAttribute,
	MutationObserver: window.MutationObserver,
};`;

const nativePage = await browser.newPage();
await nativePage.context().addInitScript(NATIVES);
await nativePage.goto(pageURL('native'));
const native = await report(nativePage);
await nativePage.context().close();
ok(
	'natively, the battery ran every case',
	native !== null && Object.keys(native).length > 0,
	normal(native),
);
// what the battery relies on, so a change in the browser shows here first
ok(
	'natively, a cross-origin read without CORS fails and a tainted canvas throws',
	native?.['fetch/cors without ACAO']?.result ===
		'TypeError: Failed to fetch' &&
		/SecurityError/.test(
			native?.['canvas/cross-origin image']?.getImageData ?? '',
		),
	normal([
		native?.['fetch/cors without ACAO'],
		native?.['canvas/cross-origin image'],
	]),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.context().addInitScript(NATIVES);
	// the header each copy went out with (a grant's token, src/server/
	// loadGrants.ts), as only the network sees it: the battery replays them
	const seen = [];
	let asked = 0;
	page.context().on('request', (request) => {
		const token = request.headers()['x-stomp-load'];
		// (the battery's own forgeries carry the header too)
		if (token && /^[\w-]{22}$/.test(token))
			seen.push({ url: request.url(), token });
	});
	await page.context().exposeBinding('__sopSeen', () => {
		asked++;
		return seen;
	});
	await page.evaluate((url) => {
		const form = document.getElementById('mainForm');
		form.url.value = url;
		form.requestSubmit();
	}, pageURL(mode));
	const proxied = await report(page);
	ok(`${mode}: the battery ran every case`, proxied !== null, normal(proxied));
	compare(mode, native, proxied);
	if (!only || 'gate/'.startsWith(only) || only.startsWith('gate/'))
		ok(
			`${mode}: the copies went out with single-use tokens, which the battery replayed`,
			asked > 0 && seen.length > 0,
			JSON.stringify({ asked, seen: seen.length }),
		);
	await page.context().close();
}

// The second part: a page whose service worker (an emulated one through
// the proxy, the demo's `?sw`) answers its requests to the other site in its
// own ways (test/pages/sop-sw.js): the worker's answers reach the page as
// natively (an opaque one only to a no-cors request), and the worker's own
// reads are judged as the worker's origin's, preflighted once
if (!only || only.startsWith('sw/')) {
	const swURL = (k) =>
		`${FIXTURE}pages/deep/sopsw/sop-sw.html?b=${encodeURIComponent(other)}&k=${k}`;
	const swReport = async (page) => {
		for (let i = 0; i < 400; i++) {
			await sleep(250);
			for (const frame of page.frames()) {
				const value = await frame
					?.evaluate(() => window.__sopSW)
					.catch(() => null);
				if (value?.done) return value;
			}
		}
		return null;
	};
	const swNativePage = await browser.newPage();
	await swNativePage.goto(swURL('native'));
	const swNative = await swReport(swNativePage);
	await swNativePage.context().close();
	ok(
		'natively, the service worker controlled the page and ran every case',
		swNative?.controlled === true && !swNative.error,
		normal(swNative),
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, `${base}?sw`);
		await page.evaluate((url) => {
			const form = document.getElementById('mainForm');
			form.url.value = url;
			form.requestSubmit();
		}, swURL(mode));
		const proxied = await swReport(page);
		ok(
			`${mode}: the emulated service worker controlled the page and ran every case`,
			proxied?.controlled === true && !proxied.error,
			normal(
				proxied && { controlled: proxied.controlled, error: proxied.error },
			),
		);
		compare(mode, swNative?.cases, proxied?.cases);
		await page.context().close();
	}
}

// The third part: a page that opts into cross-origin isolation, top-level
// natively (only a top-level document's COOP makes an isolated group)
if (!only || only.startsWith('coi/')) {
	const coiReport = async (page) => {
		for (let i = 0; i < 120; i++) {
			await sleep(250);
			for (const frame of page.frames()) {
				const value = await frame
					?.evaluate(() => window.__coi)
					.catch(() => null);
				if (value) return value;
			}
		}
		return null;
	};
	const coiURL = `${FIXTURE}pages/sop-coi.html`;
	const coiNativePage = await browser.newPage();
	await coiNativePage.goto(coiURL);
	const coiNative = {
		'coi/a page that sends COOP and COEP': await coiReport(coiNativePage),
	};
	await coiNativePage.context().close();
	ok(
		'natively, a page that sends COOP and COEP is cross-origin isolated',
		coiNative['coi/a page that sends COOP and COEP']?.crossOriginIsolated ===
			true,
		normal(coiNative),
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		await page.evaluate((url) => {
			const form = document.getElementById('mainForm');
			form.url.value = url;
			form.requestSubmit();
		}, coiURL);
		compare(mode, coiNative, {
			'coi/a page that sends COOP and COEP': await coiReport(page),
		});
		await page.context().close();
	}
}

await done(browser);

/** each case natively against the proxy, a known difference against its list */
function compare(mode, native, proxied) {
	for (const name of Object.keys(native ?? {})) {
		const want = normal(native[name]);
		const got = normal(proxied?.[name]);
		const detail = `\n      native  ${want}\n      proxied ${got}`;
		if (KNOWN.has(name))
			ok(
				`${mode}: ${name} differs as known (${KNOWN.get(name)})`,
				want !== got,
				`now as natively: take it off the list${detail}`,
			);
		else ok(`${mode}: ${name} as natively`, want === got, detail);
	}
}
