// Emulated service workers take navigations (docs/service-workers.md): a
// document within a registration's scope is controlled from its first
// script, and the worker answers the navigation itself, so a cache-first
// app opens while its site is unreachable. On the suite's own site
// (test/sw-site.mjs), offline.html registers a worker that precaches the
// app (step 1), loads again with the site up (step 2: controlled from the
// start, `ready`, its stylesheet and data through the worker), then with
// the site's server dropping every connection (step 3): the worker answers
// the document from its cache, and the proxied page still runs with Stomp's
// inject (it reads its real URL, its stylesheet applies, its data comes out
// of the cache). Natively and through the proxy, both demo modes; the logs
// must match.
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
	`${site.origin}/app/offline.html?run=${run}&step=${step}`;

async function wait(find, step, tries = 160) {
	let value = null;
	for (let i = 0; i < tries; i++) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__sw)
			.catch(() => null);
		if (value?.done && value.log[0]?.startsWith(`start ${step}`)) break;
	}
	return value ?? { log: [] };
}

async function steps(run, go, find) {
	const log = [];
	for (const step of [1, 2, 3]) {
		if (step === 3) site.offline();
		await go(url(run, step));
		log.push(...(await wait(find, step)).log);
	}
	site.online();
	return log;
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
const native = await steps(
	'native',
	(target) => nativePage.goto(target).catch(() => {}),
	() => nativePage.mainFrame(),
);
await nativeBrowser.close();
ok(
	'natively, the offline app opens from its cache',
	native.length === 10 &&
		native.some((line) => line.startsWith('start 3 activated')) &&
		!native.some((line) => line.startsWith('fail')),
	JSON.stringify(native),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	let opened = false;
	const proxied = await steps(
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
		`${mode}: controlled from the first script on a reload, and opened from the worker's cache offline, as natively`,
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
