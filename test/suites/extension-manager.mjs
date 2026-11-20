// The demo's Extensions page as Chrome 157's chrome://extensions
// (demo/public/pm/extensions-page.js), with no network. Four extensions are
// added through the page itself: an unpacked folder (Manager Probe: a
// service worker, a popup, options, a host permission, a content script, a
// declarativeNetRequest rule, commands, an unknown manifest key, and errors
// in each context), a .zip (Zip Probe, no permissions), a .zip that watches
// chrome.management (Management Watcher), and the Store CRX3 of Video Speed
// Controller from the Web Store's update service, which a server here
// plays. A theme (the Store CRX3 of Catppuccin Latte) is added as a file
// too. It proves:
//  - the list: Chrome's order (unpacked first, then by name), a card per
//    extension with its icon, name, description, source badge, toggle,
//    Details, Remove and Reload (unpacked); no card for the theme, which has
//    a Theme row to Settings; the search by name and by id; Developer
//    mode's ID, version, Inspect views, Warnings or Errors, and the
//    toolbar's Load unpacked, Pack extension and Update;
//  - the details of each source (unpacked, a file, the Web Store): Chrome's
//    rows and words; openExtensionsPage({ focus }) and the button menu's
//    Manage extension and View web permissions opening them;
//  - site access: the toggle list of an extension with some hosts (off: the
//    content script waits; its host on: it runs again), and the On click /
//    On specific sites / On all sites choice with Chrome's Add a site;
//  - the toggle really turns the extension off and on: its button, its
//    content script, its rule and its service worker go and come back, and
//    another extension hears management.onDisabled and onEnabled;
//  - Remove asks Chrome's question, Cancel keeps it, Remove uninstalls it,
//    the focus goes to the next card, and the watcher hears onUninstalled;
//  - errors: collected in developer mode, the manifest's first, Chrome's
//    levels (no service worker warning), context and stack, Clear entry and
//    Clear all, Reload collecting again;
//  - Keyboard shortcuts: Chrome's rows and words, a shortcut typed and kept,
//    Chrome's refusals, a key taken from another command, Clear, and a
//    shortcut firing commands.onCommand from the host and from a proxied
//    page, and _execute_action opening the popup;
//  - Pack extension: Chrome's dialog makes a CRX3 and a key, and the CRX
//    installs under the key's id;
//  - at 390px the page fits, the side nav behind the menu button.
// EXT_SHOTS=<dir> writes a screenshot of each view there.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/bookmark-a.html`;
const SHOTS = process.env.EXT_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
		offset += local.length + nameBytes.length + body.length;
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

/** a square PNG of one colour */
function png(size, [r, g, b]) {
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed));
		return Buffer.concat([length, typed, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.alloc(size * 3, Buffer.from([r, g, b])),
	]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

// ---- the extensions ------------------------------------------------------------

const PROBE_NAME = 'Manager Probe';
const PROBE_FILES = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: PROBE_NAME,
		version: '1.2.3',
		description: 'The extension manager suite probe.',
		homepage_url: 'https://example.com/probe',
		icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' },
		permissions: ['storage', 'tabs', 'declarativeNetRequest'],
		host_permissions: ['http://127.0.0.1/*'],
		background: { service_worker: 'sw.js' },
		action: { default_title: PROBE_NAME, default_popup: 'popup.html' },
		options_ui: { page: 'options.html' },
		content_scripts: [
			{
				matches: ['http://127.0.0.1/*'],
				js: ['cs.js'],
				run_at: 'document_end',
			},
		],
		declarative_net_request: {
			rule_resources: [{ id: 'block', enabled: true, path: 'rules.json' }],
		},
		commands: {
			_execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } },
			'do-thing': {
				description: 'Do the thing',
				suggested_key: { default: 'Alt+Shift+D' },
			},
			'no-key': { description: 'No key yet' },
		},
		// (Chrome warns of it, and loads the extension)
		bogus_key: true,
	}),
	'icon16.png': png(16, [52, 101, 164]),
	'icon48.png': png(48, [52, 101, 164]),
	'icon128.png': png(128, [52, 101, 164]),
	'rules.json': JSON.stringify([
		{
			id: 1,
			priority: 1,
			action: { type: 'block' },
			condition: { urlFilter: 'mgrblock', resourceTypes: ['xmlhttprequest'] },
		},
	]),
	'sw.js': `chrome.commands.onCommand.addListener((name, tab) => {
	chrome.action.setBadgeText({ text: name === 'do-thing' ? 'did' : name === 'no-key' ? 'nok' : '?' });
	chrome.action.setTitle({ title: 'command ' + name + ' tab ' + (tab && typeof tab.id === 'number') });
});
console.error('probe: the service worker reports an error');
console.warn('probe: the service worker warns');
setTimeout(() => { throw new Error('probe: uncaught in the service worker'); }, 50);`,
	'popup.html':
		'<!doctype html><meta charset="utf-8"><title>Probe popup</title><body style="margin:0"><div style="width:220px;height:90px">Probe popup</div></body>',
	'options.html':
		'<!doctype html><meta charset="utf-8"><title>Probe options</title><h1>Options</h1>',
	'cs.js': `document.documentElement.dataset.managerProbe = 'ran';
console.error('probe: the content script reports an error');`,
};
const ZIP_NAME = 'Zip Probe';
const ZIP_PROBE = zip({
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: ZIP_NAME,
		version: '0.4',
		description: 'A packaged probe that asks for nothing.',
	}),
});
const WATCHER_NAME = 'Management Watcher';
const WATCHER = zip({
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: WATCHER_NAME,
		version: '1.0',
		permissions: ['management'],
		background: { service_worker: 'sw.js' },
		action: { default_title: '[]' },
	}),
	// what chrome.management told it, on its button's title (the host reads it)
	'sw.js': `const log = [];
for (const name of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled'])
	chrome.management[name].addListener((arg) => {
		log.push(typeof arg === 'string' ? [name, arg] : [name, arg.id, arg.enabled, arg.name]);
		chrome.action.setTitle({ title: JSON.stringify(log) });
	});`,
});
const STORE_ID = 'nffaoalbilbmmfgbnbgppjihopabppdk';
const STORE_NAME = 'Video Speed Controller';
const STORE_PACKAGE = readFileSync(
	new URL('../fixtures/videospeed-0.11.2.crx', import.meta.url),
);
const THEME = readFileSync(
	new URL('../fixtures/catppuccin-latte-5.0.0.crx', import.meta.url),
);

