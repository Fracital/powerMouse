// Messages between a page and its emulated service worker
// (docs/service-workers.md). sw-messages.html posts a ping its worker
// answers to the sender (event.source) and to every client
// (clients.matchAll), hands it a MessageChannel port, asks what it sees of
// its clients (matchAll with and without uncontrolled ones, workers,
// clients.get of its own id and of none), asks it to open a window, calls
// waitUntil after the handler, and posts what cannot be cloned. Each side
// logs the event's class, origin, source and ports. Against the same page
// natively, both demo modes; the logs must match.
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

const target = `${FIXTURE}pages/deep/swm/sw-messages.html`;
const ROUTED = /\/stomp\/[\w-]+\/html\//;

async function wait(find) {
	let value = null;
	for (let i = 0; i < 160 && !value?.done; i++) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__sw)
			.catch(() => null);
	}
	return value ?? { log: [] };
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = (await wait(() => nativePage.mainFrame())).log;
await nativeBrowser.close();
ok(
	'natively, the messages fixture runs to its end',
	native.length === 7 && !native.some((line) => line.startsWith('fail')),
	JSON.stringify(native),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	await submitLanding(page, target);
	const proxied = (
		await wait(() =>
			page.frames().findLast((frame) => ROUTED.test(frame.url())),
		)
	).log;
	const differences = [];
	for (let i = 0; i < Math.max(native.length, proxied.length); i++)
		if (native[i] !== proxied[i])
			differences.push({ native: native[i], proxied: proxied[i] });
	ok(
		`${mode}: every message, its source, origin and ports, and the clients API read as natively`,
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
