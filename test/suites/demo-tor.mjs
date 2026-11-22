// The homepage Tor control: Tor mode is the in-browser Tor client
// (docs/tor-over-wisp.md), a profile of its own on a service worker scope
// of its own. The suites cannot reach the Tor network (and Tor could not
// reach the fixture), so the suite's server answers Tor mode with a
// stand-in, epoxy over the demo's /wisp/ (STOMP_TOR_CLIENT=stand-in,
// demo/public/test/tor-stand-in.mjs): what is checked is the
// page's selection of Tor mode's transport, its scope, its profile and
// what it turns off, not Tor. test/tor-client-smoke.mjs runs the real
// client against the real Tor network.
/* global TOR_REQUESTED, TOR_CLIENT, DIRECTORY, CACHE, HTTP3, WEB_TRANSPORT, JUST_CALL, wispURL */
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
	waitForServer,
} from '../lib.mjs';

await waitForServer(PROXY);
const browser = await launch();
const errors = [];

/** the ordinary scope the page should be on */
const ordinary = (state) => state.dial?.directory ?? '/stomp/';
/** the Tor mode's scope */
const torScope = (state) => state.dial?.torDirectory ?? '/stomp-tor/';

async function until(page, read, want, limit = 25000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < limit) {
		value = await page.evaluate(read).catch(() => null);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

const read = () => ({
	status: document.getElementById('logMsg')?.textContent ?? '',
	requested: TOR_REQUESTED,
	client: TOR_CLIENT,
	endpoint: TOR_REQUESTED && TOR_CLIENT ? wispURL() : null,
	directory: DIRECTORY,
	// the page dials (docs/dialing.md): its scopes are the server's neutral
	// ones, the classic tabs' /stomp/ and /stomp-tor/
	dial: JUST_CALL ? (globalThis.STOMP_CONFIG?.dial ?? null) : null,
	cache: CACHE,
	http3: HTTP3,
	webTransport: WEB_TRANSPORT,
	checked: document.getElementById('tor')?.checked,
	disabled: document.getElementById('tor')?.disabled,
	stored: localStorage.getItem('stomp-demo:tor'),
});

/** Tor now lives in the shared Proxy submenu of the home Settings menu. */
async function toggleTor(page) {
	await page.click('#settingsTab');
	await page.click('#menuProxy');
	await page.click('#tor');
}

for (const [name, origin] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(origin);
	let state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		`${name}: Tor starts off and the ordinary controller keeps its route`,
		state.requested === false &&
			state.directory === ordinary(state) &&
			state.checked === false &&
			state.disabled === false &&
			state.cache === true,
		JSON.stringify(state),
	);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		toggleTor(page),
	]);
	state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		`${name}: Tor takes a separate worker scope and the Tor client's transport`,
		state.requested === true &&
			state.checked === true &&
			state.stored === '1' &&
			state.directory === torScope(state) &&
			state.client === true &&
			state.endpoint?.includes('/wisp/') &&
			// its own HTTP cache, in the Tor profile (gone with it)
			state.cache === true &&
			state.http3 === false &&
			state.webTransport === false,
		JSON.stringify(state),
	);
	await submitLanding(page, `${FIXTURE}pages/bookmark-a.html`);
	const shown = await until(
		page,
		() =>
			[...document.querySelectorAll('#frames iframe')].some(
				(iframe) => !iframe.classList.contains('hidden'),
			),
		Boolean,
	);
	// (the active frame while the title comes: a dialed tab's first document
	// takes a frame of its own in the place of the one it had)
	const frame = shown
		? await waitActive(page, () => document.title === 'Bookmark A').catch(() =>
				activeFrame(page),
			)
		: null;
	const title = frame
		? await frame.evaluate(() => document.title).catch(() => null)
		: null;
	ok(
		`${name}: proxied page contents load over Tor mode's transport`,
		title === 'Bookmark A',
		title,
	);
	await page.click('#home');
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		toggleTor(page),
	]);
	state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		`${name}: turning Tor off returns to the ordinary scope`,
		state.requested === false &&
			state.checked === false &&
			state.directory === ordinary(state) &&
			state.stored === '0' &&
			state.cache === true,
		JSON.stringify(state),
	);
	await context.close();
}

