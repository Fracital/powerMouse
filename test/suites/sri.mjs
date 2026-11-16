// Subresource integrity behaves as natively (src/sri.ts). A script or a
// stylesheet the proxy rewrites must be checked against the page's hash by
// its origin's bytes, never by the browser on the rewrite: Discord's
// homepage lost its main stylesheet when the Link header's preload kept its
// `integrity` and the browser hashed the rewritten CSS. Each case of
// test/pages/sri.html (markup, a Link header preload, elements a script
// makes with the integrity given before or after the URL, another origin
// with and without CORS, several algorithms, metadata the browser ignores)
// loads or fails as it does natively, in both modes, and the page reads its
// own integrity back.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/sri.html`;
const browser = await launch();
/** the browser hashed a response itself: a route's rewrite, if proxied */
const digestErrors = (lines) =>
	lines.filter((line) => /valid digest in the 'integrity'/.test(line));

const nativePage = await browser.newPage();
const nativeLines = [];
nativePage.on('console', (message) => nativeLines.push(message.text()));
await nativePage.goto(PAGE);
await nativePage.waitForFunction(() => window.__sri, null, { timeout: 30000 });
const native = await nativePage.evaluate(() => window.__sri);
await nativePage.close();
const cases = Object.keys(native.events).sort();
ok(
	'natively: every case reported, and a bad hash fails',
	cases.length >= 25 &&
		native.events['markup-style-bad'] === 'error' &&
		native.events['dom-script-prop-bad'] === 'error' &&
		native.events['header-style'] === 'load',
	JSON.stringify(native.events),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const lines = [];
	page.on('console', (message) => lines.push(message.text()));
	await submitLanding(page, PAGE);
	let proxied = null;
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url()))
				proxied =
					(await frame.evaluate(() => window.__sri).catch(() => null)) ??
					proxied;
	}
	ok(`${mode}: the page ran`, proxied !== null);
	if (!proxied) {
		await page.close();
		continue;
	}
	const differ = cases.filter(
		(id) =>
			proxied.events[id] !== native.events[id] ||
			proxied.ran.includes(id) !== native.ran.includes(id),
	);
	ok(
		`${mode}: each element loads or fails as natively, and runs only then`,
		differ.length === 0,
		differ
			.map(
				(id) =>
					`${id}: native ${native.events[id]}${native.ran.includes(id) ? ' ran' : ''}, proxied ${proxied.events[id]}${proxied.ran.includes(id) ? ' ran' : ''}`,
			)
			.join('; '),
	);
	// a stylesheet that loads is applied (one that fails keeps an empty
	// sheet proxied where natively it has none: the worker's refusal is a
	// network error, see CHANGELOG)
	const sheetsDiffer = Object.keys(native.sheets).filter(
		(id) => native.sheets[id] && !proxied.sheets[id],
	);
	ok(
		`${mode}: every stylesheet that loads natively has its sheet`,
		sheetsDiffer.length === 0,
		sheetsDiffer.join(', '),
	);
	ok(
		`${mode}: the page reads its integrity back as natively`,
		JSON.stringify(proxied.readback) === JSON.stringify(native.readback),
		JSON.stringify(proxied.readback),
	);
	ok(
		`${mode}: the browser never hashed a rewritten response`,
		digestErrors(lines).length === 0,
		JSON.stringify(digestErrors(lines)),
	);
	await page.close();
}
await done(browser);
