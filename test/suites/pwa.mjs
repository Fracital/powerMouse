// powerMouse as an installed app (demo/README.md "The installed app"), in a
// Chrome profile of its own (an installable page is never one in Chrome's
// off-the-record profiles, which is what a new Playwright context is), on
// the same-origin demo, as stomp.fracit.al runs:
//  - the manifest parses, with its name, id, start_url, scope, display,
//    display_override, colours, shortcuts and launch_handler, and its three
//    icons load at their sizes;
//  - Chrome has no installability error (Page.getInstallabilityErrors) and
//    reads the manifest without one (Page.getAppManifest);
//  - the app worker controls the page from /, beside STomp's worker at
//    /stomp/, and a request of the page goes to the network without it
//    (its static routes); a proxied page loads as before;
//  - Chrome's own offer (beforeinstallprompt) puts Install powerMouse in
//    the menu; choosing it prompts once and the item goes; appinstalled
//    takes it away too;
//  - theme-color is the theme's: the toolbar's in the browser view and the
//    page's on the home screen, through Light, Dark and Default;
//  - the launches (?launch=settings, extensions, a web+stomp: link, a share
//    with its URL in its text) open what they ask for, once, and leave the
//    address without them;
//  - offline, the app's page is the app worker's offline page, in the
//    theme last shown, with its icon, and it loads the app again by itself
//    once the browser is back online;
//  - opened as an app window (PWA.install, PWA.openCurrentPageInApp) the
//    page is display-mode standalone and offers no install, and a launch
//    with a URL (PWA.launch) opens its page once (from the address or the
//    launch queue, never both);
//  - a copy of the page in a frame, or at another path, links no manifest
//    and registers no worker at the root.
// Headless Chrome cannot show what needs a real window: Window Controls
// Overlay (its app window is standalone, and DevTools' emulation of it
// changes no display-mode), the title bar's colour, a launch into the open
// window (launch_handler: PWA.launch opens a tab), the install dialog, and
// which shortcuts Chrome keeps for itself (keys sent over the DevTools
// protocol skip Chrome's own shortcuts, in a tab too).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
	CHROME,
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

await waitForServer(PROXY);
const APP_ID = new URL('/', PROXY).href;
const HIST_1 = `${FIXTURE}pages/hist-1.html`;
const HIST_2 = `${FIXTURE}pages/hist-2.html`;
const errors = [];

const profile = mkdtempSync(join(tmpdir(), 'stomp-pwa-'));
const context = await chromium.launchPersistentContext(profile, {
	executablePath: CHROME,
	headless: true,
	viewport: { width: 1280, height: 800 },
	args: [
		'--no-sandbox',
		'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
	],
});
// Chrome's own offers, told from the suite's (isTrusted)
await context.addInitScript(() => {
	window.__offers = [];
	addEventListener('beforeinstallprompt', (event) =>
		window.__offers.push(event.isTrusted),
	);
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (error) => errors.push(error.message));
const cdp = await context.newCDPSession(page);

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(target, read, want, timeout = 20000, arg = undefined) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await target.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(200);
	}
	return value;
}
const ready = (target) =>
	until(
		target,
		() => document.getElementById('logMsg')?.textContent ?? '',
		(text) => /^(Ready|Error)/.test(text ?? ''),
		45000,
	);
/** the title of the tab in front, once it is `want` */
const frontTitle = async (target, want) => {
	const start = Date.now();
	while (Date.now() - start < 40000) {
		const handle = await target.$('.frame:not(.hidden)');
		const frame = await handle?.contentFrame();
		const title = await frame?.evaluate(() => document.title).catch(() => '');
		if (title === want) return title;
		await sleep(250);
	}
	return null;
};
const themeColor = (target) =>
	target.evaluate(
		() => document.querySelector('meta[name="theme-color"]').content,
	);
const token = (target, name) =>
	target.evaluate(
		(name) =>
			getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
		name,
	);

await page.goto(PROXY);
ok('the demo boots', /^Ready/.test(await ready(page)));

