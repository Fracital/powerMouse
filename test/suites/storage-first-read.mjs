// A new document's first reads of localStorage (an ad library's look at
// dozens of keys, most of them missing) take the store's keys and small
// values in one synchronous round trip, not one each, and read what native
// Chrome reads: present, missing, empty and large values, the length, the
// keys, and two frames' writes, removals and a clear seen by the other frame
// at once. A new document that writes a key and removes it before it reads
// (YouTube's availability check) takes the store whole all the same: its
// sixty reads were sixty round trips. Compared with the page loaded
// natively; both demo modes. A streamed document whose head reads the
// store while the worker is busy with its 2.5 MB body
// (test/stream-server.mjs `store`) asks the bridge nothing: its first read
// came with its markup (Client.primeStore), where the read spun until the
// worker was free. It reads the value a document before it wrote, and
// another frame's write after.
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

{
	const page = await openDemo(browser, PROXY);
	const sent = [];
	let watching = false;
	page.context().on('request', (request) => {
		if (watching && /\/xhr$/.test(new URL(request.url()).pathname))
			sent.push(request);
	});
	const frameWith = async (read) => {
		for (let i = 0; i < 120; i++) {
			for (const frame of page.frames()) {
				const value = await frame.evaluate(read).catch(() => null);
				if (value !== null && value !== undefined) return [frame, value];
			}
			await sleep(100);
		}
		return [null, null];
	};
	// a document before writes the key
	await submitLanding(page, `${FIXTURE}stream/sizes?wait=0`);
	const [writer] = await frameWith(() =>
		window.__done ? localStorage.setItem('stream-store', 'one') || 1 : null,
	);
	watching = true;
	await page.evaluate((url) => {
		const form = document.getElementById('omni');
		form.url.value = url;
		form.requestSubmit();
	}, `${FIXTURE}stream/store`);
	const [frame, head] = await frameWith(() =>
		window.__done && window.__store ? window.__store : null,
	);
	watching = false;
	const routes = (await bridgeRequests(page, sent))
		.map((request) => request?.data?.url)
		.map((url) => url && new URL(url).pathname.split('/').at(-1))
		.filter((route) => READS.includes(route));
	ok(
		"a streamed document's head reads the value a document before it wrote, and a missing key",
		!!writer && JSON.stringify(head) === JSON.stringify(['one', null]),
		JSON.stringify(head),
	);
	ok(
		'its head asked the bridge for none of its reads while the worker read its body',
		head !== null && routes.length === 0,
		JSON.stringify(routes),
	);
	// another frame of the origin writes; the document reads it
	const after = frame
		? await frame
				.evaluate(
					() =>
						new Promise((resolve) => {
							const other = document.createElement('iframe');
							other.src = '/stream/sizes?wait=0';
							other.onload = () => {
								other.contentWindow.localStorage.setItem('stream-store', 'two');
								resolve(localStorage.getItem('stream-store'));
							};
							document.body.append(other);
						}),
				)
				.catch((error) => String(error))
		: null;
	ok("and then another frame's write", after === 'two', JSON.stringify(after));
	await page.close();
}

await done(browser);
