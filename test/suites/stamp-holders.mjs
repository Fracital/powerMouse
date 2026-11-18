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

await done(browser);