// ---- the manifest ---------------------------------------------------------------
const linked = await page.evaluate(
	() => document.querySelector('link[rel="manifest"]')?.href ?? null,
);
ok(
	'the page links the manifest',
	linked === `${APP_ID}manifest.webmanifest`,
	linked,
);
const manifest = await page.evaluate(async (href) => {
	const response = await fetch(href);
	return {
		type: response.headers.get('content-type'),
		json: await response.json(),
	};
}, linked);
const m = manifest.json;
ok(
	'the manifest is served as one',
	/^application\/manifest\+json/.test(manifest.type),
	manifest.type,
);
ok(
	'its name and short name are powerMouse, the page title',
	m.name === 'powerMouse' &&
		m.short_name === 'powerMouse' &&
		(await page.title()) === 'powerMouse',
	`${m.name} ${m.short_name}`,
);
ok(
	'its id, start_url and scope are the root',
	m.id === '/' && m.start_url === '/' && m.scope === '/',
	JSON.stringify([m.id, m.start_url, m.scope]),
);
ok(
	'display standalone, with Window Controls Overlay first',
	m.display === 'standalone' &&
		JSON.stringify(m.display_override) ===
			'["window-controls-overlay","standalone"]',
	JSON.stringify([m.display, m.display_override]),
);
ok(
	'theme_color and background_color are colours',
	/^#[0-9a-f]{6}$/i.test(m.theme_color) &&
		/^#[0-9a-f]{6}$/i.test(m.background_color),
	`${m.theme_color} ${m.background_color}`,
);
ok(
	'launch_handler focuses the open window',
	m.launch_handler?.client_mode === 'focus-existing',
	JSON.stringify(m.launch_handler),
);
ok(
	'shortcuts: New tab, Extensions, Settings',
	JSON.stringify(m.shortcuts?.map((s) => [s.name, s.url])) ===
		JSON.stringify([
			['New tab', '/?launch=new-tab'],
			['Extensions', '/?launch=extensions'],
			['Settings', '/?launch=settings'],
		]),
	JSON.stringify(m.shortcuts),
);
ok(
	'web+stomp: links and shares come in as launches',
	m.protocol_handlers?.[0]?.protocol === 'web+stomp' &&
		m.protocol_handlers[0].url === '/?launch=%s' &&
		m.share_target?.action === '/' &&
		m.share_target.method === 'GET' &&
		m.share_target.params?.url === 'url' &&
		m.share_target.params?.text === 'text',
	JSON.stringify([m.protocol_handlers, m.share_target]),
);
// each icon's size from its PNG header
const icons = await page.evaluate(async (list) => {
	const out = [];
	for (const icon of list) {
		const response = await fetch(icon.src);
		const bytes = new DataView(await response.arrayBuffer());
		out.push({
			...icon,
			status: response.status,
			png: bytes.getUint32(0) === 0x89504e47,
			size: `${bytes.getUint32(16)}x${bytes.getUint32(20)}`,
		});
	}
	return out;
}, m.icons ?? []);
const icon = (sizes, purpose) =>
	icons.find((i) => i.sizes === sizes && (i.purpose ?? 'any') === purpose);
ok(
	'icons: 192 and 512, and a maskable 512, each a PNG of its size',
	icon('192x192', 'any') &&
		icon('512x512', 'any') &&
		icon('512x512', 'maskable') &&
		icons.every((i) => i.status === 200 && i.png && i.size === i.sizes),
	JSON.stringify(icons),
);

// ---- what Chrome makes of it ------------------------------------------------------
let installability = null;
for (let i = 0; i < 50; i++) {
	installability = await cdp.send('Page.getInstallabilityErrors');
	if (!installability.installabilityErrors.length) break;
	await sleep(200);
}
ok(
	'Chrome has no installability error',
	installability.installabilityErrors.length === 0,
	JSON.stringify(installability),
);
const parsed = await cdp.send('Page.getAppManifest');
ok(
	'Chrome reads the manifest with no error and the same fields',
	parsed.url === linked &&
		parsed.errors.length === 0 &&
		parsed.manifest?.name === 'powerMouse' &&
		/^k?standalone$/i.test(parsed.manifest?.display) &&
		/^k?window-?controls-?overlay$/i.test(
			parsed.manifest?.displayOverrides?.[0],
		) &&
		/^k?focus-?existing$/i.test(parsed.manifest?.launchHandler?.clientMode) &&
		parsed.manifest?.icons?.length === 3,
	JSON.stringify({
		url: parsed.url,
		errors: parsed.errors,
		manifest: parsed.manifest,
	}),
);