// the unpacked folder, on disk for <input webkitdirectory>
const folderRoot = mkdtempSync(join(tmpdir(), 'stomp-ext-manager-'));
const FOLDER = join(folderRoot, 'manager-probe');
mkdirSync(FOLDER);
for (const [name, content] of Object.entries(PROBE_FILES))
	writeFileSync(join(FOLDER, name), content);

// ---- the Web Store's update service ----------------------------------------------

const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://store.test');
	if (url.pathname === '/service/update2/crx') {
		const id = /id=([a-p]{32})/.exec(url.searchParams.get('x') ?? '')?.[1];
		if (id === STORE_ID) {
			response.writeHead(200, {
				'content-type': 'application/x-chrome-extension',
			});
			return response.end(STORE_PACKAGE);
		}
	}
	response.writeHead(404);
	response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const STORE_PORT = server.address().port;

// ---- helpers ---------------------------------------------------------------------

const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, timeout = 30000, arg) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

const painted = async (page) => {
	await page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	);
	await sleep(60);
};

async function shot(page, name) {
	if (!SHOTS) return;
	await painted(page);
	await page.screenshot({ path: join(SHOTS, `stomp-${name}.png`) });
}

/** the list's cards */
const cards = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#spExtList .xpItem')].map((card) => ({
			id: card.dataset.ext,
			name: card.querySelector('.xpName')?.firstChild?.textContent,
			version: card.querySelector('.xpVersion')?.textContent ?? null,
			description: card.querySelector('.xpDescription')?.textContent ?? null,
			icon: card.querySelector('.extCardIcon')?.tagName ?? null,
			on: card.querySelector('.shieldsToggle')?.checked,
			toggle: card.querySelector('.shieldsToggle')?.getAttribute('aria-label'),
			off: card.classList.contains('off'),
			idLine: card.querySelector('.xpId')?.textContent ?? null,
			views: card.querySelector('.xpViews')?.textContent ?? null,
			reload: !!card.querySelector('[data-control$=":reload"]'),
			badge:
				card.querySelector('.xpSourceBadge')?.getAttribute('aria-label') ??
				null,
			buttons: [...card.querySelectorAll('.xpItemButtons .spBtn')].map(
				(button) => button.textContent,
			),
		})),
	);

/** the details view's rows: [title, ...what it says] */
const detailRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#xpSubView .xpDetails > *')].map((row) => [
			row.querySelector('.spRowLabel')?.textContent,
			...[...row.querySelectorAll('.spRowSub')].map((sub) => sub.textContent),
		]),
	);

const status = (page) =>
	page.evaluate(
		() => document.querySelector('#shieldsPage .spStatus')?.textContent ?? '',
	);

const info = (page, id) =>
	page.evaluate((id) => window.controller.extensions.get(id), id);

/** the watcher's log of chrome.management's events (its button's title) */
const watcherLog = (page, id, want) =>
	until(
		page,
		(id) =>
			window.controller.extensions
				.action(id, null)
				.then((action) => JSON.parse(action.title || '[]')),
		want,
		10000,
		id,
	);

const installedId = (page, name) =>
	page.evaluate(
		async (name) =>
			(await window.controller.extensions.list()).find(
				(info) => info.name === name,
			)?.id ?? null,
		name,
	);

/** the fixture's tab, loaded again: whether the probe's content script ran, and the rule's block */
async function probeTab(page) {
	await submitLanding(page, `${PAGE}?mgr=${Date.now()}`);
	const start = Date.now();
	let frame = null;
	while (Date.now() - start < 20000) {
		frame = await activeFrame(page);
		const ready = await frame
			?.evaluate(() => document.readyState === 'complete')
			.catch(() => false);
		if (ready) break;
		await sleep(200);
	}
	await sleep(400);
	return frame.evaluate(async () => ({
		ran: document.documentElement.dataset.managerProbe ?? null,
		blocked: await fetch('/pages/bookmark-a.html?mgrblock').then(
			() => false,
			() => true,
		),
	}));
}

async function openPage(page, ask = null) {
	await page.evaluate((ask) => window.openExtensionsPage(ask), ask);
	await until(
		page,
		() => document.getElementById('shieldsPage').dataset.view === 'extensions',
		Boolean,
	);
	await painted(page);
}

const closePage = async (page) => {
	await page.evaluate(() => window.closeShieldsPage());
	await painted(page);
};

const answerDialog = async (page, label) => {
	await sleep(700);
	await page.click(`#passkeyPrompt .passkeyButtons button:text-is("${label}")`);
	await until(page, () => !document.getElementById('passkeyPrompt'), Boolean);
};

const subTitle = (page) =>
	page.evaluate(
		() =>
			!document.getElementById('xpSubView').hidden &&
			document.querySelector('#xpSubView .xpSubTitle')?.textContent,
	);

const checked = (page, control) =>
	page.evaluate(
		(control) =>
			document.querySelector(`[data-control="${CSS.escape(control)}"]`)
				?.checked ?? null,
		control,
	);

// ---- the run ---------------------------------------------------------------------

const page = await openDemo(browser, HOST, { width: 1280, height: 900 }, (p) =>
	p.context().route('**/test/mixed-transport.mjs', (route) =>
		route.fulfill({
			status: 200,
			headers: {
				'content-type': 'text/javascript',
				'access-control-allow-origin': '*',
				'cross-origin-resource-policy': 'cross-origin',
			},
			body: `import Epoxy from '../epoxy/index.mjs';
		export default class extends Epoxy {
			request(remote, ...rest) {
				const url = new URL(remote);
				if (url.origin === 'https://clients2.google.com') {
					url.protocol = 'http:'; url.hostname = '127.0.0.1'; url.port = '${STORE_PORT}';
				}
				return super.request(url, ...rest);
			}
		}`,
		}),
	),
);
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
await submitLanding(page, PAGE);
await until(
	page,
	() => !document.getElementById('browser').classList.contains('hidden'),
	Boolean,
);

// empty: Chrome's words for no extension, from the puzzle piece's Manage extensions
await page.click('#toolExtensions');
await painted(page);
await page.click('#extPanel .extManage');
await painted(page);
const empty = await page.evaluate(() => ({
	view: document.getElementById('shieldsPage').dataset.view,
	title: document.getElementById('shieldsPageTitle').textContent,
	list: document.getElementById('spExtList').textContent,
	search: document.getElementById('xpSearch').placeholder,
	dev: document.getElementById('xpDevMode').checked,
	devBar: document.getElementById('xpDevBar').hidden,
	nav: [...document.querySelectorAll('#xpSide [data-nav]')].map(
		(nav) => nav.textContent,
	),
	current: document.querySelector('#xpSide [aria-current="page"]')?.textContent,
	store: document.querySelector('.xpStoreNote')?.textContent,
}));
ok(
	"with none installed: Chrome's toolbar, side nav and empty list",
	empty.view === 'extensions' &&
		empty.title === 'Extensions' &&
		empty.list === 'Find extensions and themes in the Chrome Web Store' &&
		empty.search === 'Search extensions' &&
		empty.dev === false &&
		empty.devBar === true &&
		JSON.stringify(empty.nav) ===
			JSON.stringify(['My extensions', 'Keyboard shortcuts']) &&
		empty.current === 'My extensions' &&
		empty.store ===
			'Discover more extensions and themes on the Chrome Web Store',
	JSON.stringify(empty),
);

