// localStorage writes that fit the native quota store (storage-quota.html).
// Discord's persist store writes several medium values in one task; through
// the proxy every small write was a synchronous beacon to the service worker,
// Chrome refuses a document's beacons once 64 KiB of them are in flight, and
// the writes after that threw QuotaExceededError, which natively only a write
// past the origin's 5 MiB does. The page writes a burst in one task (with
// overwrites of one key before and after it), a burst across tasks, a 1 MiB
// value and two writes that natively exceed the quota, then reloads itself
// in the task of its last write and reads every key back. Each result is
// compared with the page loaded natively, in both demo modes.
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

const target = `${FIXTURE}pages/storage-quota.html`;
const read = () =>
	window.__sq?.done
		? { written: window.__sq.written, read: window.__sq.read }
		: null;

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 80 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read).catch(() => null);
}
await nativePage.close();
const w = native?.written;
ok(
	'natively, every write that fits stores and both over-quota writes throw',
	w &&
		[...w.early, ...w.oneTask, ...w.late, ...w.tasks, w.large, w.fits].every(
			(result) => result === 'ok',
		) &&
		w.over === 'threw QuotaExceededError' &&
		w.alone === 'threw QuotaExceededError',
	JSON.stringify(w),
);
// a key written twice (or written and removed) in one task holds the last
const lastWins = (values) =>
	values?.orderSmall?.includes(':small-second:') &&
	values.orderEarly?.includes(':early-second:') &&
	values.orderLate?.includes(':late-second:') &&
	values.orderMixed?.includes(':mixed-second:') &&
	!('orderGone' in values);
ok(
	'natively, the last write of a key is the one read after the reload',
	lastWins(native?.read?.values),
	JSON.stringify(native?.read?.values),
);

const summary = (result) => ({
	...result,
	tasks: undefined,
	oneTask: undefined,
});
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	// the write phase's results, from the fragment the page reloaded with,
	// in case the read phase never ends
	let written;
	// the reload and the large writes take a while on a slow runner
	for (let i = 0; i < 240 && !proxied; i++) {
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
	ok(
		`${mode}: the last write of a key is the one read after the reload`,
		lastWins(proxied?.read?.values),
		JSON.stringify(proxied?.read?.values),
	);
	const p = proxied?.written;
	const same = (name, a, b) => {
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		ok(
			`${mode}: ${name} as natively`,
			x === y,
			x === y ? x.slice(0, 200) : `native ${x} proxied ${y}`,
		);
	};
	same('ten medium writes in one task store', w?.oneTask, p?.oneTask);
	same('twenty medium writes across five tasks store', w?.tasks, p?.tasks);
	same(
		'overwrites, the 1 MiB write and the over-quota writes end',
		summary(w),
		summary(p),
	);
	same(
		'the keys after the reload are',
		native?.read?.keys,
		proxied?.read?.keys,
	);
	same(
		'every value after the reload reads',
		native?.read?.values,
		proxied?.read?.values,
	);
	same(
		'the length after the reload is',
		native?.read?.length,
		proxied?.read?.length,
	);
	await page.close();
}
await done(browser);
