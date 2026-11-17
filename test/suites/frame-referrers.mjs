// The Referer of a navigation a frame's document starts itself, under that
// document's own referrer policy. A navigation under `origin` or
// `strict-origin` went out with no Referer at all (the browser strips the
// routed referrer to the proxy's origin). Covered: a location write under
// origin and the default across origins, a location write under origin and
// a meta refresh under strict-origin within one. Every header is the one the
// fixture recorded, compared with the same page loaded natively; both demo
// modes.
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
	'location origin',
	'location default',
	'same-origin location origin',
	'same-origin refresh strict-origin',
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