// add each kind: the watcher and the zip as files, the folder, the store id
const count = (n, timeout) =>
	until(
		page,
		() => document.querySelectorAll('#spExtList .xpItem').length,
		(value) => value === n,
		timeout,
	);
await page.setInputFiles('#spExtFileInput', {
	name: 'watcher.zip',
	mimeType: 'application/zip',
	buffer: WATCHER,
});
await count(1);
await page.setInputFiles('#spExtFolderInput', FOLDER);
await count(2);
await page.setInputFiles('#spExtFileInput', {
	name: 'zip-probe.zip',
	mimeType: 'application/zip',
	buffer: ZIP_PROBE,
});
await count(3);
await page.fill('#spExtStore', STORE_ID);
await page.click('#spExtAdd');
await count(4, 45000);
await page.setInputFiles('#spExtFileInput', {
	name: 'catppuccin-latte.crx',
	mimeType: 'application/x-chrome-extension',
	buffer: THEME,
});
const themeRow = await until(
	page,
	() => document.querySelector('#xpTheme .xpThemeRow')?.textContent ?? null,
	Boolean,
	30000,
);
const WATCHER_ID = await installedId(page, WATCHER_NAME);
const PROBE_ID = await installedId(page, PROBE_NAME);
const ZIP_ID = await installedId(page, ZIP_NAME);
let list = await cards(page);
ok(
	"four cards in Chrome's order (unpacked first, then by name), each with its icon, name, toggle, Details and Remove",
	JSON.stringify(list.map((card) => card.name)) ===
		JSON.stringify([PROBE_NAME, WATCHER_NAME, STORE_NAME, ZIP_NAME]) &&
		list.every(
			(card) =>
				card.icon &&
				card.on === true &&
				card.toggle === 'On, extension enabled' &&
				!card.off &&
				JSON.stringify(card.buttons) === JSON.stringify(['Details', 'Remove']),
		) &&
		list[0].icon === 'IMG' &&
		list[0].description === 'The extension manager suite probe.',
	JSON.stringify(list),
);
const badge = (id) => list.find((card) => card.id === id)?.badge;
ok(
	"Chrome's source badges: Unpacked extension, Not from Chrome Web Store., none for the store's",
	badge(PROBE_ID) === 'Unpacked extension' &&
		badge(ZIP_ID) === 'Not from Chrome Web Store.' &&
		badge(WATCHER_ID) === 'Not from Chrome Web Store.' &&
		badge(STORE_ID) === null,
	JSON.stringify(list.map((card) => [card.name, card.badge])),
);
ok(
	'Developer mode off: no ID, version, Inspect views or Errors; Reload on the unpacked one only, as Chrome',
	list.every((card) => !card.idLine && !card.version && !card.views) &&
		list
			.filter((card) => card.reload)
			.map((card) => card.id)
			.join() === PROBE_ID,
	JSON.stringify(list),
);
ok(
	'the theme has no card, and a Theme row names it with Appearance settings',
	!list.some((card) => /Catppuccin/.test(card.name)) &&
		/^Theme/.test(themeRow) &&
		/Catppuccin Chrome Theme - Latte/.test(themeRow) &&
		/Appearance settings/.test(themeRow),
	themeRow,
);
await shot(page, 'list');
await page.click('[data-control="theme:appearance"]');
await painted(page);
const appearance = await page.evaluate(
	() => document.getElementById('shieldsPage').dataset.view,
);
ok(
	"the Theme row's Appearance settings opens Settings, the theme picker",
	appearance === 'settings',
	appearance,
);
await closePage(page);
await openPage(page);

// the search: by name and by id
await page.fill('#xpSearch', 'probe');
await painted(page);
const found = (await cards(page)).map((card) => card.name);
await page.fill('#xpSearch', STORE_ID.slice(0, 10));
await painted(page);
const byId = (await cards(page)).map((card) => card.name);
await page.fill('#xpSearch', 'nothing like it');
await painted(page);
const none = await page.evaluate(
	() => document.getElementById('spExtList').textContent,
);
await page.fill('#xpSearch', '');
await painted(page);
ok(
	'the search keeps the cards whose name or id matches, and says when none does',
	JSON.stringify(found) === JSON.stringify([PROBE_NAME, ZIP_NAME]) &&
		JSON.stringify(byId) === JSON.stringify([STORE_NAME]) &&
		none === 'No search results found' &&
		(await cards(page)).length === 4,
	JSON.stringify({ found, byId, none }),
);

// Developer mode: the manifest's warning comes with it (Chrome's error
// console keeps nothing without it), Reload collects the worker's errors
await page.click('.xpDevToggle');
await until(
	page,
	() =>
		[...document.querySelectorAll('#spExtList .xpViews')].some((line) =>
			/service worker/.test(line.textContent),
		),
	Boolean,
	15000,
);
list = await cards(page);
const devBar = await page.evaluate(() => ({
	hidden: document.getElementById('xpDevBar').hidden,
	buttons: [...document.querySelectorAll('#xpDevBar button')].map(
		(button) => button.textContent,
	),
}));
const probeCard = list.find((card) => card.id === PROBE_ID);
ok(
	"Developer mode on: the toolbar's Load unpacked, Pack extension and Update",
	!devBar.hidden &&
		JSON.stringify(devBar.buttons) ===
			JSON.stringify(['Load unpacked', 'Pack extension', 'Update']),
	JSON.stringify(devBar),
);
ok(
	'Developer mode on: each card has its ID and version, and Inspect views for a running worker',
	list.every(
		(card) => card.idLine === `ID: ${card.id}` && card.version?.length > 0,
	) && /^Inspect views\s*service worker/.test(probeCard?.views ?? ''),
	JSON.stringify(list),
);
const warnings = await until(
	page,
	(id) =>
		[
			...document.querySelectorAll(
				`#spExtList [data-ext="${id}"] .xpItemButtons .spBtn`,
			),
		].map((button) => button.textContent),
	(buttons) => buttons?.includes('Warnings'),
	15000,
	PROBE_ID,
);
ok(
	"with only the manifest's warning, the card's button says Warnings",
	warnings?.includes('Warnings'),
	JSON.stringify(warnings),
);
await page.click(`[data-control="${PROBE_ID}:reload"]`);
const reloading = await status(page);
const reloaded = await until(
	page,
	() => document.querySelector('#shieldsPage .spStatus')?.textContent,
	(text) => text === 'Reloaded',
	15000,
);
const withErrors = await until(
	page,
	(id) =>
		[
			...document.querySelectorAll(
				`#spExtList [data-ext="${id}"] .xpItemButtons .spBtn`,
			),
		].map((button) => button.textContent),
	(buttons) => buttons?.includes('Errors'),
	20000,
	PROBE_ID,
);
const noErrors = (await cards(page)).filter((card) => card.id !== PROBE_ID);
ok(
	'Reload says Reloading... then Reloaded, and the errors its worker reports make the button Errors, on no other card',
	reloading === 'Reloading...' &&
		reloaded === 'Reloaded' &&
		withErrors?.includes('Errors') &&
		noErrors.every(
			(card) =>
				!card.buttons.includes('Errors') && !card.buttons.includes('Warnings'),
		),
	JSON.stringify({ reloading, reloaded, withErrors, noErrors }),
);
await shot(page, 'list-dev');

