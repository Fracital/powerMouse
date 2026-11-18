// The about:blank documents of an ad page's slots (frames with no src, which
// run the page's own bundle) read the page's cookies and localStorage from
// the copy the page holds: eight slots' first reads take no synchronous
// round trip, where each took its own. Every read shows what native Chrome
// shows, the page's and the slots' reads after one slot's writes and a
// removal included. Compared with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/blank-frame-reads.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__bfr).catch(() => null);
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
	native?.done && !native.error && native.steps.length === 4,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the synchronous bridge's calls in each step, by route
	let step = '';
	const calls = {};
	page.on('console', (message) => {
		if (message.text().startsWith('STEP ')) step = message.text().slice(5);
	});
	const sent = [];
	page.context().on('request', (request) => {
		if (!step || !/\/xhr$/.test(new URL(request.url()).pathname)) return;
		sent.push([step, request]);
	});
	await submitLanding(page, target);
	const proxied = await report(page);
	// the bridge's request rides in the beacon's URL, sealed, or in its body
	const carried = await bridgeRequests(
		page,
		sent.map(([, request]) => request),
	);
	for (const [at, [step]] of sent.entries()) {
		const url = carried[at]?.data?.url;
		if (!url) continue;
		(calls[step] ??= []).push(
			new URL(url).pathname.split('/').slice(-2).join('/'),
		);
	}
	ok(
		`${mode}: the page ran to the end`,
		proxied?.done && !proxied.error,
		JSON.stringify(proxied),
	);
	for (const [index, [name, value, writer]] of (
		native?.steps ?? []
	).entries()) {
		const got = proxied?.steps?.[index];
		// every document's cookies as the writer read them natively
		const expected =
			typeof writer !== 'number'
				? value
				: value.map(([, ...rest]) => [value[writer][0], ...rest]);
		ok(
			`${mode}: ${name}: read as natively`,
			JSON.stringify(got?.[1]) === JSON.stringify(expected),
			JSON.stringify({ native: value, writer, proxied: got?.[1] }),
		);
	}
	ok(
		`${mode}: eight slots' first reads of the cookies and the store take no round trip`,
		proxied !== null && !calls['slots read'],
		JSON.stringify(calls['slots read']),
	);
	await page.close();
}

await done(browser);
