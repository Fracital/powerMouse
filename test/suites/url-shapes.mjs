// Addresses that end in an empty query (`?`), an empty fragment (`#`) or
// both keep them natively: `new URL('/p?').href` is `/p?`, and every surface
// a page reads a URL from shows them. The battery (test/pages/url-shapes.js,
// test/shapes-server.mjs) reads each surface for each shape (a frame's own
// address in every form, through a redirect too, fetch and its redirect,
// Request, a link, a worker's location, history.pushState, the resource
// entries, `location.hash = ''`), natively and through the proxy in both
// modes, and compares every case. The request target the server sees is
// one of them: the proxy must ask the site for `/p?`, not `/p`.
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

// Cases known to differ from Chrome, by why. A case on the list that now
// reads as natively fails too: take it off.
const KNOWN_BY_REASON = {};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

const A = new URL(FIXTURE).origin.replace('127.0.0.1', 'localhost');
const PAGE = `${A}/shape/top`;

/** the battery's cases, from whichever frame holds them */
async function report(page) {
	for (let i = 0; i < 480; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__shapes)
				.catch(() => null);
			if (value?.done) return value.cases;
		}
	}
	return null;
}

// a run's ports are no part of a URL's shape
const normal = (value) =>
	JSON.stringify(value ?? null).replace(/(localhost|127\.0\.0\.1):\d+/g, 'A');

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await report(nativePage);
await nativePage.context().close();
ok(
	'natively, the battery ran every case',
	native !== null && Object.keys(native).length > 0,
);
ok(
	'natively, an address keeps its empty query and its empty fragment',
	native?.['empty-query: a frame']?.['location.href']?.endsWith('?') &&
		native?.['empty-fragment: a frame']?.['location.href']?.endsWith('#') &&
		native?.['empty-query: a frame']?.['the request target the server saw'] ===
			'/shape/frame/f-empty-query?',
	normal([
		native?.['empty-query: a frame']?.['location.href'],
		native?.['empty-fragment: a frame']?.['location.href'],
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
	}, PAGE);
	const proxied = await report(page);
	await page.context().close();
	ok(`${mode}: the battery ran every case`, proxied !== null);
	for (const name of Object.keys(native ?? {})) {
		const want = normal(native[name]);
		const got = normal(proxied?.[name]);
		const detail = `\n      native  ${want}\n      proxied ${got}`;
		const known = KNOWN.get(name);
		if (known)
			ok(
				`${mode}: ${name} differs as known (${known})`,
				want !== got,
				`now as natively: take it off the list${detail}`,
			);
		else ok(`${mode}: ${name} as natively`, want === got, detail);
	}
}

await done(browser);
