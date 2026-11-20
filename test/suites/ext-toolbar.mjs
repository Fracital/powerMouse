// The extensions' toolbar as Chrome 157 has it (docs/extensions.md), driven
// through `controller.extensions` on probe extensions built here, in both
// host modes:
//  - each button's menu (contextMenu): its entries, their order and labels
//    as ExtensionContextMenuModel makes them, with and without developer
//    mode, from the toolbar or from the extensions menu, the extension's own
//    items (six at most, radio runs between separators, long titles cut),
//    and the site access submenu; the item and separator sequences match
//    native Chrome's where the probe kit recorded them;
//  - an item chosen (runMenuCommand): contextMenus.onClicked's info as
//    Chrome gives it for an action menu, the tab, checkboxes and radios;
//  - pins: a new install is pinned, unpinning and pinning again moves it
//    last, the extension hears it, and the pins outlive a reload;
//  - the button's state: badge colors (the default, opaque, the text's
//    contrast), the badge text's limit, tooltips, setIcon's sizes, a tab's
//    values gone with its document, a page action hidden, declarativeContent
//    showing an action on the pages its rules match (kept over a reload);
//  - action.openPopup(): its errors, a popup the host mounts on its ask,
//    one popup at a time;
//  - popup sizes (Chrome's 25x25 to 800x600, following the content), Escape
//    and window.close() closing it, getViews and getContexts seeing it;
//  - site access withheld: content scripts wait for a click on the button;
//  - commands: the manifest's shortcuts, _execute_action, onCommand.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
/* global chrome */
import { crc32, deflateRawSync } from 'node:zlib';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

/** a ZIP of `files`, deflated */
function zip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const body = deflateRawSync(data);
		const nameBytes = Buffer.from(name);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, body);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const PAGE_A = `${FIXTURE}pages/bookmark-a.html`;
const PAGE_B = `${FIXTURE}pages/bookmark-b.html`;
// (another host: no rule of the declarativeContent probe's matches it)
const ELSEWHERE = `${FIXTURE.replace('127.0.0.1', 'localhost')}pages/bookmark-b.html`;
const SITE = new URL(FIXTURE).hostname;
// what Chrome 157 showed for the same probes (the probe kit's native5.mjs)
const NATIVE = `${process.env.NATIVE_MENUS ?? `${homedir()}/.claude/stomp-work/ext-toolbar/probe/out/n5`}`;

const recorder = `
self.__clicks = [];
chrome.contextMenus.onClicked.addListener((info, tab) =>
	self.__clicks.push({ info, tab: tab && { id: tab.id, url: tab.url } }));`;

const manifest = (fields) =>
	JSON.stringify({ manifest_version: 3, version: '1.0', ...fields });

// Chrome's probe ext2 (homepage, options, seven action items, activeTab),
// with every site asked for so the site access radios all apply here
const MENU = {
	'manifest.json': manifest({
		name: 'Menu Probe',
		homepage_url: 'https://example.com/home',
		options_page: 'options.html',
		action: { default_title: 'Menu probe title', default_popup: 'popup.html' },
		background: { service_worker: 'bg.js' },
		permissions: ['contextMenus', 'activeTab'],
		host_permissions: ['*://*/*'],
	}),
	'bg.js': `${recorder}
chrome.runtime.onInstalled.addListener(() => {
	for (let i = 1; i <= 7; i++)
		chrome.contextMenus.create({ id: 'a' + i, title: 'Action item ' + i, contexts: ['action'] });
	chrome.contextMenus.create({ id: 'pg', title: 'Page item', contexts: ['page'] });
	chrome.contextMenus.create({ id: 'all', title: 'All item', contexts: ['all'] });
});`,
	'options.html': '<!doctype html><title>o</title>options',
	'popup.html':
		'<!doctype html><title>pop</title><body style="margin:0"><div style="width:10px;height:10px"></div></body>',
};

const BARE = {
	'manifest.json': manifest({
		name: 'Bare Probe',
		action: { default_title: 'Bare' },
	}),
};

const TYPES = {
	'manifest.json': manifest({
		name: 'Types Probe',
		action: { default_title: 'Types', default_popup: 'popup.html' },
		background: { service_worker: 'bg.js' },
		permissions: ['contextMenus'],
		host_permissions: ['<all_urls>'],
		options_ui: { page: 'options.html' },
	}),
	'bg.js': `${recorder}
chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({ id: 'all', title: 'All context', contexts: ['all'] });
	chrome.contextMenus.create({ id: 'ba', title: 'Browser action ctx', contexts: ['browser_action'] });
	chrome.contextMenus.create({ id: 'pa', title: 'Page action ctx', contexts: ['page_action'] });
	chrome.contextMenus.create({ id: 'cb', title: 'Checkbox on', type: 'checkbox', checked: true, contexts: ['action'] });
	chrome.contextMenus.create({ id: 'sep', type: 'separator', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'r1', title: 'Radio one', type: 'radio', checked: true, contexts: ['action'] });
	chrome.contextMenus.create({ id: 'r2', title: 'Radio two', type: 'radio', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'dis', title: 'Disabled item', enabled: false, contexts: ['action'] });
	chrome.contextMenus.create({ id: 'par', title: 'Parent item', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'kid', parentId: 'par', title: 'Child item', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'long', title: 'A very long title '.repeat(6), contexts: ['action'] });
});`,
	'options.html': '<!doctype html><title>o</title>options',
	'popup.html': '<!doctype html><title>pop</title>popup',
};