// ---- the app worker ---------------------------------------------------------------
const controlled = await until(
	page,
	() => navigator.serviceWorker.controller?.scriptURL ?? null,
	(url) => !!url,
);
ok(
	'the app worker controls the page from the root',
	controlled === `${APP_ID}app-worker.js`,
	controlled,
);
const scopes = await page.evaluate(async () =>
	(await navigator.serviceWorker.getRegistrations())
		.map(
			(r) =>
				`${new URL(r.scope).pathname} ${new URL(r.active?.scriptURL ?? 'about:').pathname}`,
		)
		.sort(),
);
ok(
	"STomp's worker keeps /stomp/, the app worker has /",
	JSON.stringify(scopes) ===
		JSON.stringify(['/ /app-worker.js', '/stomp/ /stomp/serviceWorker.js']),
	JSON.stringify(scopes),
);
const timing = await page.evaluate(async () => {
	const url = new URL(`/api/status?pwa=${Date.now()}`, location).href;
	performance.clearResourceTimings(); // a full buffer takes no more
	await (await fetch(url)).text();
	let entry;
	for (let i = 0; i < 20 && !entry; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		entry = performance.getEntriesByName(url).pop();
	}
	return {
		matched: entry?.workerMatchedSourceType ?? null,
		final: entry?.workerFinalSourceType ?? null,
	};
});
ok(
	"a request of the page goes to the network by the app worker's routes",
	timing.matched === 'network' && timing.final === 'network',
	JSON.stringify(timing),
);
await page.evaluate((url) => {
	const form = document.getElementById('mainForm');
	form.url.value = url;
	form.requestSubmit();
}, HIST_1);
ok('a proxied page loads', (await frontTitle(page, 'HIST 1')) === 'HIST 1');

// ---- Install powerMouse ------------------------------------------------------------
const offered = await until(
	page,
	() => window.__offers,
	(offers) => offers?.includes(true),
	15000,
);
ok(
	'Chrome offers the app (a beforeinstallprompt of its own)',
	offered?.includes(true),
	JSON.stringify(offered),
);
const openMenu = async () => {
	await page.click('#toolMenu');
	await until(
		page,
		() => !document.getElementById('pmMenu').classList.contains('hidden'),
		(open) => open,
		5000,
	);
};
const installItem = () =>
	page.evaluate(() => {
		const item = document.getElementById('menuInstall');
		return { hidden: item.hidden, text: item.textContent };
	});
await openMenu();
let item = await installItem();
ok(
	"the menu has Install powerMouse… on Chrome's offer",
	!item.hidden && item.text === 'Install powerMouse…',
	JSON.stringify(item),
);
await page.keyboard.press('Escape');
// a stand-in for Chrome's offer, whose prompt the suite can see
await page.evaluate(() => {
	window.__prompted = 0;
	const offer = new Event('beforeinstallprompt', { cancelable: true });
	offer.prompt = async () => {
		window.__prompted++;
		return { outcome: 'dismissed' };
	};
	dispatchEvent(offer);
	window.__offerPrevented = offer.defaultPrevented;
});
await openMenu();
await page.click('#menuInstall');
const afterPrompt = await page.evaluate(() => ({
	prompted: window.__prompted,
	prevented: window.__offerPrevented,
	hidden: document.getElementById('menuInstall').hidden,
	menuOpen: !document.getElementById('pmMenu').classList.contains('hidden'),
}));
ok(
	'choosing it prompts once, closes the menu and the item goes',
	afterPrompt.prompted === 1 &&
		afterPrompt.prevented &&
		afterPrompt.hidden &&
		!afterPrompt.menuOpen,
	JSON.stringify(afterPrompt),
);
await page.evaluate(() => {
	const offer = new Event('beforeinstallprompt', { cancelable: true });
	offer.prompt = async () => ({ outcome: 'accepted' });
	dispatchEvent(offer);
});
const offeredAgain = (await installItem()).hidden === false;
await page.evaluate(() => dispatchEvent(new Event('appinstalled')));
item = await installItem();
ok(
	'a new offer brings it back, and appinstalled takes it away',
	offeredAgain && item.hidden,
	JSON.stringify({ offeredAgain, item }),
);

// ---- theme-color --------------------------------------------------------------------
const colours = {};
for (const id of ['light', 'dark', 'systemya-light', 'default']) {
	await page.evaluate((id) => window.PMTheme.apply(id), id);
	colours[id] = {
		meta: await themeColor(page),
		toolbar: await token(page, '--pm-toolbar'),
	};
}
ok(
	"in the browser view theme-color is the theme's toolbar colour",
	Object.values(colours).every((c) => c.meta === c.toolbar) &&
		colours.light.meta === '#f6f6f4' &&
		colours.dark.meta === '#000' &&
		colours['systemya-light'].meta === '#fff',
	JSON.stringify(colours),
);
await page.click('#home');
await until(
	page,
	() => !document.getElementById('landing').classList.contains('hidden'),
	(home) => home,
	5000,
);
const home = {};
for (const id of ['light', 'dark', 'systemya-light']) {
	await page.evaluate((id) => window.PMTheme.apply(id), id);
	home[id] = {
		meta: await themeColor(page),
		page: await token(page, '--pm-page'),
	};
}
ok(
	"on the home screen it is the theme's page colour",
	home.light.meta === '#e4e6e1' &&
		home.dark.meta === '#000' &&
		home['systemya-light'].meta === '#000' &&
		Object.values(home).every((c) => c.meta === c.page),
	JSON.stringify(home),
);

