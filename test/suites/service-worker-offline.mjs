// Emulated service workers take navigations (docs/service-workers.md): a
// document within a registration's scope is controlled from its first
// script, and the worker answers the navigation itself, so a cache-first
// app opens while its site is unreachable. On the suite's own site
// (test/sw-site.mjs), offline.html registers a worker that precaches the
// app (step 1), loads again with the site up (step 2: controlled from the
// start, `ready`, its stylesheet and data through the worker), then with
// the site's server dropping every connection (step 3): the worker answers
// the document from its cache, and the proxied page still runs with STomp's
// inject (it reads its real URL, its stylesheet applies, its data comes out
// of the cache). The same app under /mod/ has a module worker whose file
// list comes from the modules it imports, and every service worker is
// stopped before the load offline: the worker starts again from what was
// kept of it, its static imports included. Natively and through the proxy,
// both demo modes; the logs must match.
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
const url = (dir, run, step) =>
	`${site.origin}/${dir}/offline.html?run=${run}&step=${step}`;

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

/** every service worker of `page`'s browser stopped (STomp's own among them) */
async function stopWorkers(page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	await cdp.send('ServiceWorker.stopAllWorkers');
	await cdp.detach();
	await sleep(500);
}

async function steps(dir, run, go, find, stop) {
	const log = [];
	for (const step of [1, 2, 3]) {
		if (step === 3) {
			if (stop) await stop();
			site.offline();
		}
		await go(url(dir, run, step));
		log.push(...(await wait(find, step)).log);
	}
	site.online();
	return log;
}

// the classic worker as it is, the module worker started again offline
const VARIANTS = [
	['app', ''],
	['mod', ' (a module worker, stopped first)'],
];

const nativeBrowser = await launch();
const native = {};
for (const [dir, what] of VARIANTS) {
	const nativePage = await nativeBrowser.newPage();
	native[dir] = await steps(
		dir,
		'native',
		(target) => nativePage.goto(target).catch(() => {}),
		() => nativePage.mainFrame(),
		dir === 'mod' ? () => stopWorkers(nativePage) : null,
	);
	await nativePage.close();
	ok(
		`natively, the offline app opens from its cache${what}`,
		native[dir].length === 10 &&
			native[dir].some((line) => line.startsWith('start 3 activated')) &&
			!native[dir].some((line) => line.startsWith('fail')),
		JSON.stringify(native[dir]),
	);
}
await nativeBrowser.close();

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const [dir, what] of VARIANTS) {
		const page = await openDemo(browser, `${base}?sw`);
		let opened = false;
		const proxied = await steps(
			dir,
			mode,
			async (target) => {
				if (!opened) await submitLanding(page, target);
				else await submitOmni(page, target);
				opened = true;
				await sleep(500);
			},
			() => page.frames().findLast((frame) => ROUTED.test(frame.url())),
			dir === 'mod' ? () => stopWorkers(page) : null,
		);
		ok(
			`${mode}: controlled from the first script on a reload, and opened from the worker's cache offline, as natively${what}`,
			JSON.stringify(proxied) === JSON.stringify(native[dir]),
			JSON.stringify({ proxied, native: native[dir] }),
		);
		ok(
			`${mode}: no proxied page error${what}`,
			page.errors.length === 0,
			JSON.stringify(page.errors),
		);
		await page.close();
	}
}
await site.close();
await done(browser);
