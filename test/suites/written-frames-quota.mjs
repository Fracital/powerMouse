// A page that writes 32 ad frames in one task (frames with no src whose
// about:blank documents get two scripts from long ad server URLs, each
// reading localStorage and the cookies): every script runs, in order, and
// every read answers as natively. The synchronous bridge carried each
// script's copy and each read in a beacon's body, and Chrome lets a document
// have 64 KiB of those in flight, given back only between tasks: the copies
// spent it before any frame ran, so every read after threw
// QuotaExceededError and every script written after was dropped. Compared
// with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/written-frames-quota.html`;

async function report(page) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__wfq).catch(() => null);
			if (value?.done) return value;
		}
	}
	// the load never fired: what the frames did by then
	for (const frame of page.frames()) {
		const value = await frame.evaluate(() => window.__wfq).catch(() => null);
		if (value) return value;
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
const expected = Array.from({ length: 32 }, () => [
	['lib', ['v', true]],
	['ad', ['v', true]],
]);
ok(
	'natively, every frame ran both scripts in order and every read answered',
	native?.done &&
		!native.errors.length &&
		JSON.stringify(native.frames) === JSON.stringify(expected),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(`${mode}: the page loaded`, proxied?.done, JSON.stringify(proxied));
	ok(
		`${mode}: no frame's script threw`,
		proxied !== null && !proxied.errors.length,
		JSON.stringify(proxied?.errors.slice(0, 4)),
	);
	const ran = (proxied?.frames ?? []).filter(
		(frame, slot) =>
			JSON.stringify(frame) === JSON.stringify(native?.frames?.[slot]),
	).length;
	ok(
		`${mode}: every frame ran both scripts in order and read as natively`,
		ran === 32,
		`${ran} of 32: ${JSON.stringify(proxied?.frames?.find((frame, slot) => JSON.stringify(frame) !== JSON.stringify(native?.frames?.[slot])))}`,
	);
	await page.close();
}

await done(browser);
