// A write sent asynchronously after one that has landed, before the page
// has seen it land (storage-turns.html). The worker applies a document's
// asynchronous writes in order, and forgot a document once none of its
// writes was left. The page names the oldest write it has in flight, which
// can be one that landed already, so the next write waited 10 s for it and
// every read meanwhile waited 3 s: Discord's login took 23 s instead of 3.
// The reads and their times, before and after a reload in the task of the
// last write, are compared with the page loaded natively, in both demo
// modes.
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

const target = `${FIXTURE}pages/storage-turns.html`;
const read = () =>
	window.__st?.done
		? { written: window.__st.written, read: window.__st.read }
		: null;
// a read through the proxy is a round trip to the service worker; a read
// held behind a write takes seconds
const SLOW_MS = 1500;
const values = (result) => ({
	written: result?.written?.second?.value,
	unrelated: result?.written?.unrelated?.value,
	second: result?.read?.second?.value,
	large: result?.read?.large?.value,
});
const times = (result) => [
	result?.written?.unrelated?.ms,
	result?.written?.second?.ms,
	result?.read?.second?.ms,
	result?.read?.large?.ms,
];

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 80 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read).catch(() => null);
}
await nativePage.close();
ok(
	'natively, both writes read back at once, before and after the reload',
	native &&
		JSON.stringify(values(native)) ===
			JSON.stringify({
				written: '12:second',
				unrelated: null,
				second: '12:second',
				large: `${6 + 60 * 1024}:large|`,
			}) &&
		times(native).every((ms) => ms < SLOW_MS),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	let written;
	for (let i = 0; i < 160 && !proxied; i++) {
		await sleep(250);
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))) {
			const fragment = frame.url().split('#read:')[1];
			if (fragment) written ??= JSON.parse(decodeURIComponent(fragment));
			proxied ??= await frame.evaluate(read).catch(() => null);
		}
	}
	ok(`${mode}: the page writes, reloads and reads back`, !!proxied);
	if (!proxied && written) proxied = { written };
	const x = JSON.stringify(values(native));
	const y = JSON.stringify(values(proxied));
	ok(
		`${mode}: every read answers as natively`,
		x === y,
		x === y ? y : `native ${x} proxied ${y}`,
	);
	ok(
		`${mode}: no read waits for a write that landed`,
		times(proxied).every((ms) => ms !== undefined && ms < SLOW_MS),
		JSON.stringify(times(proxied)),
	);
	await page.close();
}
await done(browser);
