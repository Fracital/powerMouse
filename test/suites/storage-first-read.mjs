// A new document's first reads of localStorage (an ad library's look at
// dozens of keys, most of them missing) take the store's keys and small
// values in one synchronous round trip, not one each, and read what native
// Chrome reads: present, missing, empty and large values, the length, the
// keys, and two frames' writes, removals and a clear seen by the other frame
// at once. A new document that writes a key and removes it before it reads
// (YouTube's availability check) takes the store whole all the same: its
// sixty reads were sixty round trips. Compared with the page loaded
// natively; both demo modes.
import {
	bridgeRequests,
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
	native?.done && !native.error && native.steps.length === 13,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the synchronous bridge's calls while the new frame reads, by route
	let step = '';
	const calls = { reads: [], written: [] };
	page.on('console', (message) => {
		if (message.text().startsWith('STEP ')) step = message.text().slice(5);
	});
	const sent = [];
	page.context().on('request', (request) => {
		if (!calls[step] || !/\/xhr$/.test(new URL(request.url()).pathname)) return;
		sent.push([step, request]);
	});
	await submitLanding(page, target);
	const proxied = await report(page);
	// the bridge's request rides in the beacon's URL, sealed, or in its body
	const carried = await bridgeRequests(
		page,
		sent.map(([, request]) => request),
	);
	for (const [at, request] of carried.entries()) {
		const url = request?.data?.url;
		const route = url && new URL(url).pathname.split('/').at(-1);
		if (READS.includes(route)) calls[sent[at][0]].push(route);
	}
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
		calls.reads.length > 0 && calls.reads.length <= 3,
		JSON.stringify(calls.reads),
	);
	ok(
		`${mode}: and those of a frame that wrote first, at most three`,
		calls.written.length > 0 && calls.written.length <= 3,
		JSON.stringify(calls.written),
	);
	await page.close();
}

await done(browser);