// Tor mode is a profile of its own (src/profile.ts, docs/tor.md
// "Profiles"): a site's cookies, localStorage, IndexedDB and Cache Storage
// in one mode are not in the other, every store the Tor mode opens on the
// origin is named in its profile and none of the normal mode's, and the
// profile is gone once no tab is in Tor mode: turned off in its tab, or its
// last tab closed while a normal one is open.
const PROFILE_MARK = /\|tor$/;
/** what this origin keeps, read with no hook in the way */
const inventory = async () => {
	const dirs = [];
	try {
		for await (const name of (await navigator.storage.getDirectory()).keys())
			dirs.push(decodeURIComponent(name));
	} catch {
		// no origin private file system here
	}
	return {
		dbs: (await indexedDB.databases()).map((info) => info.name),
		caches: await caches.keys(),
		keys: Object.keys(localStorage),
		session: Object.keys(sessionStorage),
		dirs,
		workers: (await navigator.serviceWorker.getRegistrations()).map(
			(registration) =>
				(registration.active ?? registration.waiting ?? registration.installing)
					?.scriptURL ?? '',
		),
	};
};
const torNames = (stores) =>
	[
		...stores.dbs,
		...stores.caches,
		...stores.keys,
		...stores.session,
		...stores.dirs,
	].filter((name) => PROFILE_MARK.test(name) || /%7Ctor$/i.test(name));
const writeSite = async (mode) => {
	document.cookie = `mode=${mode}; max-age=3600; path=/`;
	localStorage.setItem('mode', mode);
	await new Promise((resolve, reject) => {
		const open = indexedDB.open(`${mode}db`);
		open.onupgradeneeded = () => open.result.createObjectStore('s');
		open.onsuccess = () => {
			open.result.close();
			resolve();
		};
		open.onerror = () => reject(open.error);
	});
	await caches.open(`${mode}cache`);
};
const readSite = async () => ({
	cookie: document.cookie,
	local: localStorage.getItem('mode'),
	dbs: (await indexedDB.databases()).map((info) => info.name).sort(),
	caches: (await caches.keys()).sort(),
});
async function siteFrame(page, url, title) {
	await page.click('#home').catch(() => {});
	await submitLanding(page, url);
	try {
		return await waitActive(
			page,
			`document.title === ${JSON.stringify(title)}`,
		);
	} catch (error) {
		const frame = await activeFrame(page);
		const shown = frame
			? await frame
					.evaluate(() => [
						document.title,
						document.body?.innerText.slice(0, 600),
					])
					.catch(String)
			: null;
		const status = await page.evaluate(read).catch(String);
		throw new Error(
			`${title} did not load: ${JSON.stringify({ shown, status, frames: page.frames().map((f) => f.url()) })}`,
			{ cause: error },
		);
	}
}

