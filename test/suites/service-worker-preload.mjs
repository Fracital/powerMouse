// Navigation preload (docs/service-workers.md): an emulated worker that turns
// it on gets, for each navigation it controls, the preload request's answer
// as `event.preloadResponse`, sent while it starts, with the registration's
// Service-Worker-Navigation-Preload header and the navigation's own
// destination and mode. On the suite's own site (test/sw-site.mjs),
// preload.html registers such a worker (step 1), then loads again with the
// worker passing the preload on unread (`pass`), reading it and answering
// with its own copy (`read`), describing it (`kind`), and leaving the load
// alone (`none`). Natively and through the proxy, both demo modes: what
// each page shows and the requests the site got must match.
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
const HOWS = ['register', 'pass', 'read', 'kind', 'none'];
const url = (run, step) =>
	`${site.origin}/app/preload.html?run=${run}&step=${step + 1}&how=${HOWS[step]}`;

async function wait(find, step, tries = 160) {
	const expect = step === 0 ? 'registered' : `load ${HOWS[step]}`;
	let value = null;
	for (let i = 0; i < tries; i++) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__sw)
			.catch(() => null);
		if (value?.done && value.log.at(-1)?.startsWith(expect)) break;
		if (value?.done && value.log.some((line) => line.startsWith('fail'))) break;
	}
	return value ?? { log: [] };
}

async function steps(run, go, find) {
	const log = [];
	for (const step of HOWS.keys()) {
		await go(url(run, step));
		log.push(...(await wait(find, step)).log);
	}
	// what reached the site: a step and its preload header per request
	return { log, requests: site.preloadRequests(run) };
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
	'natively, the worker gets each navigation preload',
	native.log.length === HOWS.length &&
		native.log.some((line) => line.startsWith('load pass SERVED stomp-test')) &&
		!native.log.some((line) => line.startsWith('fail')),
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
		`${mode}: each load shows what natively it shows`,
		JSON.stringify(proxied.log) === JSON.stringify(native.log),
		JSON.stringify({ proxied: proxied.log, native: native.log }),
	);
	ok(
		`${mode}: the site gets the same requests, preload header included`,
		JSON.stringify(proxied.requests) === JSON.stringify(native.requests),
		JSON.stringify({ proxied: proxied.requests, native: native.requests }),
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