// titles: one cut, ampersands, a parent with its child (within the six)
const TITLES = {
	'manifest.json': manifest({
		name: 'Title Probe',
		action: {},
		background: { service_worker: 'bg.js' },
		permissions: ['contextMenus'],
	}),
	'bg.js': `${recorder}
chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({ id: 'long', title: 'A very long title '.repeat(6), contexts: ['action'] });
	chrome.contextMenus.create({ id: 'amp', title: 'Save && quit', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'mn', title: '&File', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'p', title: 'Parent', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'c', parentId: 'p', title: 'Child', contexts: ['action'] });
});`,
};

const BADGE = {
	'manifest.json': manifest({
		name: 'Badge Probe',
		action: {
			default_title: 'Badge title',
			default_icon: { 16: 'd16.png', 32: 'd32.png' },
		},
		background: { service_worker: 'bg.js' },
		permissions: ['activeTab'],
	}),
	'bg.js': `
self.__settings = [];
chrome.action.onUserSettingsChanged.addListener((settings) => self.__settings.push(settings));`,
	'd16.png': 'D16',
	'd32.png': 'D32',
	'i16.png': 'I16',
	'i32.png': 'I32',
};

const PAGE_ACTION = {
	'manifest.json': JSON.stringify({
		manifest_version: 2,
		name: 'Page Probe',
		version: '1.0',
		page_action: { default_title: 'Page' },
	}),
};

const CONTENT = {
	'manifest.json': manifest({
		name: 'Content Probe',
		action: { default_title: 'Content' },
		background: { service_worker: 'bg.js' },
		permissions: ['declarativeContent'],
	}),
	'bg.js': `
chrome.runtime.onInstalled.addListener(() => {
	chrome.action.disable();
	chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
		chrome.declarativeContent.onPageChanged.addRules([{
			id: 'here',
			conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: ${JSON.stringify(SITE)} } })],
			actions: [new chrome.declarativeContent.ShowAction()],
		}]);
	});
});`,
};

const POPUPS = {
	'manifest.json': manifest({
		name: 'Pop Probe',
		action: { default_title: 'Pop', default_popup: 'tiny.html' },
		background: { service_worker: 'bg.js' },
		commands: {
			_execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } },
			toggle: {
				suggested_key: { default: 'Alt+Shift+T' },
				description: 'Toggle it',
			},
		},
	}),
	'bg.js': `
self.__commands = [];
chrome.commands.onCommand.addListener((name, tab) => self.__commands.push({ name, tabId: tab && tab.id }));`,
	'tiny.html':
		'<!doctype html><meta charset="utf-8"><title>pop</title><body style="margin:0;background:#cfe"><div style="width:10px;height:10px"></div></body>',
	'huge.html':
		'<!doctype html><meta charset="utf-8"><title>pop</title><body style="margin:0;background:#cfe"><div style="width:1000px;height:1000px">big</div></body>',
	'grow.html':
		'<!doctype html><meta charset="utf-8"><title>pop</title><body style="margin:0;background:#cfe"><div id="b" style="width:100px;height:50px">grow</div><script src="grow.js"></script></body>',
	'grow.js':
		"setTimeout(() => { const b = document.getElementById('b'); b.style.width = '300px'; b.style.height = '200px'; }, 700);",
	'plain.html':
		'<!doctype html><meta charset="utf-8"><title>pop</title><body style="margin:0;background:#cfe"><p>Hello popup</p></body>',
};

const SITE_PROBE = {
	'manifest.json': manifest({
		name: 'Site Probe',
		action: { default_title: 'Site' },
		content_scripts: [
			{
				matches: ['*://*/pages/bookmark-a.html*'],
				js: ['cs.js'],
				run_at: 'document_end',
			},
		],
	}),
	'cs.js': "document.documentElement.dataset.siteProbe = 'ran';",
};

const PROBES = {
	menu: MENU,
	bare: BARE,
	types: TYPES,
	titles: TITLES,
	badge: BADGE,
	page: PAGE_ACTION,
	content: CONTENT,
	pop: POPUPS,
	site: SITE_PROBE,
};

const browser = await launch();
const errors = [];

/** JSON with sorted keys: two values compare as Chrome's would read */
function canonical(value) {
	return JSON.stringify(value, (key, inner) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(
					Object.keys(inner)
						.sort()
						.map((name) => [name, inner[name]]),
				)
			: inner,
	);
}

/** a menu as Chrome's views tree showed it: `item` or `---` */
const sequence = (entries) =>
	entries.map((entry) => (entry.type === 'separator' ? '---' : 'item'));
const labels = (entries) =>
	entries.map((entry) => (entry.type === 'separator' ? '---' : entry.label));

/** the native menus the probe kit recorded, or null */
function nativeMenus(variant) {
	const file = `${NATIVE}/${variant}.json`;
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/** the newest frame of `page` whose title starts with `title` */
async function documentAt(page, title) {
	for (const frame of [...page.frames()].reverse()) {
		const found = await frame.evaluate(() => document.title).catch(() => '');
		if (found.startsWith(title)) return frame;
	}
	return null;
}

/** poll `read` (in the page) until `until` holds of its value */
async function until(read, holds, timeout = 15000) {
	const deadline = Date.now() + timeout;
	let value;
	while (Date.now() < deadline) {
		value = await read().catch((error) => ({ error: String(error) }));
		if (holds(value)) return value;
		await sleep(150);
	}
	return value;
}

/** a call of controller.extensions: its value, or its error's message */
const api = (page, call, ...args) =>
	page.evaluate(
		async ({ call, args }) => {
			try {
				return { value: await window.__controller.extensions[call](...args) };
			} catch (error) {
				return { error: error.message, code: error.code };
			}
		},
		{ call, args },
	);

/** run `fn` in the extension's background page, once it is up */
async function inBackground(page, id, fn, arg) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		for (const frame of page.frames()) {
			if (!frame.name().startsWith('ext-context:background')) continue;
			const found = await frame
				.evaluate(() => globalThis.chrome?.runtime?.id ?? null)
				.catch(() => null);
			if (found === id) return frame.evaluate(fn, arg);
		}
		await sleep(200);
	}
	throw new Error(`no background page for ${id}`);
}

