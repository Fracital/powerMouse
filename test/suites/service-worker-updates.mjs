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
// which version it is. Then imports.html does the same with a worker that
// imports a script (importScripts under /impc/, a static import under
// /impm/) and a change to the imported script's bytes only: Chrome compares
// every script the worker imported, and installs the new version. Before
// that, a worker whose imported script redirects: Chrome refuses it (and
// the proxy must never hand the redirect to the browser, which would load
// the script unrewritten). Natively and through the proxy, in both demo
// modes, the logs must match.
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

/** imports.html under `dir` through `go` and `find`: an update that changes an imported script only */
async function imports(dir, run, go, find) {
	const page = (step) =>
		`${site.origin}/${dir}/imports.html?run=${run}&step=${step}`;
	await go(page('moved'));
	const moved = await wait(find, 'done', 'moved');
	await go(page(1));
	const first = await wait(find, 'done', 1);
	await go(page(2));
	await wait(find, 'readyForBump', 2);
	site.bumpImport(dir, run);
	await find()?.evaluate(() => (window.__sw.bumped = true));
	const second = await wait(find, 'done', 2);
	return [...moved.log, ...first.log, ...second.log];
}
const IMPORTS = [
	['impc', 'importScripts'],
	['impm', 'a static import'],
];

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
const nativeImports = {};
for (const [dir, what] of IMPORTS) {
	nativeImports[dir] = await imports(
		dir,
		'native',
		(target) => nativePage.goto(target),
		() => nativePage.mainFrame(),
	);
	ok(
		`natively, a change to ${what}'s script only installs a new version`,
		nativeImports[dir].length === 7 &&
			nativeImports[dir].at(-1) === `imported ${dir} 1` &&
			!nativeImports[dir].some((line) => line.startsWith('fail')),
		JSON.stringify(nativeImports[dir]),
	);
}
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
for (const [mode, base, query = ''] of [
	['same-origin', PROXY],
	['isolated', HOST],
	// every state event reaches the page 300 ms after the answers to its
	// calls: a registration object must already show what an event or a
	// resolved promise says (ready, updatefound, statechange)
	['same-origin, events 300 ms late', PROXY, '&swdelay=300'],
]) {
	// a browser of its own: the same-origin run's registration stays in
	// the proxy origin's storage
	const own = query ? await launch() : browser;
	const page = await openDemo(own, `${base}?sw${query}`);
	let opened = false;
	const proxied = await both(
		query ? 'delayed' : mode,
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
	if (!query)
		for (const [dir, what] of IMPORTS) {
			const log = await imports(
				dir,
				mode,
				(target) => submitOmni(page, target).then(() => sleep(500)),
				() => page.frames().findLast((frame) => ROUTED.test(frame.url())),
			);
			ok(
				`${mode}: a change to ${what}'s script only installs a new version, as natively`,
				JSON.stringify(log) === JSON.stringify(nativeImports[dir]),
				JSON.stringify({ proxied: log, native: nativeImports[dir] }),
			);
		}
	ok(
		`${mode}: no proxied page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
	if (own !== browser) await own.close();
}
await site.close();
await done(browser);
