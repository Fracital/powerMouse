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
	'the worker applies no CORS, CORP or same-origin mode': [
		'fetch/cors without ACAO',
		'fetch/cors ACAO *',
		'fetch/cors ACAO A',
		'fetch/cors ACAO other origin',
		'fetch/cors ACAO null',
		'fetch/cors exposes a header',
		'fetch/cors exposes every header',
		'fetch/credentials include, ACAO *',
		'fetch/credentials include, ACAO A, ACAC',
		'fetch/credentials include, ACAO A, no ACAC',
		'fetch/credentials omit, ACAO *',
		'fetch/preflight PUT allowed',
		'fetch/preflight PUT refused',
		'fetch/preflight header allowed',
		'fetch/preflight header refused',
		'fetch/preflight JSON content type',
		'fetch/simple POST needs no preflight',
		'fetch/preflight answered 500',
		'fetch/preflight wildcard methods with credentials',
		'fetch/preflight wildcard headers',
		'fetch/preflight refused by its own ACAO',
		'fetch/preflight is cached for its max-age',
		'fetch/no-cors',
		'fetch/no-cors with ACAO',
		'fetch/same-origin mode to another origin',
		'fetch/redirect to another origin without ACAO',
		'fetch/redirect to another origin with ACAO',
		'fetch/no-cors redirect to another origin',
		'fetch/a cross-origin redirect without ACAO on the hop',
		'xhr/without ACAO',
		'xhr/ACAO *',
		'xhr/withCredentials, ACAO *',
		'xhr/preflight refused',
		'xhr/synchronous without ACAO',
		'corp/same-origin image of another site',
		'corp/same-site image of another site',
		'corp/no-cors fetch of a same-origin resource of another site',
		'script/crossorigin script without ACAO fails',
		'script/module script of another site without ACAO fails',
		'worker/reads another site',
		'worker/module worker imports another site without ACAO',
		'font/another site without ACAO',
		'fetch/from a srcdoc frame that sends no referrer',
	],
	'a crossorigin load is not checked for CORS': [
		'canvas/cross-origin image with ACAO, no crossorigin',
		'canvas/crossorigin image without ACAO',
		'canvas/crossorigin use-credentials with ACAO *',
	],
	'nothing taints a canvas': [
		'canvas/cross-origin image',
		'canvas/cross-origin image drawn scaled',
		'canvas/a tainted canvas drawn into another',
		'canvas/pattern of a cross-origin image',
		'canvas/ImageBitmap of a cross-origin image',
		'canvas/OffscreenCanvas with a cross-origin image',
		'canvas/WebGL texture of a cross-origin image',
	],
	'resource timing is not gated by Timing-Allow-Origin': [
		'timing/another site without Timing-Allow-Origin',
		'timing/another site with Timing-Allow-Origin *',
		'timing/another site with ACAO, without TAO',
	],
	'the setter does not parse the domain as a host': ['document/domain setter'],
	'navigation.entries() lists the other origin': [
		'navigation/another site sees only its own entries',
	],
	'Web Locks are shared by every proxied site': [
		'storage/another site wrote nothing here',
		'storage/a lock another site holds is not held here',
	],
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