// ---- details, each source
await page.click(`[data-control="${PROBE_ID}:details"]`);
await painted(page);
let rows = await detailRows(page);
const titles = rows.map((row) => row[0]);
const row = (title) => rows.find((entry) => entry[0] === title) ?? [];
ok(
	"the unpacked extension's details: Chrome's rows in Chrome's order",
	JSON.stringify(titles) ===
		JSON.stringify([
			'On',
			'Description',
			'Version',
			'Size',
			'ID',
			'Inspect views',
			'Permissions',
			'Site access',
			'Pin to toolbar',
			'Collect errors',
			'Extension options',
			'Open extension website',
			'Source',
			'Remove extension',
		]),
	JSON.stringify(titles),
);
const back = await page.evaluate(() =>
	document.querySelector('#xpSubView .xpBack')?.getAttribute('aria-label'),
);
ok(
	'its facts: version, size, ID, the source with the folder it was loaded from, the back button',
	row('Version')[1] === '1.2.3' &&
		row('Size')[1] === '< 1 MB' &&
		row('ID')[1] === PROBE_ID &&
		row('Source')[1] === 'Unpacked extension' &&
		row('Source')[2] === 'Loaded from: manager-probe' &&
		back === `${PROBE_NAME} details page back button`,
	JSON.stringify({ rows, back }),
);
const probeAccess = await page.evaluate((id) => {
	const box = document.querySelector('#xpSubView .xpAccess');
	return {
		access: box?.dataset.access,
		text: box?.querySelector('.xpAccessHead .spRowSub')?.textContent,
		select: !!box?.querySelector('select'),
		all: document.querySelector(`[data-control="${id}:access-all"]`)?.checked,
		hosts: [...(box?.querySelectorAll('.xpHostToggle') ?? [])].map((row) => [
			row.dataset.host,
			row.querySelector('input').checked,
			row.querySelector('input').disabled,
		]),
	};
}, PROBE_ID);
ok(
	"its permissions in Chrome's words; a toggle list for its one site, all allowed",
	row('Permissions').includes('Read your browsing history') &&
		!row('Permissions').includes(
			'This extension has no additional site access',
		) &&
		probeAccess.access === 'all' &&
		probeAccess.text ===
			'This extension can read and change your data on sites. You can control which sites the extension can access.' &&
		!probeAccess.select &&
		probeAccess.all === true &&
		JSON.stringify(probeAccess.hosts) ===
			JSON.stringify([['http://127.0.0.1/*', true, true]]),
	JSON.stringify({ permissions: row('Permissions'), probeAccess }),
);
await shot(page, 'details');

await page.evaluate((id) => window.openExtensionsPage({ focus: id }), ZIP_ID);
await painted(page);
rows = await detailRows(page);
ok(
	'openExtensionsPage({ focus }) opens the details; a file: no permissions, no site access, not from the store',
	(await subTitle(page)) === ZIP_NAME &&
		row('Permissions')[1] ===
			'This extension requires no special permissions' &&
		!row('Site access').length &&
		!row('Extension options').length &&
		!row('Open extension website').length &&
		!row('View in Chrome Web Store').length &&
		row('Description')[1] === 'A packaged probe that asks for nothing.' &&
		row('Source')[1] === 'Not from Chrome Web Store.',
	JSON.stringify(rows),
);
await page.evaluate(
	(id) => window.openExtensionsPage({ focus: id }),
	WATCHER_ID,
);
await painted(page);
rows = await detailRows(page);
ok(
	'an extension with permissions and no sites: its warnings, then "This extension has no additional site access"; no description in Chrome\'s words',
	row('Permissions').at(-1) ===
		'This extension has no additional site access' &&
		row('Permissions').length > 2 &&
		row('Description')[1] === 'No description provided',
	JSON.stringify(rows),
);
const storeInfo = await info(page, STORE_ID);
await page.evaluate((id) => window.openExtensionsPage({ focus: id }), STORE_ID);
await painted(page);
rows = await detailRows(page);
ok(
	'a Web Store extension: its website, View in Chrome Web Store, the store as source',
	row('Source')[1] === 'Chrome Web Store' &&
		row('Open extension website').length === 1 &&
		row('View in Chrome Web Store').length === 1 &&
		/chromewebstore\.google\.com\/detail\/.*nffaoalbilbmmfgbnbgppjihopabppdk/.test(
			storeInfo?.webStoreUrl ?? '',
		),
	JSON.stringify({ rows, storeInfo }),
);

