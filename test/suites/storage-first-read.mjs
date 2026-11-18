// A new document's first reads of localStorage (an ad library's look at
// dozens of keys, most of them missing) take the store's keys and small
// values in one synchronous round trip, not one each, and read what native
// Chrome reads: present, missing, empty and large values, the length, the
// keys, and two frames' writes, removals and a clear seen by the other frame
// at once. Compared with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/storage-first-read.html`;
const READS = ['getItem', 'getItemPart', 'getSmall', 'getKeys'];

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__sfr).catch(() => null);
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
	'natively, the page ran to the end',
	native?.done && !native.error && native.steps.length === 12,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the synchronous bridge's calls while the new frame reads, by route
	let step = '';
	const calls = [];
	page.on('console', (message) => {
		if (message.text().startsWith('STEP ')) step = message.text().slice(5);
	});
	page.context().on('request', (request) => {
		if (step !== 'reads' || !/\/xhr$/.test(new URL(request.url()).pathname))
			return;
		try {
			const route = new URL(JSON.parse(request.postData()).data.url).pathname
				.split('/')
				.at(-1);
			if (READS.includes(route)) calls.push(route);
		} catch (error) {
			// not the bridge's
		}
	});
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: the page ran to the end`,
		proxied?.done && !proxied.error,
		JSON.stringify(proxied),
	);
	for (const [index, [name, value]] of (native?.steps ?? []).entries()) {
		const got = proxied?.steps?.[index];
		ok(
			`${mode}: ${name}: read as natively`,
			JSON.stringify(got?.[1]) === JSON.stringify(value),
			JSON.stringify({ native: value, proxied: got?.[1] }),
		);
	}
	// one for the keys and small values, one for the large value
	ok(
		`${mode}: a new frame's sixty reads of the store take at most three round trips`,
		calls.length > 0 && calls.length <= 3,
		JSON.stringify(calls),
	);
	await page.close();
}

await done(browser);
