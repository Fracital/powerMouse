// Emulated service workers (docs/service-workers.md): a registration
// persists across loads, and update() compares the script's bytes. On the
// suite's own site (test/sw-site.mjs), update.html registers a worker that
// skips waiting and claims (step 1); a second load (step 2) finds the
// registration again, calls update() with the bytes unchanged (no new
// worker), then once the suite changed them, again: updatefound, and the
// new version runs installing, installed, activating, activated while the
// old goes redundant. The suite changes the bytes once more and navigates
// (step 3): the update check after the navigation installs them, and the new
// worker claims the page: the page asks the worker that controls it
// which version it is. Natively and through the proxy, in both demo modes,
// the logs must match.
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';
import { startSite } from '../sw-site.mjs';

const site = await startSite();
const ROUTED = /\/stomp\/[\w-]+\/html\//;
const url = (run, step) =>
	`${site.origin}/app/update.html?run=${run}&step=${step}`;

/** wait for the frame `find` gives to say `key` (on the page of `step`) */
async function wait(find, key, step, tries = 160) {
	let value = null;
	for (
		let i = 0;
		i < tries && !(value?.[key] && value.step === String(step));
		i++
	) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__sw)
			.catch(() => null);
	}
	return value ?? { log: [] };
}

/** both steps through `go` (a navigation) and `find` (the page's frame) */
async function both(run, go, find) {
	await go(url(run, 1));
	const first = await wait(find, 'done', 1);
	await go(url(run, 2));
	await wait(find, 'readyForBump', 2);
	site.bump(run);
	await find()?.evaluate(() => (window.__sw.bumped = true));
	const second = await wait(find, 'done', 2);
	site.bump(run);
	await go(`${url(run, 3)}&expect=2`);
	const third = await wait(find, 'done', 3);
	return [...first.log, ...second.log, ...third.log];
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
const native = await both(
	'native',
	(target) => nativePage.goto(target),
	() => nativePage.mainFrame(),
);
await nativeBrowser.close();
ok(
	'natively, the update fixture runs to its end',
	native.length === 6 && !native.some((line) => line.startsWith('fail')),
	JSON.stringify(native),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	let opened = false;
	const proxied = await both(
		mode,
		async (target) => {
			if (!opened) await submitLanding(page, target);
			else await submitOmni(page, target);
			opened = true;
			await sleep(500);
		},
		() => page.frames().findLast((frame) => ROUTED.test(frame.url())),
	);
	ok(
		`${mode}: the registration persists, and update() installs new bytes only, as natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		JSON.stringify({ proxied, native }),
	);
	ok(
		`${mode}: no proxied page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await site.close();
await done(browser);