// ---- launches --------------------------------------------------------------------------
const tabs = (target) =>
	target.evaluate(() => document.querySelectorAll('#frames .frame').length);
// the address keeps no launch: at most the token of the page on show (`?3`,
// demo/README.md "Navigate")
const tokenOnly = (search) => /^(\?\d+)?$/.test(search);
for (const [launchName, view] of [
	['settings', 'settings'],
	['extensions', 'extensions'],
]) {
	await page.goto(`${PROXY}?launch=${launchName}`);
	await ready(page);
	const shown = await until(
		page,
		() => {
			const sheet = document.getElementById('shieldsPage');
			return sheet.classList.contains('hidden') ? null : sheet.dataset.view;
		},
		(v) => v === view,
		10000,
	);
	ok(
		`?launch=${launchName} opens ${view}, and the address loses it`,
		shown === view && (await page.evaluate(() => location.search)) === '',
		`${shown} ${await page.evaluate(() => location.href)}`,
	);
}
await page.goto(`${PROXY}?launch=${encodeURIComponent(`web+stomp:${HIST_1}`)}`);
await ready(page);
ok(
	'a web+stomp: link opens its page in one tab',
	(await frontTitle(page, 'HIST 1')) === 'HIST 1' && (await tabs(page)) === 1,
	`${await tabs(page)} tabs`,
);
await page.goto(
	`${PROXY}?title=Shared&text=${encodeURIComponent(`have a look ${HIST_2}`)}`,
);
await ready(page);
ok(
	'a share opens the URL in its text',
	(await frontTitle(page, 'HIST 2')) === 'HIST 2' &&
		(await tabs(page)) === 1 &&
		tokenOnly(await page.evaluate(() => location.search)),
	`${await tabs(page)} tabs ${await page.evaluate(() => location.href)}`,
);

// ---- offline ---------------------------------------------------------------------------
await page.goto(PROXY);
await ready(page);
await page.evaluate(() => window.PMTheme.apply('light'));
await context.setOffline(true);
await page.reload({ waitUntil: 'load' }).catch(() => {});
const shell = await page.evaluate(() => ({
	h1: document.querySelector('h1')?.textContent ?? null,
	background: getComputedStyle(document.body).backgroundColor,
	icon: document.querySelector('img')?.naturalWidth ?? 0,
	meta: document.querySelector('meta[name="theme-color"]')?.content,
	online: navigator.onLine,
}));
ok(
	"offline the app's page is the offline page, in the theme shown, with the icon",
	shell.h1 === 'powerMouse is offline' &&
		shell.background === 'rgb(228, 230, 225)' &&
		shell.meta === '#e4e6e1' &&
		shell.icon === 192,
	JSON.stringify(shell),
);
await context.setOffline(false);
const back = await until(
	page,
	() => document.getElementById('logMsg')?.textContent ?? null,
	(text) => /^Ready/.test(text ?? ''),
	45000,
);
ok(
	'back online the app loads again by itself',
	/^Ready/.test(back ?? ''),
	`${back} ${await page.evaluate(() => `${document.querySelector('h1')?.textContent} ${navigator.onLine}`).catch((e) => e.message)}`,
);
await page.evaluate(() => window.PMTheme.apply('default'));

