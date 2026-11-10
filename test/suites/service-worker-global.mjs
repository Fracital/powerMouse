// An emulated service worker's global against a real one's
// (docs/service-workers.md): sw-global.js reports, from inside the worker,
// every own name of its global, whether each service worker interface's
// `prototype` is writable, each interface's source, what calling an event
// constructor without `new` throws, whether URL.createObjectURL is there,
// and its registration's members (what its cookieStore lists is reported
// too, compared once a service worker has one). The same fixture natively
// and through the proxy (`?sw`), both demo modes; the reports must match.
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

const target = `${FIXTURE}pages/deep/swg/sw-global.html`;
// a service worker's cookieStore comes once the page's (over Stomp's cookie
// jar) is on master: until then these are left out of the comparison
const PENDING = new Set(['CookieStore', 'cookieStore']);
const without = (value) =>
	value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(
				Object.entries(value).filter(([key]) => !PENDING.has(key)),
			)
		: value;
const ROUTED = /\/stomp\/[\w-]+\/html\//;

async function read(find) {
	let value = null;
	for (let i = 0; i < 160 && !value?.done; i++) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__swg)
			.catch(() => null);
	}
	return value ?? {};
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = (await read(() => nativePage.mainFrame())).report;
await nativeBrowser.close();
ok('natively, the worker reports its global', !!native, JSON.stringify(native));

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	await submitLanding(page, target);
	const proxied = (
		await read(() =>
			page.frames().findLast((frame) => ROUTED.test(frame.url())),
		)
	).report;
	const names = new Set(proxied?.names ?? []);
	const nativeNames = new Set(native?.names ?? []);
	const missing = [...nativeNames].filter(
		(name) => !names.has(name) && !PENDING.has(name),
	);
	const extra = [...names].filter((name) => !nativeNames.has(name));
	ok(
		`${mode}: the global has every name a service worker's has`,
		!!proxied && missing.length === 0,
		JSON.stringify(missing),
	);
	ok(
		`${mode}: the global has no name a service worker's lacks`,
		!!proxied && extra.length === 0,
		JSON.stringify(extra),
	);
	for (const key of [
		'prototypes',
		'sources',
		'calls',
		'objectURL',
		'registration',
	])
		ok(
			`${mode}: ${key} read as natively`,
			JSON.stringify(without(proxied?.[key])) ===
				JSON.stringify(without(native?.[key])),
			JSON.stringify({ proxied: proxied?.[key], native: native?.[key] }),
		);
	await page.close();
}
await done(browser);
