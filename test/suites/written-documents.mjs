// Whole documents a page writes into windows it made load through the proxy
// (written-documents.html): an editor frame (<iframe src=""> written once
// it loads, as CKEditor 4 does) and a popup its opener writes into without
// opening it first. Neither document has a service worker: what the page
// writes is copied on the elements the parser makes, so the stylesheet and
// the image load as natively, and nothing loads past the proxy. Compared
// with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/written-documents.html`;
const host = new URL(FIXTURE).host;

async function report(page) {
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__written)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, both written documents load',
	native?.frame?.image === true && native?.popup?.image === true,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, target);
	const proxied = await report(page);
	await sleep(500);
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === host)
		.map((entry) => entry.url.replace(/^.*written=/, ''));
	ok(
		`${mode}: nothing a page writes into its windows loads past the proxy`,
		raw.length === 0,
		JSON.stringify([...new Set(raw)]),
	);
	for (const name of ['frame', 'popup']) {
		const loads = (value) => ({ color: value?.color, image: value?.image });
		ok(
			`${mode}: the ${name}'s written stylesheet and image load, as natively`,
			JSON.stringify(loads(proxied?.[name])) ===
				JSON.stringify(loads(native?.[name])),
			JSON.stringify({ native: native?.[name], proxied: proxied?.[name] }),
		);
	}
	await page.close();
}
await done(browser);
