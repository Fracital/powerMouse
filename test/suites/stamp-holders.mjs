// The stamps the Cookies and Storage modules write in the proxy origin's own
// localStorage, which tell another document's copy of the jar or of a store
// that it is stale, are written only while a document of another realm holds
// such a copy: each one is a storage event in every document of the proxy
// origin, and apnews.com wrote 824 in 40 s (41,000 events in its documents)
// when 740 of them versioned a copy only the writer's own realm held. The
// page writes alone (no stamp), with a frame of its own origin that reads
// and writes (each sees the other's writes at once, as natively), and alone
// again once the frame is gone (no stamp). Every read is compared with
// native Chrome in both demo modes (a cookie another document wrote as the
// writer reads it natively, since another document's read may lag
// natively); the stamps are counted in the same-origin mode, where the
// demo's own page is a document of the proxy origin and hears them.
//
// Then a page whose pagehide listener reads the store and its cookies after
// STomp's realm left the lists (YouTube's does) is reloaded: the realm it
// leaves stays off them, so the reloaded page is the one realm on each list
// and its writes take no synchronous round trip. Every reload of YouTube
// put one more realm on the lists for good, and the next document's every
// write was a round trip.
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

const target = `${FIXTURE}pages/stamp-holders.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__sh).catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

// the cookie a document read of another's write, as the writer read it
const settled = (steps) =>
	steps?.map(([name, value]) =>
		name.includes('at once') && value.length === 3
			? [name, [value[0], value[1], value[1]]]
			: [name, value],
	);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the page ran to the end',
	native?.done && !native.error && native.steps.length === 6,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const marks = [];
	page.on('console', (message) => {
		const [word, step, at] = message.text().split(' ');
		if (word === 'STEP') marks.push([step, Number(at)]);
	});
	// the stamps, as the demo's page (a document of the proxy origin in the
	// same-origin mode) hears them
	await page.evaluate(() => {
		window.__stamps = [];
		addEventListener('storage', (event) => {
			if (
				event.key?.startsWith('$stomp$') &&
				!event.key.startsWith('$stomp$held:')
			)
				window.__stamps.push(Date.now());
		});
	});
	await submitLanding(page, target);
	const proxied = await report(page);
	await sleep(500);
	ok(
		`${mode}: the page ran to the end`,
		proxied?.done && !proxied.error,
		JSON.stringify(proxied),
	);
	const expected = settled(native?.steps);
	for (const [index, [name, value]] of (expected ?? []).entries()) {
		const got = proxied?.steps?.[index];
		ok(
			`${mode}: ${name}: read as natively`,
			JSON.stringify(got?.[1]) === JSON.stringify(value),
			JSON.stringify({ native: native.steps[index][1], proxied: got?.[1] }),
		);
	}
	if (mode === 'same-origin') {
		const stamps = await page.evaluate(() => window.__stamps);
		const at = Object.fromEntries(marks);
		const between = (from, to) =>
			stamps.filter((time) => time >= at[from] && time < at[to]).length;
		ok(
			`${mode}: the page's writes alone leave no stamp`,
			at.alone && at.frame && between('alone', 'frame') === 0,
			`${between('alone', 'frame')} stamps`,
		);
		ok(
			`${mode}: the page's writes once the frame is gone leave no stamp`,
			at.gone && at.end && between('gone', 'end') === 0,
			`${between('gone', 'end')} stamps`,
		);
		ok(
			`${mode}: writes while the frame holds copies stamp`,
			between('frame', 'gone') > 0,
			`${between('frame', 'gone')} stamps`,
		);
	}
	await page.close();
}

const reloadTarget = `${FIXTURE}pages/stamp-holders-reload.html`;
const WRITES = ['setItem', 'removeItem', 'clear'];
async function reloadReport(page, loads) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__shr).catch(() => null);
			if (value?.done && value.loads === loads) return value;
		}
	}
	return null;
}
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	let step = '';
	page.on('console', (message) => {
		if (message.text().startsWith('STEP ')) step = message.text().slice(5);
	});
	const sent = [];
	page.context().on('request', (request) => {
		if (step === 'load2' && /\/xhr$/.test(new URL(request.url()).pathname))
			sent.push(request);
	});
	await submitLanding(page, reloadTarget);
	const first = await reloadReport(page, 1);
	await sleep(500);
	await page.click('#toolReload');
	const second = await reloadReport(page, 2);
	ok(
		`${mode}: the page loaded and reloaded`,
		first && second,
		JSON.stringify({ first, second }),
	);
	ok(
		`${mode}: the reloaded page reads its own writes`,
		JSON.stringify(second?.steps) ===
			JSON.stringify([['the page reads its own writes', [null, '9', '2']]]),
		JSON.stringify(second?.steps),
	);
	const writes = [];
	for (const request of await bridgeRequests(page, sent)) {
		const url = request?.data?.url;
		const route = url && new URL(url).pathname.split('/').at(-1);
		if (WRITES.includes(route)) writes.push(route);
	}
	ok(
		`${mode}: the reloaded page's thirty writes take no synchronous round trip`,
		writes.length === 0,
		JSON.stringify(writes),
	);
	if (mode === 'same-origin') {
		// the demo's page is a document of the proxy origin: the lists are
		// in its localStorage
		const lists = await page.evaluate(() =>
			Object.keys(localStorage)
				.filter((key) => key.startsWith('$stomp$held:'))
				.map((key) => [key, localStorage.getItem(key)]),
		);
		const fixture = new URL(FIXTURE).hostname;
		const ours = lists.filter(([key]) => key.includes(fixture));
		ok(
			`${mode}: after the reload, one realm is on each list`,
			ours.length >= 2 &&
				ours.every(([, value]) => value && value.split(' ').length === 1),
			JSON.stringify(ours),
		);
	}
	await page.close();
}

await done(browser);
