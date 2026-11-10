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
	'an about:srcdoc document under no-referrer is judged as an opaque origin': [
		'fetch/from a srcdoc frame that sends no referrer, ACAO A',
	],
	'resource timing is not gated by Timing-Allow-Origin': [
		'timing/another site without Timing-Allow-Origin',
		'timing/another site with Timing-Allow-Origin *',
		'timing/another site with ACAO, without TAO',
	],
	'the setter does not parse the domain as a host': ['document/domain setter'],
	'navigator.storage.estimate() counts every proxied site': [
		'storage/usage does not count another site',
	],
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

const browser = await launch();

const nativePage = await browser.newPage();
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
	await page.evaluate((url) => {
		const form = document.getElementById('mainForm');
		form.url.value = url;
		form.requestSubmit();
	}, pageURL(mode));
	const proxied = await report(page);
	ok(`${mode}: the battery ran every case`, proxied !== null, normal(proxied));
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
	await page.context().close();
}

await done(browser);
