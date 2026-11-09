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
//
// The writes the bridge cannot carry go to the worker asynchronously, and the
// reloaded page must read them all back however late they land: on a slow CI
// runner the 2 MiB write was missing after the reload (35 keys against
// native's 36), because the next document read before the worker had it. So
// every mode runs again with the worker reading the body of every
// asynchronous write LATE_MS late (2 keys of 36 read back, before the fix),
// and once more with the body of one overwrite never arriving: its key must
// then read as absent after the reload, never as the value it replaced.
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

const LATE_MS = 2500;
/** the overwrite whose body never arrives in the `lost` runs */
const LOST = 'mixed-second|';
/**
 * Trouble on the way to the service worker for the asynchronous storage
 * writes: `late` reads the body of every one LATE_MS late (its fetch event
 * arrives at once; reading it is what takes the time for a large one on a
 * slow runner), `lost` fails the body of the write of LOST
 */
const trouble = async (context, kind) => {
	for (let i = 0; i < 100 && !context.serviceWorkers().length; i++)
		await sleep(100);
	const workers = context.serviceWorkers();
	for (const worker of workers)
		await worker.evaluate(
			([kind, delay, lost]) => {
				const text = Request.prototype.text;
				for (const name of ['arrayBuffer', 'blob', 'json', 'text']) {
					const read = Request.prototype[name];
					Request.prototype[name] = async function () {
						const { pathname } = new URL(this.url);
						if (!/\/(local|session)Storage\/ordered$/.test(pathname))
							return read.call(this);
						if (kind === 'late')
							await new Promise((resolve) => setTimeout(resolve, delay));
						else if ((await text.call(this.clone())).includes(lost))
							throw new TypeError('Failed to fetch');
						return read.call(this);
					};
				}
			},
			[kind, LATE_MS, LOST],
		);
	return workers.length;
};
/** what natively reads back, less the key of the write that was lost */
const withoutLost = (read) => {
	if (!read) return read;
	const values = { ...read.values };
	delete values.orderMixed;
	return {
		keys: read.keys.filter((key) => key !== 'orderMixed'),
		values,
		length: read.length - 1,
	};
};

const summary = (result) => ({
	...result,
	tasks: undefined,
	oneTask: undefined,
});
for (const [mode, base, kind] of [
	['same-origin', PROXY],
	['same-origin with late writes', PROXY, 'late'],
	['same-origin with a lost write', PROXY, 'lost'],
	['isolated', HOST],
	['isolated with late writes', HOST, 'late'],
	['isolated with a lost write', HOST, 'lost'],
]) {
	const page = await openDemo(browser, base);
	if (kind)
		ok(
			`${mode}: the worker is in trouble`,
			(await trouble(page.context(), kind)) > 0,
		);
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
	if (kind === 'lost')
		ok(
			`${mode}: a lost write's key reads as absent, not as the value it replaced`,
			proxied?.read && !('orderMixed' in proxied.read.values),
			JSON.stringify(proxied?.read?.values?.orderMixed),
		);
	else
		ok(
			`${mode}: the last write of a key is the one read after the reload`,
			lastWins(proxied?.read?.values),
			JSON.stringify(proxied?.read?.values),
		);
	const expected = kind === 'lost' ? withoutLost(native?.read) : native?.read;
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
	same('the keys after the reload are', expected?.keys, proxied?.read?.keys);
	same(
		'every value after the reload reads',
		expected?.values,
		proxied?.read?.values,
	);
	same(
		'the length after the reload is',
		expected?.length,
		proxied?.read?.length,
	);
	await page.close();
}
await done(browser);
