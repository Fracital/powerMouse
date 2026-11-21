// The browser's keys in the demo, pressed as a person's are (CDP
// Input.dispatchKeyEvent, which Chrome takes as it takes a keyboard's):
//  - Ctrl+R and F5 reload the tab, never the demo's own page (its
//    performance.timeOrigin stays), from the address bar and from inside
//    the proxied page, in a text field too;
//  - in the proxied page the key reaches the page first, and a page that
//    cancels it keeps it, as natively; the page reads defaultPrevented as
//    its own calls left it;
//  - Ctrl+Shift+R is Chrome's hard reload (Page.reload ignoreCache, the
//    native oracle): the document, its frame and their subresources reach
//    the site past the proxy's caches with Cache-Control: no-cache and
//    Pragma: no-cache, and a request after the load event is no part of
//    it; Ctrl+R revalidates the document alone;
//  - Ctrl+T opens the new tab page with its address bar focused, Ctrl+W
//    closes the tab, and Ctrl+Shift+T reopens the tabs closed, the last one
//    first, each where it was. In a window Chrome keeps these keys (Ctrl+T
//    opens Chrome's own tab), so they are pressed in fullscreen, where
//    Chrome hands them to the page and the demo also holds them with the
//    Keyboard Lock API.
/* global activateTab, closeTab, tabs -- the demo page's, in the functions evaluated there */
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
	submitOmni,
} from '../lib.mjs';

const KEYS_PAGE = `${FIXTURE}pages/browser-keys.html`;
const HARD_PAGE = `${FIXTURE}pages/hard-reload.html`;

const browser = await launch();

/** poll `read` (a function of the page, or of a frame) until `want(value)`, else the last value */
async function until(target, read, want, timeout = 30000, arg) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await target.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

/** Chrome's modifiers bits (CDP Input) */
const CTRL = 2;
const SHIFT = 8;

/** one press of `key` with `modifiers`, as the keyboard sends it */
async function press(cdp, key, modifiers = 0) {
	const letter = /^[a-z]$/i.test(key);
	const code = letter ? `Key${key.toUpperCase()}` : key;
	const vk = letter ? key.toUpperCase().charCodeAt(0) : { F5: 116 }[key];
	const event = {
		modifiers,
		key: letter && modifiers & SHIFT ? key.toUpperCase() : key,
		code,
		windowsVirtualKeyCode: vk,
		nativeVirtualKeyCode: vk,
	};
	await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

/** the active tab's proxied frame (a Playwright Frame) once `read` holds in it */
async function tabFrame(page, read = () => true, timeout = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const handle = await page.$('.frame:not(.hidden)');
		const frame = await handle?.contentFrame();
		if (frame && (await frame.evaluate(read).catch(() => false))) return frame;
		await sleep(150);
	}
	return null;
}

const timeOrigin = (target) => target.evaluate(() => performance.timeOrigin);

/** the fixture's counts and cache headers of a /pages/ file */
async function hitsOf(file) {
	const all = await (await fetch(`${FIXTURE}hits`)).json();
	return all[file] ?? { requests: 0, notModified: 0, asked: [] };
}

const HARD_FILES = [
	'hard-reload.html',
	'hard-reload.js',
	'hard-reload.css',
	'hard-reload-frame.html',
	'hard-reload-frame.js',
	'hard-reload-late.json',
];
/** what each of the hard-reload files was asked since `before` (hitsOf for each) */
async function askedSince(before) {
	const out = {};
	for (const file of HARD_FILES) {
		const now = await hitsOf(file);
		const count = now.requests - before[file].requests;
		out[file] = count ? now.asked.slice(-count) : [];
	}
	return out;
}
async function hardHits() {
	const out = {};
	for (const file of HARD_FILES) out[file] = await hitsOf(file);
	return out;
}
/** what a set of requests asked, as one comparable line per file */
const shape = (asked) =>
	Object.fromEntries(
		Object.entries(asked).map(([file, list]) => [
			file,
			list.map(
				(one) =>
					`${one.cacheControl ?? '-'}|${one.pragma ?? '-'}|${one.conditional ? 'conditional' : 'plain'}`,
			),
		]),
	);

// ---- native: what Chrome does with the reload keys and a hard reload ------

