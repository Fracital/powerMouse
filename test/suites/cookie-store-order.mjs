// document.cookie writes made together in one task reach a cookieStore
// change listener as natively: an event for each write, in the order
// written. The Cookie Store module diffed the jar once for all of them, so
// two deletes were reported in the jar's order (the cookie made first,
// first), a delete after a set before it, and a cookie set and deleted in
// one task, or set twice, as one change or none. Compared with native
// Chrome in both demo modes.
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

const target = `${FIXTURE}pages/cookie-store-order.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__cso).catch(() => null);
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
	'natively, each write is an event of its own, in the order written',
	JSON.stringify(native?.seen) ===
		JSON.stringify([
			'|1',
			'-a',
			'-seed',
			'|2',
			'+b=1',
			'-c',
			'|3',
			'|4',
			'+e=1',
			'-e',
			'|5',
			'+d=2',
			'+d=3',
		]),
	JSON.stringify(native?.seen),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: the listener hears the writes as natively`,
		JSON.stringify(proxied?.seen) === JSON.stringify(native?.seen),
		JSON.stringify({ native: native?.seen, proxied: proxied?.seen }),
	);
	await page.close();
}

await done(browser);