for (const [name, origin] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	// the origin STomp's stores are on: the page's own, or the controller
	// frame's on the proxy origin
	const storesOf = async (target) => {
		const own = await target.evaluate(inventory);
		if (name === 'same-origin') return own;
		const frame = target
			.frames()
			.find((frame) => /controllerFrame\.html/.test(frame.url()));
		const proxy = frame ? await frame.evaluate(inventory) : null;
		return {
			dbs: [...own.dbs, ...(proxy?.dbs ?? [])],
			caches: [...own.caches, ...(proxy?.caches ?? [])],
			keys: [...own.keys, ...(proxy?.keys ?? [])],
			session: [...own.session, ...(proxy?.session ?? [])],
			dirs: [...own.dirs, ...(proxy?.dirs ?? [])],
			workers: [...own.workers, ...(proxy?.workers ?? [])],
		};
	};
	await page.goto(`${origin}?notor`);
	await until(page, read, (value) => /^Ready/.test(value?.status));
	let frame = await siteFrame(
		page,
		`${FIXTURE}pages/bookmark-a.html`,
		'Bookmark A',
	);
	await frame.evaluate(writeSite, 'normal');
	const normal = await frame.evaluate(readSite);
	const before = await storesOf(page);
	ok(
		`${name}: the normal profile keeps a site's data under its own names`,
		/mode=normal/.test(normal.cookie) &&
			normal.local === 'normal' &&
			normal.dbs.includes('normaldb') &&
			normal.caches.includes('normalcache') &&
			torNames(before).length === 0,
		JSON.stringify({ normal, tor: torNames(before) }),
	);

	// Tor mode: none of it, and what it keeps is its profile's alone
	await page.goto(`${origin}?tor=1`);
	await until(page, read, (value) => /^Ready/.test(value?.status));
	frame = await siteFrame(
		page,
		`${FIXTURE}pages/bookmark-b.html`,
		'Bookmark B',
	);
	const fresh = await frame.evaluate(readSite);
	await frame.evaluate(writeSite, 'tor');
	const tor = await frame.evaluate(readSite);
	const during = await storesOf(page);
	const added = (list, was) => list.filter((item) => !was.includes(item));
	const opened = [
		...added(during.dbs, before.dbs),
		...added(during.caches, before.caches),
		...added(during.keys, before.keys),
	];
	ok(
		`${name}: Tor mode sees none of the normal profile's site data`,
		!/mode=normal/.test(fresh.cookie) &&
			fresh.local === null &&
			!fresh.dbs.includes('normaldb') &&
			!fresh.caches.includes('normalcache'),
		JSON.stringify(fresh),
	);
	ok(
		`${name}: what Tor mode keeps is its own (cookie, storage, IndexedDB, Cache Storage)`,
		/mode=tor/.test(tor.cookie) &&
			tor.local === 'tor' &&
			tor.dbs.includes('tordb') &&
			tor.caches.includes('torcache'),
		JSON.stringify(tor),
	);
	ok(
		`${name}: every store Tor mode opened on the origin is its profile's, none shared`,
		opened.length > 0 &&
			opened.every((store) => PROFILE_MARK.test(store)) &&
			// no store of the normal profile was opened in Tor mode
			during.dbs.filter((store) => !PROFILE_MARK.test(store)).length ===
				before.dbs.length &&
			during.caches.filter((store) => !PROFILE_MARK.test(store)).length ===
				before.caches.length &&
			during.workers.some((url) => /profile=tor/.test(url)),
		JSON.stringify({ opened, during, before }),
	);

	// turned off in its tab: the Tor profile is gone, the normal one stays
	await page.goto(`${origin}?notor`);
	await until(page, read, (value) => /^Ready/.test(value?.status));
	let after = null;
	for (let i = 0; i < 80; i++) {
		after = await storesOf(page);
		if (
			!torNames(after).length &&
			!after.workers.some((url) => /profile=tor/.test(url))
		)
			break;
		await sleep(250);
	}
	const visits = await page.evaluate(() =>
		localStorage.getItem('omnibox:visits'),
	);
	ok(
		`${name}: turning Tor mode off forgets its profile: no database, cache, key, directory or worker of it left`,
		torNames(after).length === 0 &&
			!after.workers.some((url) => /profile=tor/.test(url)),
		JSON.stringify({ left: torNames(after), workers: after.workers }),
	);
	ok(
		`${name}: Tor mode's history was never kept`,
		!String(visits ?? '').includes('bookmark-b.html'),
		String(visits).slice(0, 300),
	);
	frame = await siteFrame(
		page,
		`${FIXTURE}pages/bookmark-a.html`,
		'Bookmark A',
	);
	const kept = await frame.evaluate(readSite);
	ok(
		`${name}: the normal profile's site data outlives the Tor session`,
		/mode=normal/.test(kept.cookie) &&
			!/mode=tor/.test(kept.cookie) &&
			kept.local === 'normal' &&
			kept.dbs.includes('normaldb') &&
			!kept.dbs.includes('tordb'),
		JSON.stringify(kept),
	);

	// the last Tor tab closed while a normal one is open: gone after it
	const second = await context.newPage();
	second.on('pageerror', (error) => errors.push(error.message));
	await second.goto(`${origin}?tor=1`);
	await until(second, read, (value) => /^Ready/.test(value?.status));
	const torFrame = await siteFrame(
		second,
		`${FIXTURE}pages/bookmark-b.html`,
		'Bookmark B',
	);
	const again = await torFrame.evaluate(readSite);
	await torFrame.evaluate(writeSite, 'tor');
	const reopened = await storesOf(page);
	const open = torNames(reopened);
	const torWorker = (stores) =>
		stores.workers.find((url) => /profile=tor/.test(url));
	await second.close();
	for (let i = 0; i < 120; i++) {
		after = await storesOf(page);
		if (!torNames(after).length) break;
		await sleep(250);
	}
	ok(
		`${name}: a new Tor session starts empty, and closing its last tab forgets it`,
		!/mode=tor/.test(again.cookie) &&
			again.local === null &&
			open.length > 0 &&
			// a worker of its own, not the last session's (profileWorker)
			!!torWorker(reopened) &&
			torWorker(reopened) !== torWorker(during) &&
			torNames(after).length === 0 &&
			!after.workers.some((url) => /profile=tor/.test(url)),
		JSON.stringify({
			again,
			open,
			workers: [torWorker(during), torWorker(reopened)],
			left: torNames(after),
		}),
	);
	await context.close();
}

// The saved Tor choice remains selected on a deployment without Tor
// (STOMP_TOR_CLIENT=0: config.js has no torClient). It is not reinterpreted
// as direct Wisp, and the user can always turn it off.
{
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.route('**/config.js', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/javascript',
			body: 'globalThis.STOMP_CONFIG = {};',
		}),
	);
	await page.goto(`${PROXY}?tor=1&wt=1&http3=1`);
	let state = await until(page, read, (value) =>
		/Tor is not available/.test(value?.status),
	);
	ok(
		'no Tor client refuses Tor without falling back to direct browsing',
		state.requested === true &&
			state.client === false &&
			state.checked === true &&
			state.disabled === false &&
			state.directory === torScope(state) &&
			state.http3 === false &&
			state.webTransport === false,
		JSON.stringify(state),
	);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		toggleTor(page),
	]);
	state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		'the unavailable Tor toggle can be turned off to restore browsing',
		state.requested === false &&
			state.checked === false &&
			state.disabled === true &&
			state.directory === ordinary(state),
		JSON.stringify(state),
	);
	await context.close();
}

await browser.close();
ok('no page errors', errors.length === 0, JSON.stringify(errors));
done();