const native = await browser.newPage();
const nativeCdp = await native.context().newCDPSession(native);
await native.goto(`${KEYS_PAGE}?cancel`);
await native.click('#field');
let before = await timeOrigin(native);
await press(nativeCdp, 'r', CTRL);
await sleep(1500);
const nativeCancelKept = (await timeOrigin(native)) === before;
await native.goto(KEYS_PAGE);
await native.click('#field');
before = await timeOrigin(native);
await press(nativeCdp, 'r', CTRL);
const nativeReloads =
	(await until(
		native,
		(was) => performance.timeOrigin !== was,
		Boolean,
		10000,
		before,
	)) === true;
ok(
	'native: Ctrl+R in a text field reloads the page, and a page that cancels it keeps it',
	nativeReloads && nativeCancelKept,
	JSON.stringify({ nativeReloads, nativeCancelKept }),
);

await native.goto(HARD_PAGE);
await until(native, () => window.__late === true, Boolean);
let counted = await hardHits();
await nativeCdp.send('Page.reload', { ignoreCache: false });
await until(native, () => window.__late === true, Boolean);
await sleep(500);
const nativeReload = shape(await askedSince(counted));
counted = await hardHits();
await nativeCdp.send('Page.reload', { ignoreCache: true });
await until(native, () => window.__late === true, Boolean);
await sleep(500);
const nativeHard = shape(await askedSince(counted));
await native.close();

// ---- the demo ---------------------------------------------------------------

/** checks of one mode of the demo (isolated at HOST, same-origin at PROXY) */
async function reloadKeys(base, mode) {
	const page = await openDemo(browser, base);
	const cdp = await page.context().newCDPSession(page);
	const host = await timeOrigin(page);
	await submitLanding(page, KEYS_PAGE);
	let frame = await tabFrame(page, () => window.__origin > 0);
	ok(`${mode}: the fixture page opens in a tab`, !!frame);
	page.host = host;
	if (!frame) return page;

	// from the address bar (the host's own text field)
	let origin = await timeOrigin(frame);
	await page.focus('#omni input');
	await press(cdp, 'r', CTRL);
	frame = await tabFrame(
		page,
		`performance.timeOrigin !== ${origin} && window.__origin > 0`,
	);
	ok(
		`${mode}: Ctrl+R in the address bar reloads the tab, not the demo`,
		!!frame && (await timeOrigin(page)) === host,
	);
	if (!frame) return page;

	// from inside the proxied page, its text field focused
	for (const [name, key, modifiers] of [
		['Ctrl+R', 'r', CTRL],
		['F5', 'F5', 0],
	]) {
		origin = await timeOrigin(frame);
		await frame.click('#field');
		await until(frame, () => document.activeElement?.id === 'field', Boolean);
		await press(cdp, key, modifiers);
		frame = await tabFrame(
			page,
			`performance.timeOrigin !== ${origin} && window.__origin > 0`,
			15000,
		);
		const keys = frame
			? await frame.evaluate(() =>
					JSON.parse(sessionStorage.getItem('keys') || '[]'),
				)
			: [];
		const seen = keys.at(-1);
		ok(
			`${mode}: ${name} in the proxied page's text field reloads the tab, not the demo`,
			!!frame && (await timeOrigin(page)) === host,
		);
		ok(
			`${mode}: the page had ${name} first, trusted and not cancelled to its eyes`,
			seen?.key.toLowerCase() === key.toLowerCase() &&
				seen.trusted &&
				!seen.before &&
				!seen.after &&
				seen.returnValue === true,
			JSON.stringify(seen),
		);
		if (!frame) return page;
	}

	// a page that cancels Ctrl+R keeps it
	await submitOmni(page, `${KEYS_PAGE}?cancel`);
	frame = await tabFrame(
		page,
		() => window.__search === '?cancel' && window.__origin > 0,
	);
	if (frame) {
		origin = await timeOrigin(frame);
		await frame.click('#field');
		await press(cdp, 'r', CTRL);
		await sleep(1500);
		const still = await tabFrame(
			page,
			`performance.timeOrigin === ${origin}`,
			2000,
		);
		const seen = (
			await frame
				.evaluate(() => JSON.parse(sessionStorage.getItem('keys') || '[]'))
				.catch(() => [])
		).at(-1);
		ok(
			`${mode}: a page that cancels Ctrl+R keeps it, as natively (${nativeCancelKept ? 'kept' : 'reloaded'} there)`,
			!!still === nativeCancelKept &&
				(await timeOrigin(page)) === host &&
				seen?.after === true,
			JSON.stringify(seen),
		);
	} else
		ok(
			`${mode}: the cancelling page opens`,
			false,
			await (
				await tabFrame(page, () => true, 2000)
			)
				?.evaluate(() => location.href)
				.catch(String),
		);
	return page;
}

