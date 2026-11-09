// Range.createContextualFragment makes its nodes in the page's document, so
// an image in the fragment loads as it is parsed, inserted or not. Through
// the proxy every such load must reach the worker, none the site directly,
// and the markup reads back as written; compared with the page loaded
// natively, in both modes.
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

// a cross-site absolute URL: the fixture under its other name
const fixture = new URL(FIXTURE);
const cross = `http://localhost:${fixture.port}`;
const target = `${FIXTURE}pages/contextual-fragment.html`;
const CASES = ['kept', 'dropped', 'srcset', 'cross'];
const casesIn = (urls) =>
	new Set(urls.map((url) => /[?&]cf=([\w-]+)/.exec(url)?.[1]).filter(Boolean));

const browser = await launch();
const nativeContext = await browser.newContext();
await nativeContext.addInitScript(`window.__cross = ${JSON.stringify(cross)}`);
const nativeRequests = [];
nativeContext.on('request', (request) => nativeRequests.push(request.url()));
const nativePage = await nativeContext.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 40 && !native?.done; i++) {
	await sleep(250);
	native = await nativePage.evaluate(() => window.__cf).catch(() => null);
}
const nativeFired = casesIn(nativeRequests);
await nativeContext.close();
ok(
	'natively, every case loads as it is parsed',
	CASES.every((name) => nativeFired.has(name)),
	JSON.stringify([...nativeFired]),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page
		.context()
		.addInitScript(`window.__cross = ${JSON.stringify(cross)}`);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, target);
	let proxied = null;
	for (let i = 0; i < 80 && !proxied?.done; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url())) {
				const value = await frame.evaluate(() => window.__cf).catch(() => null);
				if (value?.done) proxied = value;
			}
	}
	const raw = recorder.raw().filter((entry) => /[?&]cf=/.test(entry.url));
	ok(
		`${mode}: no fragment load reaches a site past the proxy`,
		proxied?.done && raw.length === 0,
		JSON.stringify(raw.map((entry) => entry.url)),
	);
	const unrouted = recorder.log
		? recorder.log.filter(
				(entry) => entry.kind === 'proxy' && /[?&]cf=/.test(entry.url),
			)
		: [];
	ok(
		`${mode}: no fragment load reaches the proxy origin unrouted`,
		unrouted.length === 0,
		JSON.stringify(unrouted.map((entry) => entry.url)),
	);
	ok(
		`${mode}: a fragment parses in its range's context, and its script runs once inserted`,
		proxied?.row === native?.row && proxied?.ran === native?.ran,
		JSON.stringify({
			native: [native?.row, native?.ran],
			proxied: [proxied?.row, proxied?.ran],
		}),
	);
	ok(
		`${mode}: the fragment's markup reads back as written`,
		proxied?.markup === native?.markup && proxied?.src === native?.src,
		JSON.stringify({ native: native?.markup, proxied: proxied?.markup }),
	);
	await page.close();
}
await done(browser);