// an extension of every site: On click / On specific sites / On all sites,
// and Chrome's Add a site
const select = `[data-control="${STORE_ID}:access"]`;
const storeAccess = await page.evaluate(
	(select) => ({
		value: document.querySelector(select)?.value,
		options: [...(document.querySelector(select)?.options ?? [])].map(
			(option) => option.textContent,
		),
		text: document.querySelector('#xpSubView .xpAccessHead .spRowSub')
			?.textContent,
	}),
	select,
);
ok(
	"an extension that asks for every site: Chrome's sentence and its three choices, On all sites",
	storeAccess.value === 'all' &&
		JSON.stringify(storeAccess.options) ===
			JSON.stringify(['On click', 'On specific sites', 'On all sites']) &&
		storeAccess.text ===
			'Allow this extension to read and change all your data on websites you visit:',
	JSON.stringify(storeAccess),
);
await page.selectOption(select, 'specific');
await page.waitForSelector(`[data-control="${STORE_ID}:host-input"]`);
await page.fill(`[data-control="${STORE_ID}:host-input"]`, 'not a site');
const invalid = await page.evaluate(
	(id) => ({
		error:
			document.querySelector('.xpSiteError')?.hidden === false
				? document.querySelector('.xpSiteError').textContent
				: null,
		add: document.querySelector(`[data-control="${id}:host-add"]`)?.disabled,
		placeholder: document.querySelector(`[data-control="${id}:host-input"]`)
			?.placeholder,
	}),
	STORE_ID,
);
await page.fill(`[data-control="${STORE_ID}:host-input"]`, 'example.com');
await shot(page, 'add-site');
await page.click(`[data-control="${STORE_ID}:host-add"]`);
const specific = await until(
	page,
	async (id) => (await window.controller.extensions.get(id))?.siteAccess,
	(value) => value?.withheld && value.sites?.length === 1,
	10000,
	STORE_ID,
);
const specificShown = await until(
	page,
	() => ({
		value: document.querySelector('#xpSubView .xpAccess select')?.value,
		hosts: [...document.querySelectorAll('#xpSubView .xpHost')].map(
			(host) => host.dataset.host,
		),
		add: document.querySelector('#xpSubView .xpAddSiteLink')?.textContent,
	}),
	(value) => value?.hosts?.length === 1,
	10000,
);
ok(
	"On specific sites asks Chrome's Add a site: a bad address refused, example.com granted as *://example.com/*, listed with Add a new page",
	invalid.error === 'Not a valid web address' &&
		invalid.add === true &&
		invalid.placeholder === 'http://example.com' &&
		JSON.stringify(specific?.sites) === '["*://example.com/*"]' &&
		specificShown.value === 'specific' &&
		JSON.stringify(specificShown.hosts) === '["*://example.com/*"]' &&
		specificShown.add === 'Add a new page',
	JSON.stringify({ invalid, specific, specificShown }),
);
await shot(page, 'site-access');
await page.selectOption(select, 'on-click');
const onClick = await until(
	page,
	async (id) => (await window.controller.extensions.get(id))?.siteAccess,
	(value) => value?.withheld && value.sites?.length === 0,
	10000,
	STORE_ID,
);
await page.selectOption(select, 'all');
const allAgain = await until(
	page,
	async (id) => (await window.controller.extensions.get(id))?.siteAccess,
	(value) => value && !value.withheld,
	10000,
	STORE_ID,
);
ok(
	'On click withholds every site, On all sites gives them back',
	!!onClick?.withheld && allAgain?.withheld === false,
	JSON.stringify({ onClick, allAgain }),
);

// ---- site access by the toggle list: the content script waits, then runs
await closePage(page);
let tab = await probeTab(page);
ok(
	'with access to its site, the content script runs and the rule blocks',
	tab.ran === 'ran' && tab.blocked === true,
	JSON.stringify(tab),
);
await openPage(page, { focus: PROBE_ID });
await page.click(`[data-control="${PROBE_ID}:access-all"]`);
const withheld = await until(
	page,
	async (id) => (await window.controller.extensions.get(id))?.siteAccess,
	(value) => value?.withheld && value.sites?.length === 0,
	10000,
	PROBE_ID,
);
await painted(page);
const hostOff = await checked(page, `${PROBE_ID}:host:http://127.0.0.1/*`);
await closePage(page);
tab = await probeTab(page);
ok(
	'"Automatically allow access" off: its site toggle off, the content script no longer runs',
	!!withheld && hostOff === false && tab.ran === null,
	JSON.stringify({ withheld, hostOff, tab }),
);
await openPage(page, { focus: PROBE_ID });
await page.click(`[data-control="${PROBE_ID}:host:http://127.0.0.1/*"]`);
const granted = await until(
	page,
	async (id) => (await window.controller.extensions.get(id))?.siteAccess,
	(value) => value?.sites?.length === 1,
	10000,
	PROBE_ID,
);
await closePage(page);
tab = await probeTab(page);
ok(
	'its site toggled on: the content script runs again',
	tab.ran === 'ran' &&
		JSON.stringify(granted?.sites) === '["http://127.0.0.1/*"]',
	JSON.stringify({ tab, granted }),
);
await openPage(page, { focus: PROBE_ID });
await page.click(`[data-control="${PROBE_ID}:access-all"]`);
await until(
	page,
	async (id) => (await window.controller.extensions.get(id))?.siteAccess,
	(value) => value && !value.withheld,
	10000,
	PROBE_ID,
);

// ---- off and on
const heardBefore = (await watcherLog(page, WATCHER_ID, Array.isArray)).length;
await page.click('#xpSubView .xpBack');
await painted(page);
await page.click(`[data-control="${PROBE_ID}:toggle"]`);
const offState = await until(
	page,
	async (id) => ({
		bar: !!document.querySelector(`#extActions [data-ext="${id}"]`),
		actions: (await window.controller.extensions.actions()).map((a) => a.id),
		views: await window.controller.extensions.views(id),
		card: document.querySelector(`#spExtList [data-ext="${id}"]`)?.className,
		label: document
			.querySelector(`[data-control="${id}:toggle"]`)
			?.getAttribute('aria-label'),
	}),
	(value) =>
		value &&
		!value.bar &&
		!value.actions.includes(PROBE_ID) &&
		value.views.length === 0 &&
		/off/.test(value.card),
	15000,
	PROBE_ID,
);
await shot(page, 'list-off');
await closePage(page);
tab = await probeTab(page);
ok(
	'turned off: its card greyed and "Off", its button and its service worker gone, no content script, no rule',
	offState &&
		!offState.bar &&
		!offState.actions.includes(PROBE_ID) &&
		offState.views.length === 0 &&
		/off/.test(offState.card) &&
		offState.label === 'Off' &&
		tab.ran === null &&
		tab.blocked === false,
	JSON.stringify({ offState, tab }),
);
await openPage(page);
await page.click(`[data-control="${PROBE_ID}:toggle"]`);
const onState = await until(
	page,
	async (id) => ({
		bar: !!document.querySelector(`#extActions [data-ext="${id}"]`),
		views: (await window.controller.extensions.views(id)).map((v) => v.kind),
	}),
	(value) => value?.bar && value.views.includes('service_worker'),
	20000,
	PROBE_ID,
);
await closePage(page);
tab = await probeTab(page);
ok(
	'turned on again: its button, its service worker, its content script and its rule are back',
	onState?.bar && tab.ran === 'ran' && tab.blocked === true,
	JSON.stringify({ onState, tab }),
);
const toggled = await watcherLog(page, WATCHER_ID, (log) =>
	log?.slice(heardBefore).some((entry) => entry[0] === 'onEnabled'),
).then((log) => log?.slice(heardBefore));
ok(
	'the watcher heard management.onDisabled, then onEnabled, with the extension, and nothing else',
	JSON.stringify(toggled) ===
		JSON.stringify([
			['onDisabled', PROBE_ID, false, PROBE_NAME],
			['onEnabled', PROBE_ID, true, PROBE_NAME],
		]),
	JSON.stringify(toggled),
);