const isolated = await reloadKeys(HOST, 'isolated');
await reloadKeys(PROXY, 'same-origin').then((page) => page.close());

// a hard reload against Chrome's, on the isolated demo's tab
{
	const page = isolated;
	const cdp = await page.context().newCDPSession(page);
	await submitOmni(page, HARD_PAGE);
	let frame = await tabFrame(page, () => window.__late === true);
	ok('the hard-reload page loads in the tab', !!frame);
	if (frame) {
		// once more by a plain navigation: what the proxy keeps answers it
		await submitOmni(page, `${KEYS_PAGE}#away`);
		await tabFrame(page, () => window.__origin > 0);
		counted = await hardHits();
		await submitOmni(page, HARD_PAGE);
		frame = await tabFrame(page, () => window.__late === true);
		await sleep(500);
		const kept = shape(await askedSince(counted));
		ok(
			"a second visit's subresources come from the proxy's caches",
			HARD_FILES.slice(1).every((file) => kept[file].length === 0),
			JSON.stringify(kept),
		);

		const reload = async (modifiers) => {
			const origin = await timeOrigin(frame);
			counted = await hardHits();
			// (into the page: its body has no box of its own)
			await page.click('.frame:not(.hidden)');
			await press(cdp, 'r', modifiers);
			frame = await tabFrame(
				page,
				`performance.timeOrigin !== ${origin} && window.__late === true`,
			);
			await sleep(500);
			return shape(await askedSince(counted));
		};
		const proxiedReload = await reload(CTRL);
		ok(
			'Ctrl+R asks the site what Page.reload asks natively',
			JSON.stringify(proxiedReload) === JSON.stringify(nativeReload),
			`proxied ${JSON.stringify(proxiedReload)} native ${JSON.stringify(nativeReload)}`,
		);
		const proxiedHard = await reload(CTRL | SHIFT);
		ok(
			'Ctrl+Shift+R asks the site what a hard reload (Page.reload ignoreCache) asks natively',
			JSON.stringify(proxiedHard) === JSON.stringify(nativeHard),
			`proxied ${JSON.stringify(proxiedHard)} native ${JSON.stringify(nativeHard)}`,
		);
		ok(
			'the hard reload fetched the document, its subresources and its frame with no-cache and Pragma',
			HARD_FILES.slice(0, -1).every(
				(file) =>
					proxiedHard[file].length === 1 &&
					proxiedHard[file][0] === 'no-cache|no-cache|plain',
			),
			JSON.stringify(proxiedHard),
		);
		ok('the demo was never reloaded', (await timeOrigin(page)) === page.host);
	}
}

// ---- the tab keys: kept by Chrome in a window, the demo's in fullscreen ---