/**
 * the open popup's frame, by its element (named once it was in the page:
 * Playwright keeps the name a frame had when it attached)
 */
async function popupFrame(page) {
	for (let tries = 0; tries < 100; tries++) {
		const element = await page.$('iframe[name^="ext-context:popup"]');
		const frame = await element?.contentFrame();
		const ready = await frame
			?.evaluate(() => document.readyState === 'complete')
			.catch(() => false);
		if (ready) return frame;
		await sleep(100);
	}
	return null;
}

/** the frame goes to `url`, and the hub heard its commit */
async function go(page, url, title) {
	await page.evaluate((url) => window.__frame.go(url), url);
	await until(async () => {
		const frame = await documentAt(page, title);
		return frame
			? frame.evaluate(() => document.readyState === 'complete')
			: false;
	}, Boolean);
	// (the tab's commit reaches the hub after the document)
	await sleep(400);
}

/** a controller on the page (the extensions installed when `install`) */
async function boot(page, base, isolated, install) {
	await page.goto(`${base}stomp/controllerFrame.html`);
	return page.evaluate(
		async ({ isolated, proxyOrigin, install }) => {
			const { StompController, RemoteController } =
				await import('/stomp/controller.mjs');
			const wisp = `${proxyOrigin.replace(/^http/, 'ws')}/wisp/`;
			const transport = {
				module: `${proxyOrigin}/epoxy/index.mjs`,
				options: [{ wisp }],
			};
			const controller = isolated
				? new RemoteController({
						proxyOrigin,
						directory: '/stomp/',
						transport,
						codec: 'xor',
					})
				: new StompController({
						serviceworker: await StompController.register('/stomp/'),
						transport,
						directory: '/stomp/',
						codec: 'xor',
					});
			await controller.wait();
			window.__controller = controller;
			const frame = controller.createFrame();
			document.body.append(frame.element);
			window.__frame = frame;
			window.__tab = () => controller.tabIdOf(frame);
			const ids = {};
			for (const [key, base64] of Object.entries(install ?? {})) {
				const bytes = Uint8Array.from(atob(base64), (char) =>
					char.charCodeAt(0),
				);
				const info = await controller.extensions.install(new Blob([bytes]), {
					filename: `${key}.zip`,
				});
				ids[key] = info.id;
			}
			return ids;
		},
		{ isolated, proxyOrigin: new URL(PROXY).origin, install },
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
].filter(
	([mode]) => !process.env.EXT_MODES || process.env.EXT_MODES.includes(mode),
)) {
	await waitForServer(base);
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	const isolated = mode === 'isolated';
	const zips = Object.fromEntries(
		Object.entries(PROBES).map(([key, files]) => [
			key,
			zip(files).toString('base64'),
		]),
	);
	const started = Date.now();
	const ids = await boot(page, base, isolated, zips);
	ok(
		`${mode}: the probes install`,
		Object.keys(ids).length === Object.keys(PROBES).length,
		JSON.stringify(ids),
	);
	await go(page, PAGE_A, 'Bookmark A');
	const tabId = await page.evaluate(() => window.__tab());

	// ---- pins: every new install with a button is pinned -----------------
	const installed = (await api(page, 'list')).value ?? [];
	const byId = (id) => installed.find((info) => info.id === id);
	ok(
		`${mode}: a new install with a button is pinned (Chrome 157 pins by default)`,
		Object.values(ids).every((id) => byId(id)?.pinned === true),
		JSON.stringify(installed.map((info) => [info.name, info.pinned])),
	);
	ok(
		`${mode}: the pins keep the install order`,
		canonical(
			[...installed]
				.sort((a, b) => a.pinOrder - b.pinOrder)
				.map((info) => info.id),
		) === canonical(Object.values(ids)),
		JSON.stringify(installed.map((info) => [info.name, info.pinOrder])),
	);

	// the extensions' own items are made in their onInstalled
	for (const key of ['menu', 'types', 'titles'])
		await until(
			() =>
				page.evaluate(
					(id) => window.__controller.extensions.menus(id),
					ids[key],
				),
			(list) => Array.isArray(list) && list.length >= 5,
		);

	// ---- the button's menu ------------------------------------------------
	const menu = async (key, options = {}) =>
		(await api(page, 'contextMenu', ids[key], options)).value ?? [];
	const menuProbe = await menu('menu');
	ok(
		`${mode}: the menu probe's menu, as Chrome 157's`,
		canonical(labels(menuProbe)) ===
			canonical([
				'Menu Probe',
				'---',
				'Action item 1',
				'Action item 2',
				'Action item 3',
				'Action item 4',
				'Action item 5',
				'Action item 6',
				'---',
				'This can read and change site data',
				'---',
				'Options',
				'Remove from Chrome',
				'Unpin',
				'---',
				'Manage extension',
				'View web permissions',
			]),
		JSON.stringify(labels(menuProbe)),
	);
	ok(
		`${mode}: its name opens its homepage`,
		menuProbe[0]?.command === 'home' &&
			menuProbe[0].enabled === true &&
			menuProbe[0].url === 'https://example.com/home',
		JSON.stringify(menuProbe[0]),
	);
	const bare = await menu('bare');
	ok(
		`${mode}: a bare extension's menu`,
		canonical(labels(bare)) ===
			canonical([
				'Bare Probe',
				'---',
				'Remove from Chrome',
				'Unpin',
				'---',
				'Manage extension',
				'View web permissions',
			]) && bare[0].enabled === false,
		JSON.stringify(bare),
	);
	const types = await menu('types');
	ok(
		`${mode}: item types: a checkbox, a radio run between separators, a disabled item, six at most`,
		canonical(labels(types)) ===
			canonical([
				'Types Probe',
				'---',
				'All context',
				'Checkbox on',
				'---',
				'Radio one',
				'Radio two',
				'---',
				'Disabled item',
				'---',
				'This can read and change site data',
				'---',
				'Options',
				'Remove from Chrome',
				'Unpin',
				'---',
				'Manage extension',
				'View web permissions',
			]),
		JSON.stringify(labels(types)),
	);
	const typeOf = (entries, label) =>
		entries.find((entry) => entry.label === label);
	ok(
		`${mode}: the items' kinds and states`,
		typeOf(types, 'Checkbox on')?.type === 'checkbox' &&
			typeOf(types, 'Checkbox on').checked === true &&
			typeOf(types, 'Radio one')?.type === 'radio' &&
			typeOf(types, 'Radio one').checked === true &&
			typeOf(types, 'Radio two')?.checked === false &&
			typeOf(types, 'Disabled item')?.enabled === false &&
			typeOf(types, 'All context')?.menuItemId === 'all',
		JSON.stringify(types.slice(2, 9)),
	);
	const titles = await menu('titles');
	const cut =
		'A very long title A very long title A very long title A very long title A…';
	ok(
		`${mode}: titles: cut to 75 at a word with an ellipsis, && as &, a lone & dropped, a parent's submenu`,
		canonical(labels(titles)) ===
			canonical([
				'Title Probe',
				'---',
				cut,
				'Save & quit',
				'File',
				'Parent',
				'---',
				'Remove from Chrome',
				'Unpin',
				'---',
				'Manage extension',
				'View web permissions',
			]) &&
			typeOf(titles, 'Parent')?.type === 'submenu' &&
			typeOf(titles, 'Parent').children?.[0]?.label === 'Child' &&
			typeOf(titles, 'Parent').children[0].menuItemId === 'c',
		JSON.stringify(titles),
	);
	const developer = {
		menu: await menu('menu', { developerMode: true }),
		bare: await menu('bare', { developerMode: true }),
		types: await menu('types', { developerMode: true }),
	};
	const inspect = (entries) => entries.at(-1);
	ok(
		`${mode}: developer mode adds Inspect popup, disabled without a popup`,
		labels(developer.menu).slice(-2).join() === '---,Inspect popup' &&
			inspect(developer.menu).enabled === true &&
			inspect(developer.menu).command === 'inspect' &&
			inspect(developer.bare).label === 'Inspect popup' &&
			inspect(developer.bare).enabled === false,
		JSON.stringify([inspect(developer.menu), inspect(developer.bare)]),
	);
	const fromMenu = await menu('menu', { source: 'menu' });
	ok(
		`${mode}: the extensions menu's More menu has no Pin or Unpin`,
		!labels(fromMenu).some((label) => /^(Un)?[Pp]in$/.test(label)) &&
			labels(fromMenu).length === labels(menuProbe).length - 1,
		JSON.stringify(labels(fromMenu)),
	);
	const named = await menu('bare', { browserName: 'powerMouse' });
	ok(
		`${mode}: the browser's name in Remove`,
		labels(named).includes('Remove from powerMouse'),
		JSON.stringify(labels(named)),
	);
	for (const [variant, menus] of [
		['plain', { menu0: menuProbe, menu1: bare, menu2: types }],
		['dev', developer],
	]) {
		const native = nativeMenus(variant);
		if (!native) {
			console.log(
				`${mode}: no native ${variant} menus at ${NATIVE}: comparison skipped`,
			);
			continue;
		}
		const ours = Object.fromEntries(
			Object.entries(menus).map(([, entries], index) => [
				`menu${index}`,
				sequence(entries),
			]),
		);
		for (const [key, entries] of Object.entries(ours))
			ok(
				`${mode}: ${variant} ${key} has native Chrome 157's item and separator sequence`,
				canonical(entries) === canonical(native[key]?.[0]),
				`ours ${entries.join(' ')} | native ${native[key]?.[0]?.join(' ')}`,
			);
	}

	// ---- site access --------------------------------------------------------
	const submenu = async () =>
		(await menu('menu')).find((entry) => entry.command === 'siteAccess')
			?.children ?? [];
	const radios = (children) =>
		children
			.filter((entry) => entry.type === 'radio')
			.map(
				(entry) =>
					`${entry.enabled ? 'on' : 'off'}:${entry.checked ? 'x' : '-'}`,
			)
			.join(' ');
	const before = await submenu();
	ok(
		`${mode}: the site access submenu's entries`,
		canonical(labels(before)) ===
			canonical([
				'When you click the extension',
				`On ${SITE}`,
				'On all sites',
				'---',
				'Learn more about site access',
			]) &&
			before[4].url === 'https://support.google.com/chrome?p=enable_extensions',
		JSON.stringify(before),
	);
	ok(
		`${mode}: on all sites to begin with, every choice open`,
		radios(before) === 'on:- on:- on:x',
		radios(before),
	);
	const accessOf = async () =>
		(await api(page, 'action', ids.menu, tabId)).value;
	const granted = await accessOf();
	await api(page, 'runMenuCommand', ids.menu, 'site:site', tabId);
	const onSite = await submenu();
	const siteInfo = (await api(page, 'get', ids.menu)).value;
	await api(page, 'runMenuCommand', ids.menu, 'site:click', tabId);
	const onClick = await submenu();
	const withheld = await accessOf();
	ok(
		`${mode}: On <site> checks its radio`,
		radios(onSite) === 'on:- on:x on:-' &&
			siteInfo?.siteAccess?.withheld === true &&
			canonical(siteInfo.siteAccess.sites) ===
				canonical([new URL(FIXTURE).origin]),
		`${radios(onSite)} ${JSON.stringify(siteInfo?.siteAccess)}`,
	);
	ok(
		`${mode}: When you click the extension checks its radio`,
		radios(onClick) === 'on:x on:- on:-',
		radios(onClick),
	);
	ok(
		`${mode}: the tooltip says the extension has access, then that it wants it`,
		granted?.tooltip === 'Menu probe title\nHas access to this site' &&
			granted.siteInteraction === 'granted' &&
			withheld?.tooltip === 'Menu probe title\nWants access to this site' &&
			withheld.siteInteraction === 'withheld' &&
			withheld.enabled === true,
		JSON.stringify([granted?.tooltip, withheld?.tooltip]),
	);
	await api(page, 'runMenuCommand', ids.menu, 'site:all', tabId);
	ok(
		`${mode}: On all sites again`,
		radios(await submenu()) === 'on:- on:- on:x',
	);

	// ---- an item chosen: contextMenus.onClicked -----------------------------
	const clicks = (key) =>
		inBackground(page, ids[key], () => self.__clicks.splice(0));
	const choose = (key, menuItemId) =>
		page.evaluate(
			({ id, menuItemId }) =>
				window.__controller.extensions
					.runMenuCommand(id, { command: 'item', menuItemId })
					.then(
						() => 'ok',
						(error) => error.message,
					),
			{ id: ids[key], menuItemId },
		);
	await choose('menu', 'a1');
	const plainClick = await until(
		() => clicks('menu'),
		(list) => list?.length,
	);
	ok(
		`${mode}: onClicked gets {menuItemId, editable: false} and the tab`,
		canonical(plainClick?.[0]?.info) ===
			canonical({ menuItemId: 'a1', editable: false }) &&
			plainClick[0].tab?.id === tabId &&
			plainClick[0].tab.url === PAGE_A,
		JSON.stringify(plainClick),
	);
	await choose('types', 'cb');
	await choose('types', 'r2');
	await choose('types', 'kid');
	const typed = [];
	await until(
		async () => {
			typed.push(...((await clicks('types')) ?? []));
			return typed.length;
		},
		(count) => count >= 3,
	);
	const infoOf = (id) =>
		typed.find((click) => click.info.menuItemId === id)?.info;
	ok(
		`${mode}: a checkbox's click: wasChecked true, checked false`,
		canonical(infoOf('cb')) ===
			canonical({
				menuItemId: 'cb',
				editable: false,
				wasChecked: true,
				checked: false,
			}),
		JSON.stringify(infoOf('cb')),
	);
	ok(
		`${mode}: a radio's click: checked true`,
		canonical(infoOf('r2')) ===
			canonical({
				menuItemId: 'r2',
				editable: false,
				wasChecked: false,
				checked: true,
			}),
		JSON.stringify(infoOf('r2')),
	);
	ok(
		`${mode}: a child's click names its parent`,
		canonical(infoOf('kid')) ===
			canonical({
				menuItemId: 'kid',
				parentMenuItemId: 'par',
				editable: false,
			}),
		JSON.stringify(infoOf('kid')),
	);
	const typesAfter = await menu('types');
	ok(
		`${mode}: the checkbox is unchecked, the radio run moved to its second`,
		typeOf(typesAfter, 'Checkbox on')?.checked === false &&
			typeOf(typesAfter, 'Radio one')?.checked === false &&
			typeOf(typesAfter, 'Radio two')?.checked === true,
		JSON.stringify(typesAfter.slice(2, 8)),
	);

	// ---- the button's state -----------------------------------------------
	const state = async (key, tab = tabId) =>
		(await api(page, 'action', ids[key], tab)).value;
	const badge0 = await state('badge');
	const defaults = await inBackground(page, ids.badge, async () => [
		await chrome.action.getBadgeBackgroundColor({}),
		await chrome.action.getBadgeTextColor({}),
	]);
	ok(
		`${mode}: Chrome's default badge colors: null here, [0, 0, 0, 0] to the extension`,
		badge0?.badgeColor === null &&
			badge0.badgeTextColor === null &&
			canonical(defaults) ===
				canonical([
					[0, 0, 0, 0],
					[0, 0, 0, 0],
				]),
		JSON.stringify([badge0?.badgeColor, badge0?.badgeTextColor, defaults]),
	);
	ok(
		`${mode}: an activeTab extension wants access, one asking nothing says only its title`,
		badge0?.tooltip === 'Badge title\nWants access to this site' &&
			badge0.siteInteraction === 'activeTab' &&
			(await state('bare'))?.tooltip === 'Bare',
		JSON.stringify([badge0?.tooltip, (await state('bare'))?.tooltip]),
	);
	ok(
		`${mode}: the manifest's 16 pixel icon at a device pixel ratio of 1`,
		badge0?.iconUrl ===
			`data:image/png;base64,${Buffer.from('D16').toString('base64')}`,
		badge0?.iconUrl?.slice(0, 60),
	);
	await inBackground(page, ids.badge, () =>
		chrome.action.setBadgeBackgroundColor({ color: [0, 0, 128, 128] }),
	);
	const dark = await state('badge');
	await inBackground(page, ids.badge, () =>
		chrome.action.setBadgeBackgroundColor({ color: '#F0F0F0' }),
	);
	const light = await state('badge');
	await inBackground(page, ids.badge, () =>
		chrome.action.setBadgeTextColor({ color: '#ff0000' }),
	);
	const red = await state('badge');
	ok(
		`${mode}: a badge color is made opaque, its text white on dark and #202124 on light`,
		dark?.badgeColor === 'rgb(0, 0, 128)' &&
			dark.badgeTextColor === '#ffffff' &&
			light?.badgeColor === 'rgb(240, 240, 240)' &&
			light.badgeTextColor === '#202124' &&
			red?.badgeTextColor === 'rgba(255, 0, 0, 1)',
		JSON.stringify([
			dark?.badgeColor,
			dark?.badgeTextColor,
			light?.badgeColor,
			light?.badgeTextColor,
			red?.badgeTextColor,
		]),
	);
	const tooLong = await inBackground(page, ids.badge, () =>
		chrome.action.setBadgeText({ text: 'x'.repeat(101) }).then(
			() => 'set',
			(error) => error.message,
		),
	);
	ok(
		`${mode}: badge text over 100 bytes is refused in Chrome's words`,
		tooLong ===
			'Badge text size is 101 bytes which exceeds the limit of 100 bytes.',
		tooLong,
	);
	await inBackground(page, ids.badge, () =>
		chrome.action.setIcon({ path: { 16: 'i16.png', 32: 'i32.png' } }),
	);
	const iconSet = await state('badge');
	// (the icon's URL is routed: compared with the routes of both sizes)
	const iconRoutes = await page.evaluate(
		(id) =>
			Promise.all(
				['i16.png', 'i32.png'].map((file) =>
					window.__controller.route(`https://${id}.invalid/${file}`),
				),
			),
		ids.badge,
	);
	ok(
		`${mode}: setIcon's 16 pixel path at a device pixel ratio of 1`,
		iconSet?.iconUrl === iconRoutes[0] && iconRoutes[0] !== iconRoutes[1],
		`${iconSet?.iconUrl} | ${iconRoutes.join(' ')}`,
	);
	await inBackground(
		page,
		ids.badge,
		(tab) =>
			Promise.all([
				chrome.action.setBadgeText({ text: 'G' }),
				chrome.action.setBadgeText({ tabId: tab, text: 'T' }),
				chrome.action.setTitle({ tabId: tab, title: 'Tab title' }),
			]),
		tabId,
	);
	const tabValues = await state('badge');
	await go(page, PAGE_B, 'Bookmark B');
	const afterNavigation = await until(
		() => state('badge'),
		(value) => value?.badgeText === 'G',
	);
	ok(
		`${mode}: a tab's values go with its document, the extension's stay`,
		tabValues?.badgeText === 'T' &&
			tabValues.title === 'Tab title' &&
			afterNavigation?.badgeText === 'G' &&
			afterNavigation.title === 'Badge title',
		JSON.stringify([
			tabValues?.badgeText,
			tabValues?.title,
			afterNavigation?.badgeText,
			afterNavigation?.title,
		]),
	);
	const pageAction = await state('page');
	const pageClick = (await api(page, 'clickAction', ids.page, tabId)).value;
	ok(
		`${mode}: a page action starts hidden: disabled, its click opens the menu`,
		pageAction?.enabled === false &&
			pageAction.visible === false &&
			pageClick === 'disabled',
		JSON.stringify([pageAction?.enabled, pageAction?.visible, pageClick]),
	);
	await go(page, PAGE_A, 'Bookmark A');
	const shownHere = await until(
		() => state('content'),
		(value) => value?.enabled === true,
	);
	await go(page, ELSEWHERE, 'Bookmark B');
	const hiddenThere = await until(
		() => state('content'),
		(value) => value?.enabled === false,
	);
	ok(
		`${mode}: declarativeContent shows the action on the pages its rule matches only`,
		shownHere?.enabled === true &&
			shownHere.visible === true &&
			hiddenThere?.enabled === false,
		JSON.stringify([shownHere?.enabled, hiddenThere?.enabled]),
	);
	await go(page, PAGE_A, 'Bookmark A');

	// ---- popups: sizes, closing, getViews -----------------------------------
	/** mount the pop probe's popup (`file`) in a frame of the page's */
	const mount = async (file) => {
		await inBackground(
			page,
			ids.pop,
			(popup) => chrome.action.setPopup({ popup }),
			file,
		);
		return page.evaluate(async (id) => {
			const element = document.createElement('iframe');
			document.body.append(element);
			const handle = await window.__controller.extensions.mountPopup(
				id,
				element,
			);
			window.__popup = handle;
			window.__popupClosed = false;
			handle.onClose(() => {
				window.__popupClosed = true;
			});
			return true;
		}, ids.pop);
	};
	const sizeOf = () => page.evaluate(() => window.__popup?.size ?? null);
	const closePopup = () =>
		page.evaluate(() => {
			window.__popup?.close();
			window.__popup?.element.remove();
		});
	const sizes = {};
	for (const [file, want] of [
		['tiny.html', '25x25'],
		['huge.html', '800x600'],
		['grow.html', '300x200'],
		['plain.html', null],
	]) {
		await mount(file);
		const size = await until(
			sizeOf,
			(value) =>
				value && (want ? `${value.width}x${value.height}` === want : false),
			want ? 8000 : 2500,
		);
		sizes[file] = size ? `${size.width}x${size.height}` : null;
		await closePopup();
		await sleep(300);
	}
	ok(
		`${mode}: popup sizes as Chrome's: 25x25 at least, 800x600 at most, following its content`,
		sizes['tiny.html'] === '25x25' &&
			sizes['huge.html'] === '800x600' &&
			sizes['grow.html'] === '300x200',
		JSON.stringify(sizes),
	);
	// native Chrome 157 gave <p>Hello popup</p> 36x58: its min-content
	// width, in the 75% system font Chrome gives every extension page
	const [plainWidth, plainHeight] = (sizes['plain.html'] ?? '0x0')
		.split('x')
		.map(Number);
	ok(
		`${mode}: a paragraph's popup as native Chrome's 36x58 (Chrome's extension page font)`,
		Math.abs(plainWidth - 36) <= 3 && Math.abs(plainHeight - 58) <= 3,
		sizes['plain.html'],
	);

	await mount('tiny.html');
	await until(sizeOf, Boolean);
	const views = await inBackground(page, ids.pop, async () => ({
		popups: chrome.extension.getViews({ type: 'popup' }).length,
		tabs: chrome.extension.getViews({ type: 'tab' }).length,
		all: chrome.extension.getViews().length,
		contexts: chrome.runtime.getContexts
			? (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length
			: null,
	}));
	ok(
		`${mode}: getViews({type: 'popup'}) and getContexts see the open popup`,
		views?.popups === 1 &&
			views.tabs === 0 &&
			views.all === 1 &&
			views.contexts === 1,
		JSON.stringify(views),
	);
	const frame = await popupFrame(page);
	if (frame) {
		await frame.locator('body').click();
		await page.keyboard.press('Escape');
	}
	const escaped = await until(
		() => page.evaluate(() => window.__popupClosed),
		Boolean,
		5000,
	);
	ok(`${mode}: Escape in the popup closes it`, escaped === true);
	await closePopup();
	await sleep(300);
	await mount('tiny.html');
	await until(sizeOf, Boolean);
	const closing = await popupFrame(page);
	await closing?.evaluate(() => window.close());
	const selfClosed = await until(
		() => page.evaluate(() => window.__popupClosed),
		Boolean,
		5000,
	);
	ok(`${mode}: the popup's window.close() closes it`, selfClosed === true);
	await closePopup();
	await sleep(500);

	// ---- action.openPopup() ---------------------------------------------------
	await inBackground(page, ids.pop, () =>
		chrome.action.setPopup({ popup: 'tiny.html' }),
	);
	const openFrom = (key) =>
		inBackground(page, ids[key], () =>
			chrome.action.openPopup().then(
				() => 'opened',
				(error) => error.message,
			),
		);
	ok(
		`${mode}: openPopup without a popup is refused in Chrome's words`,
		(await openFrom('badge')) ===
			'Extension does not have a popup on the active tab.',
	);
	await page.evaluate(() => {
		window.__asked = [];
		window.__stopAsking = window.__controller.extensions.onChange((change) => {
			if (change.type !== 'popup') return;
			window.__asked.push({ id: change.id, tabId: change.tabId });
			const element = document.createElement('iframe');
			document.body.append(element);
			window.__controller.extensions
				.mountPopup(change.id, element, change.tabId)
				.then((handle) => {
					window.__popup = handle;
				});
		});
	});
	const opened = await openFrom('pop');
	const asked = await page.evaluate(() => window.__asked);
	ok(
		`${mode}: openPopup asks the host, which mounts the popup, and resolves`,
		opened === 'opened' &&
			asked.length === 1 &&
			asked[0].id === ids.pop &&
			asked[0].tabId === tabId,
		JSON.stringify({ opened, asked }),
	);
	const second = await openFrom('menu');
	ok(
		`${mode}: openPopup while a popup is open is refused`,
		second === 'Failed to open popup.',
		second,
	);
	await closePopup();
	await page.evaluate(() => window.__stopAsking());
	await sleep(500);
	if (mode === 'same-origin') {
		const since = Date.now();
		const unanswered = await openFrom('pop');
		ok(
			`${mode}: openPopup with no host to show it fails after 10 s`,
			unanswered === 'Failed to open popup.' && Date.now() - since >= 9000,
			`${unanswered} after ${Date.now() - since} ms`,
		);
	}

	// ---- commands ----------------------------------------------------------
	const commands = ((await api(page, 'commands')).value ?? []).filter(
		(command) => command.id === ids.pop,
	);
	ok(
		`${mode}: commands() lists the manifest's shortcuts`,
		canonical(commands) ===
			canonical([
				{
					id: ids.pop,
					name: '_execute_action',
					description: '',
					shortcut: 'Ctrl+Shift+Y',
				},
				{
					id: ids.pop,
					name: 'toggle',
					description: 'Toggle it',
					shortcut: 'Alt+Shift+T',
				},
			]),
		JSON.stringify(commands),
	);
	const executed = (
		await api(page, 'runCommand', ids.pop, '_execute_action', tabId)
	).value;
	const toggled = (await api(page, 'runCommand', ids.pop, 'toggle', tabId))
		.value;
	const heard = await until(
		() => inBackground(page, ids.pop, () => self.__commands.slice()),
		(list) => list?.length,
	);
	ok(
		`${mode}: _execute_action clicks the button, a named command reaches onCommand with the tab`,
		executed === 'popup' &&
			toggled === 'command' &&
			canonical(heard) === canonical([{ name: 'toggle', tabId }]),
		JSON.stringify({ executed, toggled, heard }),
	);

	// ---- site access withheld: content scripts wait for a click --------------
	const ran = async () =>
		(await documentAt(page, 'Bookmark A'))
			?.evaluate(() => document.documentElement.dataset.siteProbe ?? null)
			.catch(() => null) ?? null;
	const ranAtFirst = await until(ran, Boolean, 8000);
	await api(page, 'setSiteAccess', ids.site, 'click', tabId);
	await go(page, PAGE_A, 'Bookmark A');
	await sleep(1000);
	const waited = await ran();
	const blocked = await until(
		() => state('site'),
		(value) => value?.wantsToRun === true,
		5000,
	);
	const clickResult = (await api(page, 'clickAction', ids.site, tabId)).value;
	const ranAfterClick = await until(ran, Boolean, 8000);
	const afterClick = await state('site');
	ok(
		`${mode}: the content script runs where its site access grants the site`,
		ranAtFirst === 'ran',
		ranAtFirst,
	);
	ok(
		`${mode}: withheld, the content script waits and the button wants to run`,
		waited === null &&
			blocked?.wantsToRun === true &&
			blocked.siteInteraction === 'withheld' &&
			blocked.tooltip === 'Site\nWants access to this site',
		JSON.stringify({ waited, blocked }),
	);
	ok(
		`${mode}: a click grants the tab and the script runs`,
		clickResult === 'granted' &&
			ranAfterClick === 'ran' &&
			afterClick?.wantsToRun === false &&
			afterClick.siteInteraction === 'granted',
		JSON.stringify({ clickResult, ranAfterClick, afterClick }),
	);
	await api(page, 'setSiteAccess', ids.site, 'all', tabId);
	await go(page, PAGE_B, 'Bookmark B');
	await go(page, PAGE_A, 'Bookmark A');
	ok(
		`${mode}: On all sites again: the script runs at once`,
		(await until(ran, Boolean, 8000)) === 'ran',
	);

	// ---- pins: unpin, pin again, the extension hears it -----------------------
	const unpinned = (await api(page, 'pin', ids.badge, false)).value;
	const settingsOff = await until(
		() =>
			inBackground(page, ids.badge, async () => ({
				heard: self.__settings.slice(),
				now: await chrome.action.getUserSettings(),
			})),
		(value) => value?.heard?.length >= 1,
	);
	const orderUnpinned = ((await api(page, 'actions', tabId)).value ?? []).map(
		(action) => [action.id, action.pinned],
	);
	await api(page, 'pin', ids.badge, true);
	const settingsOn = await until(
		() =>
			inBackground(page, ids.badge, async () => ({
				heard: self.__settings.slice(),
				now: await chrome.action.getUserSettings(),
			})),
		(value) => value?.heard?.length >= 2,
	);
	const orderPinned = ((await api(page, 'actions', tabId)).value ?? []).map(
		(action) => action.id,
	);
	ok(
		`${mode}: unpin: info, the toolbar order (the unpinned last), getUserSettings`,
		unpinned?.pinned === false &&
			orderUnpinned.at(-1)?.[0] === ids.badge &&
			orderUnpinned.at(-1)[1] === false &&
			settingsOff?.now?.isOnToolbar === false,
		JSON.stringify({ unpinned: unpinned?.pinned, orderUnpinned, settingsOff }),
	);
	ok(
		`${mode}: pinned again, it goes after the other pins`,
		orderPinned.at(-1) === ids.badge && settingsOn?.now?.isOnToolbar === true,
		JSON.stringify({ orderPinned, settingsOn }),
	);
	ok(
		`${mode}: action.onUserSettingsChanged hears each change`,
		canonical(settingsOn?.heard) ===
			canonical([{ isOnToolbar: false }, { isOnToolbar: true }]),
		JSON.stringify(settingsOn?.heard),
	);
	await api(page, 'pin', ids.bare, false);

	// ---- a reload: pins and declarativeContent's rules are kept ---------------
	await boot(page, base, isolated, null);
	const kept = (await api(page, 'list')).value ?? [];
	const keptPins = Object.fromEntries(
		kept.map((info) => [info.id, info.pinned]),
	);
	ok(
		`${mode}: the pins outlive a reload`,
		keptPins[ids.bare] === false &&
			keptPins[ids.badge] === true &&
			keptPins[ids.menu] === true &&
			kept.find((info) => info.id === ids.badge)?.pinOrder >
				kept.find((info) => info.id === ids.pop)?.pinOrder,
		JSON.stringify(kept.map((info) => [info.name, info.pinned, info.pinOrder])),
	);
	const rules = await inBackground(
		page,
		ids.content,
		() =>
			new Promise((resolve) =>
				chrome.declarativeContent.onPageChanged.getRules(resolve),
			),
	);
	ok(
		`${mode}: declarativeContent's rules outlive a reload`,
		rules?.length === 1 &&
			rules[0].id === 'here' &&
			rules[0].conditions?.[0]?.pageUrl?.hostEquals === SITE &&
			/ShowAction$/.test(rules[0].actions?.[0]?.instanceType ?? ''),
		JSON.stringify(rules),
	);
	console.log(`${mode}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
	await context.close();
}

await done(browser, errors);