// ---- errors
await openPage(page);
await page.click(`[data-control="${PROBE_ID}:errors"]`);
const errorList = await until(
	page,
	() =>
		[...document.querySelectorAll('#xpSubView .xpError')].map((row) => [
			row.dataset.type,
			row.dataset.severity,
			row.querySelector('.xpErrorMessage')?.textContent,
			row.querySelector('.xpSeverity')?.getAttribute('aria-label'),
			row.querySelector('.xpErrorPick')?.getAttribute('aria-expanded'),
		]),
	(value) =>
		value?.some((entry) => /content script/.test(entry[2])) &&
		value.some((entry) => /uncaught in the service worker/.test(entry[2])),
	20000,
);
const has = (type, severity, pattern) =>
	errorList?.some(
		(entry) =>
			entry[0] === type && entry[1] === severity && pattern.test(entry[2]),
	);
ok(
	"the Errors view: the manifest's warning first and open, then the worker's and the content script's errors in Chrome's words",
	errorList?.[0]?.[0] === 'manifest' &&
		errorList[0][2] === "Unrecognized manifest key 'bogus_key'." &&
		errorList[0][3] === 'Warning' &&
		errorList[0][4] === 'true' &&
		errorList.slice(1).every((entry) => entry[4] === 'false') &&
		has('runtime', 'error', /^probe: the service worker reports an error$/) &&
		has(
			'runtime',
			'error',
			/^Uncaught Error: probe: uncaught in the service worker$/,
		) &&
		has('runtime', 'error', /^probe: the content script reports an error$/),
	JSON.stringify(errorList),
);
ok(
	"the worker's warning is not kept (Chrome's console keeps a worker's errors only)",
	!errorList?.some((entry) => /the service worker warns/.test(entry[2])),
	JSON.stringify(errorList),
);
const uncaught = errorList.findIndex((entry) =>
	/uncaught in the service worker/.test(entry[2]),
);
await page.click(`#xpSubView .xpError:nth-child(${uncaught + 1}) .xpErrorPick`);
await painted(page);
const detail = await page.evaluate(() => {
	const open = document.querySelector('#xpSubView .xpErrorDetail');
	return {
		labels: [...(open?.querySelectorAll('.spRowLabel') ?? [])].map(
			(label) => label.textContent,
		),
		context: open?.querySelector('.spRowSub')?.textContent,
		stack: [...(open?.querySelectorAll('.xpStack li') ?? [])].map(
			(line) => line.textContent,
		),
		opened: document.querySelectorAll('#xpSubView .xpErrorDetail').length,
	};
});
ok(
	"an error opened shows its Context (the worker's script) and Stack Trace lines as Chrome writes them",
	JSON.stringify(detail.labels) ===
		JSON.stringify(['Context', 'Stack Trace']) &&
		detail.context === 'sw.js' &&
		detail.stack.length > 0 &&
		detail.stack.every((line) => /^sw\.js:\d+ \(.+\)$/.test(line)) &&
		detail.opened === 1,
	JSON.stringify(detail),
);
await shot(page, 'errors');
const before = errorList.length;
await page.click(
	`#xpSubView .xpError:first-child [data-control*=":error-drop:"]`,
);
const dropped = await until(
	page,
	() => document.querySelectorAll('#xpSubView .xpError').length,
	(n) => n === before - 1,
	10000,
);
await page.click(`[data-control="${PROBE_ID}:clear-all"]`);
const cleared = await until(
	page,
	(id) => ({
		rows: document.querySelectorAll('#xpSubView .xpError').length,
		clearAll: !!document.querySelector(`[data-control="${id}:clear-all"]`),
	}),
	(value) => value?.rows === 0 && !value.clearAll,
	10000,
	PROBE_ID,
);
ok(
	'Clear entry drops one, Clear all empties the list and goes with it',
	dropped === before - 1 && cleared?.rows === 0 && !cleared.clearAll,
	JSON.stringify({ before, dropped, cleared }),
);
await page.click('.xpDevToggle');
await painted(page);
const devOffView = await page.evaluate(() => ({
	list: !document.getElementById('xpListView').hidden,
	buttons: [
		...document.querySelectorAll('#spExtList .xpItemButtons .spBtn'),
	].map((button) => button.textContent),
}));
ok(
	'Developer mode turned off on the Errors view goes back to the list, with no Errors button',
	devOffView.list &&
		!devOffView.buttons.includes('Errors') &&
		!devOffView.buttons.includes('Warnings'),
	JSON.stringify(devOffView),
);

// ---- keyboard shortcuts
await page.click('#xpSide [data-nav="shortcuts"]');
const shortcutRows = (page) =>
	page.evaluate(
		(id) =>
			[
				...document.querySelectorAll(
					`#xpSubView .xpShortcutCard[data-ext="${id}"] .xpShortcut`,
				),
			].map((row) => [
				row.querySelector('.spRowLabel').textContent,
				row.querySelector('.xpShortcutInput').value,
				row.querySelector('.xpShortcutInput').placeholder,
				row.querySelector('select').disabled,
			]),
		PROBE_ID,
	);
const shortcuts = await until(
	page,
	(id) =>
		document.querySelectorAll(
			`#xpSubView .xpShortcutCard[data-ext="${id}"] .xpShortcut`,
		).length,
	(n) => n === 3,
	15000,
	PROBE_ID,
).then(() => shortcutRows(page));
const shortcutCards = await page.evaluate(() =>
	[...document.querySelectorAll('#xpSubView .xpShortcutCard')].map(
		(card) => card.dataset.ext,
	),
);
ok(
	"Keyboard shortcuts: only the extensions with commands or a button, Chrome's rows (Activate the extension, Ctrl + Shift + Y, Not set), the scope fixed for the action and an unset key",
	JSON.stringify(shortcuts) ===
		JSON.stringify([
			['Activate the extension', 'Ctrl + Shift + Y', 'Not set', true],
			['Do the thing', 'Alt + Shift + D', 'Not set', false],
			['No key yet', '', 'Not set', true],
		]) &&
		// (Chrome lists Activate the extension for any with a button)
		!shortcutCards.includes(ZIP_ID) &&
		shortcutCards.includes(WATCHER_ID),
	JSON.stringify({ shortcuts, shortcutCards }),
);
const KEY = `${PROBE_ID}|no-key`;
const note = () =>
	page.evaluate(
		() => document.querySelector('.xpShortcutNote')?.textContent ?? null,
	);
