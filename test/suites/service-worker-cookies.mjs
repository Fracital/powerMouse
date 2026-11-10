// An emulated service worker's cookieStore and cookie change events
// (docs/service-workers.md), over the proxy's jar, against a real one's.
// sw-cookies.html sets cookies at /, at the worker's directory and at
// /other/; its worker reports CookieStore's members, getAll() and get() by
// name, which `url` it may name (its script URL, relative, with a fragment
// or a query; not its scope, a URL in it, another path or origin), the
// errors of an empty get(), set() and delete() with a bad path, and its
// registration's cookie change subscriptions (one outside the scope
// refused). Then the page changes the cookies the worker subscribed to by
// name (by document.cookie and by its own cookieStore) and one it did not:
// the worker's cookiechange events, one per cookie with Chrome's members,
// must be the native ones. Both demo modes.
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

const target = `${FIXTURE}pages/deep/swc/sw-cookies.html`;
const ROUTED = /\/stomp\/[\w-]+\/html\//;

async function read(find) {
	let value = null;
	for (let i = 0; i < 200 && !value?.done; i++) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__swc)
			.catch(() => null);
	}
	return value ?? {};
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = await read(() => nativePage.mainFrame());
await nativeBrowser.close();
ok(
	'natively, the worker reports its cookieStore and three change events',
	!!native.report && native.events?.length === 3,
	JSON.stringify(native),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	await submitLanding(page, target);
	const proxied = await read(() =>
		page.frames().findLast((frame) => ROUTED.test(frame.url())),
	);
	const differences = Object.keys({ ...native.report, ...proxied.report })
		.filter(
			(key) =>
				JSON.stringify(native.report?.[key]) !==
				JSON.stringify(proxied.report?.[key]),
		)
		.map((key) => ({
			key,
			native: native.report?.[key],
			proxied: proxied.report?.[key],
		}));
	ok(
		`${mode}: cookieStore and the subscriptions answer as natively`,
		!!proxied.report && differences.length === 0,
		JSON.stringify(differences),
	);
	ok(
		`${mode}: the subscribed changes reach the worker as natively, one event per cookie`,
		JSON.stringify(proxied.events) === JSON.stringify(native.events),
		JSON.stringify({ proxied: proxied.events, native: native.events }),
	);
	ok(
		`${mode}: no proxied page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await done(browser);
