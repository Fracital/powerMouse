// The Referer of a navigation a frame's document starts itself, under that
// document's own referrer policy. A frame that goes to another origin is
// given a fresh browsing context by its parent (freshContext.ts), and the
// request went out under the parent's policy; a navigation under `origin`
// or `strict-origin` went out with no Referer at all (the browser strips
// the routed referrer to the proxy's origin). Covered: a meta refresh and a
// location write under no-referrer, unsafe-url, origin and the default,
// across origins and within one; a link's own `rel=noreferrer` and
// `referrerpolicy`; a srcdoc document (its own policy, its parent's
// address); a document sandboxed to an opaque origin (no referrer, for its
// navigation and its fetch). Every header is the one the fixture recorded,
// compared with the same page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/frame-referrers.html`;

async function report(page) {
	let value = null;
	for (let i = 0; i < 240 && !value; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				?.evaluate(() => window.__result)
				.catch(() => null);
			if (found) value = found;
		}
	}
	return value;
}

// the navigations compared, each with the Referer the fixture recorded
const cases = [
	'refresh no-referrer',
	'refresh unsafe-url',
	'location origin',
	'location default',
	'same-origin location origin',
	'same-origin refresh strict-origin',
	'link rel=noreferrer',
	'link referrerpolicy=unsafe-url',
	'srcdoc unsafe-url location',
	'opaque srcdoc location',
	'opaque srcdoc fetch',
];

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
const full = `${FIXTURE}pages/frame-referrers-child.html?`;
ok(
	'natively, each navigation carries the referrer its own document and link ask for',
	native?.['refresh no-referrer'] === null &&
		native?.['refresh unsafe-url'] === full &&
		native?.['location origin'] === FIXTURE &&
		native?.['same-origin location origin'] === FIXTURE &&
		native?.['link rel=noreferrer'] === null &&
		native?.['link referrerpolicy=unsafe-url'] === full &&
		native?.['srcdoc unsafe-url location'] === target &&
		native?.['opaque srcdoc location'] === null &&
		native?.['opaque srcdoc fetch'] === null,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	for (const name of cases)
		ok(
			`${mode}: ${name} sends the Referer it sends natively`,
			proxied?.[name] === native[name],
			JSON.stringify({ native: native[name], proxied: proxied?.[name] }),
		);
	await page.close();
}
await done(browser);
