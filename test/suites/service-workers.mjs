// Emulated service workers (docs/service-workers.md), with the demo's
// `?sw`: the ServiceWorkerContainer API and a registration's lifecycle as a
// page sees them, against the same fixture loaded natively. sw-lifecycle.html
// tries register() with a bad MIME type, a 404, a scope above the script, a
// script that throws, another origin and a data: URL (the browser's errors,
// word for word), then registers a worker that installs slowly and claims
// the page in its activate handler, and logs every event and state on the
// way (registered, updatefound, statechange, ready, controllerchange), what
// the worker's global looked like (it puts that in a cache the page reads),
// update() with the same bytes, getRegistration(s), the navigation preload
// stub, the registration's managers (a sync whose event reaches the worker,
// periodic sync refused, the payment manager, cookie change subscriptions,
// push as without the permission, a background fetch whose end event and
// records reach the worker) and unregister(). The proxied log must be the
// native one, line for line. Both demo modes.
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

const target = `${FIXTURE}pages/deep/swl/sw-lifecycle.html`;
const ROUTED = /\/stomp\/[\w-]+\/html\//;

/** the fixture's log, from the frame `find` picks */
async function readLog(page, find) {
	let value = null;
	for (let i = 0; i < 160 && !value?.done; i++) {
		await sleep(250);
		value = await find(page)
			?.evaluate(() => window.__sw)
			.catch(() => null);
	}
	return value ?? { log: [], done: false };
}

// natively: the page at the top of a fresh browser
const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = await readLog(nativePage, (page) => page.mainFrame());
await nativeBrowser.close();
ok(
	'natively, the lifecycle fixture runs to its end',
	native.done && !native.log.some((line) => line.startsWith('fail')),
	JSON.stringify(native.log),
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
	const page = await openDemo(browser, `${base}?sw${query}`);
	await submitLanding(page, target);
	const proxied = await readLog(page, (page) =>
		page.frames().findLast((frame) => ROUTED.test(frame.url())),
	);
	ok(
		`${mode}: the lifecycle fixture runs to its end`,
		proxied.done && !proxied.log.some((line) => line.startsWith('fail')),
		JSON.stringify(proxied.log),
	);
	const differences = [];
	const length = Math.max(native.log.length, proxied.log.length);
	for (let i = 0; i < length; i++) {
		const want = native.log[i];
		const got = proxied.log[i];
		if (want === got) continue;
		differences.push({ native: want, proxied: got });
	}
	ok(
		`${mode}: every call, event and state reads as natively, in the same order`,
		differences.length === 0,
		JSON.stringify(differences),
	);
	ok(
		`${mode}: no proxied page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await done(browser);