{
	const page = isolated;
	const cdp = await page.context().newCDPSession(page);
	const pages = () => browser.contexts().flatMap((c) => c.pages()).length;
	const landing = () =>
		!document.getElementById('landing').classList.contains('hidden');
	const tabUrls = () => tabs.map((tab) => tab.frame.url);
	const shownCount = pages();
	await page.focus('#omni input');
	await press(cdp, 't', CTRL);
	await sleep(1000);
	const window = {
		landing: await page.evaluate(landing),
		pages: pages() - shownCount,
	};
	ok(
		"in a window Ctrl+T is Chrome's: the demo never sees it",
		!window.landing,
		JSON.stringify(window),
	);
	// a tab Chrome opened is Chrome's own (none while headless has no tab strip)
	for (const other of browser.contexts().flatMap((c) => c.pages()))
		if (other !== page && !other.isClosed() && pages() > shownCount)
			await other.close().catch(() => {});

	await page.click('#toolMenu');
	await page.click('#menuFullscreen');
	// headed, requestFullscreen makes the window fullscreen, and Chrome hands
	// a fullscreen window's page its tab keys; the headless window stays
	// normal, so it is made fullscreen as a headed one is
	const { windowId } = await cdp.send('Browser.getWindowForTarget');
	await cdp.send('Browser.setWindowBounds', {
		windowId,
		bounds: { windowState: 'fullscreen' },
	});
	const full = await until(
		page,
		() => !!document.fullscreenElement,
		Boolean,
		5000,
	);
	ok('the menu puts the demo in fullscreen', full === true);
	await sleep(300);

	// Ctrl+T from the proxied page: the new tab page, its box focused, and
	// the page never had the key
	await submitOmni(page, `${KEYS_PAGE}?tabs`);
	const frame = await tabFrame(page, () => window.__search === '?tabs');
	await frame?.evaluate(() => sessionStorage.removeItem('keys'));
	await frame?.click('#field');
	await press(cdp, 't', CTRL);
	const opened = await until(
		page,
		() =>
			!document.getElementById('landing').classList.contains('hidden') &&
			document.activeElement === document.getElementById('mainForm').url,
		Boolean,
		5000,
	);
	const pageKeys = await frame
		?.evaluate(() => JSON.parse(sessionStorage.getItem('keys') || '[]'))
		.catch(() => null);
	ok(
		'in fullscreen Ctrl+T in the proxied page opens the new tab page with its address bar focused',
		opened === true && pages() === shownCount,
		JSON.stringify({ opened, pages: pages() - shownCount }),
	);
	ok(
		'and the page never had Ctrl+T, as no page has it natively',
		Array.isArray(pageKeys) && !pageKeys.some((key) => key.key === 't'),
		JSON.stringify(pageKeys),
	);

	// three tabs; close the second, then the third: Ctrl+Shift+T reopens the
	// third, then the second, each where it was
	await page.evaluate(() => {
		for (const tab of [...tabs]) closeTab(tab);
	});
	const urls = ['?one', '?two', '?three'].map((query) => KEYS_PAGE + query);
	for (const url of urls) {
		await submitLanding(page, url);
		await tabFrame(
			page,
			`window.__search === ${JSON.stringify(url.slice(url.indexOf('?')))}`,
		);
	}
	await until(page, tabUrls, (list) => list?.length === 3);
	const order = await page.evaluate(tabUrls);
	await page.evaluate(() => closeTab(tabs[1]));
	// Ctrl+W, held by the demo in fullscreen, closes the tab it shows
	await page.evaluate(() => activateTab(tabs[1]));
	await page.focus('#omni input');
	await press(cdp, 'w', CTRL);
	const closed = await until(page, tabUrls, (list) => list?.length === 1);
	ok(
		'in fullscreen Ctrl+W closes the tab',
		closed?.length === 1 && closed[0] === order[0] && pages() === shownCount,
		JSON.stringify(closed),
	);
	await page.focus('#mainForm input[name=url]').catch(() => {});
	await press(cdp, 't', CTRL | SHIFT);
	const first = await until(page, tabUrls, (list) => list?.length === 2);
	const firstUrl = await until(
		page,
		() => tabs[1]?.frame.url,
		(url) => !!url,
	);
	ok(
		'Ctrl+Shift+T reopens the tab closed last, where it was',
		first?.length === 2 && firstUrl === order[2],
		JSON.stringify({ first, firstUrl, order }),
	);
	// (the reopened tab's page has the focus once it loaded)
	await tabFrame(page, `window.__search === '?three'`);
	await press(cdp, 't', CTRL | SHIFT);
	await until(page, tabUrls, (list) => list?.length === 3);
	const second = await until(
		page,
		tabUrls,
		(list) => list?.length === 3 && list.every(Boolean),
	);
	ok(
		'and again the one closed before it, where it was',
		JSON.stringify(second) === JSON.stringify(order),
		JSON.stringify({ second, order }),
	);
	ok('the demo was never reloaded', (await timeOrigin(page)) === page.host);
}

await done(browser);