// ---- the app's window ------------------------------------------------------------------
await cdp.send('PWA.install', { manifestId: APP_ID });
await cdp.send('PWA.openCurrentPageInApp', { manifestId: APP_ID });
const standalone = await until(
	page,
	() => matchMedia('(display-mode: standalone)').matches,
	(yes) => yes,
	10000,
);
await page.evaluate(() => {
	const offer = new Event('beforeinstallprompt', { cancelable: true });
	offer.prompt = async () => ({ outcome: 'dismissed' });
	dispatchEvent(offer);
});
ok(
	'in the app window (display-mode standalone) the menu offers no install',
	standalone === true && (await installItem()).hidden,
	JSON.stringify({ standalone, item: await installItem() }),
);
await cdp.send('PWA.launch', {
	manifestId: APP_ID,
	url: `${APP_ID}?launch=${encodeURIComponent(`web+stomp:${HIST_2}`)}`,
});
// headless Chrome opens the launch in a tab (the new tab page the app
// window left behind), not in the open window
let other = null;
for (let i = 0; i < 75 && !other; i++) {
	other =
		context.pages().find((p) => p !== page && p.url().startsWith(APP_ID)) ??
		null;
	if (!other) await sleep(200);
}
if (other) {
	other.on('pageerror', (error) => errors.push(error.message));
	await ready(other);
}
ok(
	'a launch with a URL (PWA.launch) opens its page once, and the address loses it',
	other &&
		(await frontTitle(other, 'HIST 2')) === 'HIST 2' &&
		(await tabs(other)) === 1 &&
		tokenOnly(await other.evaluate(() => location.search)),
	other ? `${await tabs(other)} tabs ${other.url()}` : 'no page',
);
await context.close();
rmSync(profile, { recursive: true, force: true });

// ---- a copy of the page elsewhere -----------------------------------------------------
const browser = await launch();
const elsewhere = await browser.newContext();
const shellText = await (await fetch(PROXY)).text();
await elsewhere.route(`${PROXY}pwa-framed.html`, (route) =>
	route.fulfill({
		contentType: 'text/html',
		body: '<!doctype html><iframe src="/" style="width:1200px;height:700px"></iframe>',
	}),
);
await elsewhere.route(`${PROXY}ui/index.html`, (route) =>
	route.fulfill({ contentType: 'text/html', body: shellText }),
);
const framedHost = await elsewhere.newPage();
await framedHost.goto(`${PROXY}pwa-framed.html`);
const framed = await until(
	framedHost,
	() => {
		const doc = document.querySelector('iframe').contentDocument;
		const status = doc?.getElementById('logMsg')?.textContent ?? '';
		return /^(Ready|Error)/.test(status)
			? { manifest: !!doc.querySelector('link[rel="manifest"]'), status }
			: null;
	},
	(value) => !!value,
	45000,
);
await sleep(3500); // past the idle the app worker would be registered after
const framedScopes = await framedHost.evaluate(async () =>
	(await navigator.serviceWorker.getRegistrations()).map(
		(r) => new URL(r.scope).pathname,
	),
);
ok(
	'the page in a frame links no manifest and registers no root worker',
	framed?.manifest === false && !framedScopes.includes('/'),
	JSON.stringify({ framed, framedScopes }),
);
const copy = await elsewhere.newPage();
copy.on('pageerror', (error) => errors.push(error.message));
await copy.goto(`${PROXY}ui/index.html`);
const copyStatus = await ready(copy);
await sleep(3500);
const copyState = await copy.evaluate(async () => ({
	manifest: !!document.querySelector('link[rel="manifest"]'),
	scopes: (await navigator.serviceWorker.getRegistrations()).map(
		(r) => new URL(r.scope).pathname,
	),
}));
ok(
	'a copy at another path links no manifest and registers no root worker',
	/^Ready/.test(copyStatus) &&
		!copyState.manifest &&
		!copyState.scopes.includes('/'),
	JSON.stringify({ copyStatus, copyState }),
);
// Embedders can update the script before the shell and may have a manifest
// of their own. Neither is a reason to start the app's root worker.
await elsewhere.route(`${PROXY}ui/legacy.html`, (route) =>
	route.fulfill({
		contentType: 'text/html',
		body: shellText
			.replace(/<button\s+id="menuInstall"[\s\S]*?<\/button>/, '')
			.replace(
				'</head>',
				'<link rel="manifest" href="/own.webmanifest" /></head>',
			),
	}),
);
const legacy = await elsewhere.newPage();
legacy.on('pageerror', (error) => errors.push(error.message));
await legacy.goto(`${PROXY}ui/legacy.html`);
const legacyStatus = await ready(legacy);
await sleep(3500);
const legacyScope = await legacy.evaluate(async () => {
	const registration = await navigator.serviceWorker.getRegistration('/');
	return registration?.scope ?? null;
});
ok(
	'an older shell with a manifest of its own boots without the app worker',
	/^Ready/.test(legacyStatus) && legacyScope === null,
	JSON.stringify({ legacyStatus, legacyScope }),
);
ok('no page errors', errors.length === 0, errors.join(' | '));
await done(browser);
