// The pageswap event's activation (where the outgoing document is going):
// natively null when the navigation is to another origin or set out for
// another origin and was redirected back, so a page never reads the URL
// another site sent its visitor on to (an OAuth code). Every route is
// same-origin to the browser, so the proxy says null itself. A top-level
// test/pages/pageswap.html sends it to the fixture's log, natively and
// proxied, for each case.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const own = new URL(FIXTURE).origin;
const other = own.replace('127.0.0.1', 'localhost');
const target = (origin) => `${origin}/pages/pageswap-target.html?code=1`;
const CASES = {
	same: target(own),
	cross: target(other),
	redirect: `${other}/sop/r?k=pageswap&type=text&redirect=${encodeURIComponent(target(own))}`,
};
const start = (go, key) =>
	`${FIXTURE}pages/pageswap.html?k=${key}&go=${encodeURIComponent(go)}`;
const swapped = async (key) => {
	for (let i = 0; i < 60; i++) {
		const log = await (await fetch(`${FIXTURE}sop/log?k=${key}`)).json();
		if (log.length) return JSON.parse(log.at(-1).custom);
		await sleep(250);
	}
	return 'no pageswap';
};

const native = {};
for (const [name, go] of Object.entries(CASES)) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(start(go, `pageswap-native-${name}`));
	native[name] = await swapped(`pageswap-native-${name}`);
	await context.close();
}

const proxied = {};
for (const [name, go] of Object.entries(CASES)) {
	const page = await openDemo(browser);
	await submitLanding(page, start(go, `pageswap-proxied-${name}`));
	proxied[name] = await swapped(`pageswap-proxied-${name}`);
	await page.close();
}

for (const name of Object.keys(CASES))
	ok(
		`${name}: the activation as native`,
		JSON.stringify(proxied[name]).replaceAll('-proxied-', '-native-') ===
			JSON.stringify(native[name]),
		`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied[name])}`,
	);

await done(browser);
