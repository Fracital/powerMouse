// The referrer of an iframe's initial about:blank document, under a parent
// whose policy is origin (blank-referrer.html): its document.referrer is the
// parent's full URL whatever the policy, a fetch it makes sends no Referer
// (about:blank strips to no referrer), and a fetch that names a referrer
// sends it reduced by the inherited policy. No service worker controls the
// document, so its requests go through the parent's realm, which must not
// lend them the parent's referrer. Compared with the same page loaded
// natively; both demo modes.
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

async function reportOf(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__blankRef)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const url = `${FIXTURE}pages/blank-referrer.html`;
const origin = new URL(FIXTURE).origin;
const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(url);
const native = await reportOf(nativePage);
await nativePage.close();
ok(
	'natively, about:blank shows the full parent URL and its fetch sends no Referer',
	native?.documentReferrer === url &&
		native?.client === null &&
		native?.named === `${origin}/`,
	JSON.stringify(native),
);

const CHECKS = [
	['documentReferrer', "document.referrer is the parent's full URL"],
	['client', 'a fetch sends no Referer'],
	['named', 'a fetch that names a referrer sends it reduced by the policy'],
];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, url);
	const proxied = await reportOf(page);
	for (const [key, label] of CHECKS)
		ok(
			`${mode}: in about:blank, ${label}, as natively`,
			proxied !== null && proxied[key] === native?.[key],
			JSON.stringify({ native: native?.[key], proxied: proxied?.[key] }),
		);
	ok(
		`${mode}: the page throws nothing`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await done(browser);