await page.click(`[data-control="${KEY}:edit"]`);
const typing = await page.evaluate(
	(key) =>
		document.querySelector(`[data-control="${CSS.escape(key)}:input"]`)
			.placeholder,
	KEY,
);
await page.keyboard.press('Shift+K');
const noCtrl = await note();
await page.keyboard.press('Control+Alt+K');
const both = await note();
await page.keyboard.press('Control+Shift+K');
const kept = await until(
	page,
	async () =>
		(await window.controller.extensions.commands()).find(
			(command) => command.name === 'no-key',
		)?.shortcut,
	(value) => value === 'Ctrl+Shift+K',
	10000,
);
ok(
	"typing a shortcut: Type a shortcut, Chrome's refusals (Include either Ctrl or Alt, Use either Ctrl or Alt), Ctrl+Shift+K kept",
	typing === 'Type a shortcut' &&
		noCtrl === 'Include either Ctrl or Alt' &&
		both === 'Use either Ctrl or Alt' &&
		kept === 'Ctrl+Shift+K',
	JSON.stringify({ typing, noCtrl, both, kept }),
);
await shot(page, 'shortcuts');
await closePage(page);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Alt+Shift+D');
const fired = await until(
	page,
	async (id) => (await window.controller.extensions.action(id)).badgeText,
	(value) => value === 'did',
	10000,
	PROBE_ID,
);
const firedTitle = await page.evaluate(
	async (id) => (await window.controller.extensions.action(id, null)).title,
	PROBE_ID,
);
ok(
	'its shortcut on the host page fires commands.onCommand with the tab',
	fired === 'did' && /command do-thing tab true/.test(firedTitle),
	JSON.stringify({ fired, firedTitle }),
);
const frame = await activeFrame(page);
await frame.evaluate(() => {
	document.body.tabIndex = -1;
	document.body.focus();
	window.sawKey = false;
	addEventListener('keydown', (event) => {
		if (event.code === 'KeyK') window.sawKey = true;
	});
});
await page.keyboard.press('Control+Shift+K');
const firedInPage = await until(
	page,
	async (id) => (await window.controller.extensions.action(id)).badgeText,
	(value) => value === 'nok',
	10000,
	PROBE_ID,
);
const pageSaw = await frame.evaluate(() => window.sawKey);
ok(
	'the shortcut typed on the page works from inside a proxied page, which never sees the key',
	firedInPage === 'nok' && pageSaw === false,
	JSON.stringify({ firedInPage, pageSaw }),
);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+Shift+Y');
const popupOpen = await until(
	page,
	() =>
		!!document.querySelector('#extPopup iframe') &&
		getComputedStyle(document.getElementById('extPopup')).display !== 'none',
	Boolean,
	10000,
);
ok("_execute_action's shortcut opens the popup", popupOpen === true);
await page.keyboard.press('Escape');
await page.mouse.click(10, 300);
await painted(page);

// a key another command has moves to the newest, and Clear
await openPage(page, { view: 'shortcuts' });
await until(
	page,
	() => document.querySelectorAll('#xpSubView .xpShortcut').length,
	(n) => n >= 3,
	10000,
);
await page.click(`[data-control="${PROBE_ID}|do-thing:edit"]`);
await page.keyboard.press('Control+Shift+Y');
const moved = await until(
	page,
	async () =>
		Object.fromEntries(
			(await window.controller.extensions.commands()).map((command) => [
				command.name,
				command.shortcut,
			]),
		),
	(value) => value?.['do-thing'] === 'Ctrl+Shift+Y',
	10000,
);
await painted(page);
await page.click(`[data-control="${PROBE_ID}|do-thing:clear"]`);
const clearedKey = await until(
	page,
	async () =>
		(await window.controller.extensions.commands()).find(
			(command) => command.name === 'do-thing',
		)?.shortcut,
	(value) => value === '',
	10000,
);
await painted(page);
const afterClear = await Promise.resolve().then(() => shortcutRows(page));
ok(
	"a key another command had moves to the newest (Chrome's), and Clear leaves it Not set",
	moved?.['do-thing'] === 'Ctrl+Shift+Y' &&
		!moved._execute_action &&
		clearedKey === '' &&
		afterClear[1]?.[1] === '' &&
		afterClear[0]?.[1] === '',
	JSON.stringify({ moved, clearedKey, afterClear }),
);
await closePage(page);

// ---- the button's menu: Manage extension and View web permissions
const menuEntry = async (label) => {
	await page.click(`#extActions [data-ext="${PROBE_ID}"]`, { button: 'right' });
	await painted(page);
	await page
		.locator('#extMenu > *', { hasText: new RegExp(`^${label}$`) })
		.click();
	await until(
		page,
		() => !document.getElementById('shieldsPage').classList.contains('hidden'),
		Boolean,
		5000,
	);
	await painted(page);
	return page.evaluate(() => ({
		view: document.getElementById('shieldsPage').dataset.view,
		title:
			!document.getElementById('xpSubView').hidden &&
			document.querySelector('#xpSubView .xpSubTitle')?.textContent,
		permissions: (() => {
			const main = document.getElementById('xpMain');
			const row = document.querySelector('[data-row="permissions"]');
			if (!row) return null;
			const top =
				row.getBoundingClientRect().top - main.getBoundingClientRect().top;
			// (at the top, or as near as the page's length lets it go)
			const most = main.scrollHeight - main.clientHeight;
			return {
				scrolled: Math.abs(top) < 2 || main.scrollTop >= most - 1,
				top,
				scrollTop: main.scrollTop,
			};
		})(),
	}));
};
const managed = await menuEntry('Manage extension');
await closePage(page);
const webPermissions = await menuEntry('View web permissions');
await closePage(page);
ok(
	"the button's menu: Manage extension opens its details, View web permissions too, at its permissions",
	managed.view === 'extensions' &&
		managed.title === PROBE_NAME &&
		webPermissions.title === PROBE_NAME &&
		webPermissions.permissions?.scrolled,
	JSON.stringify({ managed, webPermissions }),
);

// ---- remove
await openPage(page);
await page.click(`[data-control="${ZIP_ID}:remove"]`);
const question = await until(
	page,
	() => document.querySelector('#passkeyPrompt .title')?.textContent ?? null,
	Boolean,
	5000,
);
await shot(page, 'remove');
await answerDialog(page, 'Cancel');
const kept2 = (await cards(page)).some((card) => card.id === ZIP_ID);
await page.click(`[data-control="${ZIP_ID}:remove"]`);
await until(
	page,
	() => !!document.getElementById('passkeyPrompt'),
	Boolean,
	5000,
);
await answerDialog(page, 'Remove');
const gone = await until(
	page,
	(id) => !document.querySelector(`#spExtList [data-ext="${id}"]`),
	Boolean,
	10000,
	ZIP_ID,
);
const focusAfter = await until(
	page,
	() => document.activeElement?.dataset.control ?? null,
	(value) => !!value,
	3000,
);
const removedLog = await watcherLog(page, WATCHER_ID, (log) =>
	log?.some((entry) => entry[0] === 'onUninstalled'),
);
ok(
	`Remove asks "Remove "${ZIP_NAME}"?", Cancel keeps it, Remove uninstalls it, the focus on the next card's Remove`,
	question === `Remove "${ZIP_NAME}"?` &&
		kept2 &&
		gone === true &&
		focusAfter === `${STORE_ID}:remove`,
	JSON.stringify({ question, kept2, gone, focusAfter }),
);
ok(
	'the watcher heard the removal (onUninstalled with the id)',
	removedLog?.at(-1)?.[0] === 'onUninstalled' &&
		removedLog.at(-1)[1] === ZIP_ID,
	JSON.stringify(removedLog),
);

// ---- pack extension, through Chrome's dialog
await page.click('.xpDevToggle');
await painted(page);
await page.click('#xpPack');
await painted(page);
const packDialog = await page.evaluate(() => ({
	title: document.querySelector('#xpSubView .xpSubTitle')?.textContent,
	note: document.querySelector('#xpSubView .spSectionNote')?.textContent,
	labels: [
		...document.querySelectorAll('#xpSubView .xpPackRow .spRowLabel'),
	].map((label) => label.textContent),
	go: document.querySelector('[data-control="pack:go"]')?.disabled,
}));
await page.setInputFiles('#xpPackFolder', FOLDER);
await painted(page);
await shot(page, 'pack');
const downloads = [];
page.on('download', (download) => downloads.push(download));
await page.click('[data-control="pack:go"]');
const packAlert = await until(
	page,
	() => document.querySelector('#xpSubView .xpPackDone')?.innerText ?? null,
	Boolean,
	20000,
);
await painted(page);
const deadline = Date.now() + 10000;
while (downloads.length < 2 && Date.now() < deadline) await sleep(100);
const names = downloads.map((download) => download.suggestedFilename()).sort();
const crx = downloads.find((download) =>
	download.suggestedFilename().endsWith('.crx'),
);
const crxBytes = crx ? readFileSync(await crx.path()) : null;
ok(
	"Pack extension: Chrome's dialog, then Created the following files with the crx and its key, both saved",
	packDialog.title === 'Pack extension' &&
		packDialog.note ===
			'Select the root directory of the extension to pack. To update an extension, also select the private key file to reuse.' &&
		JSON.stringify(packDialog.labels) ===
			JSON.stringify([
				'Extension root directory',
				'Private key file (optional)',
			]) &&
		packDialog.go === true &&
		/^Created the following files:/.test(packAlert ?? '') &&
		/Extension: manager-probe\.crx/.test(packAlert) &&
		/Key File: manager-probe\.pem/.test(packAlert) &&
		JSON.stringify(names) ===
			JSON.stringify(['manager-probe.crx', 'manager-probe.pem']) &&
		crxBytes?.subarray(0, 4).toString() === 'Cr24',
	JSON.stringify({ packDialog, packAlert, names }),
);
await page.click('[data-control="pack:ok"]');
await painted(page);
await page.setInputFiles('#spExtFileInput', {
	name: 'manager-probe.crx',
	mimeType: 'application/x-chrome-extension',
	buffer: crxBytes,
});
const packedIn = await until(
	page,
	async (probe) =>
		(await window.controller.extensions.list()).filter(
			(info) => info.name === probe,
		),
	(value) => value?.length === 2,
	20000,
	PROBE_NAME,
);
const packedInfo = packedIn?.find((entry) => entry.id !== PROBE_ID);
ok(
	'the packed CRX installs, as a file, under an id of its own key',
	!!packedInfo &&
		packedInfo.source !== 'unpacked' &&
		/^[a-p]{32}$/.test(packedInfo.id),
	JSON.stringify(packedIn),
);
if (packedInfo)
	await page.evaluate(
		(id) => window.controller.extensions.remove(id),
		packedInfo.id,
	);
await closePage(page);
errors.push(...page.errors);

// ---- a phone's width
const phone = await openDemo(browser, HOST, { width: 390, height: 844 });
await openPage(phone);
await painted(phone);
const fit = await phone.evaluate(() => {
	const dialog = document.getElementById('shieldsPage');
	const r = dialog.getBoundingClientRect();
	const body = document.getElementById('xpMain');
	const side = document.getElementById('xpSide');
	return {
		left: r.left,
		right: r.right,
		scroll: body.scrollWidth - body.clientWidth,
		side: getComputedStyle(side).visibility,
		menu: getComputedStyle(document.getElementById('xpMenu')).display,
		// (the title, Developer mode and the close button on one row, the search under them)
		rows: [
			document.getElementById('xpMenu'),
			document.getElementById('shieldsPageTitle'),
			document.getElementById('xpDevMode'),
			document.getElementById('spClose'),
			document.getElementById('xpSearch'),
		].map((part) => {
			const box = part.getBoundingClientRect();
			return Math.round((box.top + box.bottom) / 2 / 16);
		}),
	};
});
await phone.click('#xpMenu');
await painted(phone);
const sideOpen = await phone.evaluate(
	() => getComputedStyle(document.getElementById('xpSide')).visibility,
);
await shot(phone, 'phone');
ok(
	'390px: the page fits with no horizontal scroll, its head on one row over the search, the side nav behind the menu button',
	fit.left >= 0 &&
		fit.right <= 390 &&
		fit.scroll <= 0 &&
		fit.side === 'hidden' &&
		fit.menu !== 'none' &&
		new Set(fit.rows.slice(0, 4)).size === 1 &&
		fit.rows[4] > fit.rows[0] &&
		sideOpen === 'visible',
	JSON.stringify({ fit, sideOpen }),
);
errors.push(...phone.errors);
await phone.close();

server.close();
ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
