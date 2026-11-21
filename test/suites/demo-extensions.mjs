// The demo's extensions UI (docs/extensions.md), on a probe extension built
// here and added as a .zip through the Extensions page:
//  - the puzzle piece after the address box lists the extensions and opens
//    the Extensions page, as does the menu's Extensions item;
//  - the page adds a .zip (its card: name, Chrome's badge for a file; its
//    details: version, source, site access), says what a bad Web Store address
//    did, turns an extension off and on, and removes it after asking;
//  - the bar's button for the extension (pinned as Chrome 157 pins a new
//    one), its initial for an icon, the badge its background set for the
//    tab and Chrome's tooltip, after the address box;
//  - a click shows its popup under the button, in Chrome's bubble, sized
//    as its document asks; the popup's window.close() closes it, and so do
//    a click outside and Escape, which unload it;
//  - its menu (a right click), entry for entry Chrome 157's: its name, its
//    own action items, its site access submenu, Options, Remove, Unpin,
//    Manage extension, View web permissions; the arrows move and open the
//    submenu, an item chosen reaches the background;
//  - the menus, one open at a time: a right click on the button opens its
//    menu while the list, the main menu or its popup is open, which close;
//    the menu is the main menu's popover; it closes on a press in the
//    proxied page's frame, on the bar, a right click in the page, Escape,
//    the window losing the focus and another tab; in the list, a press
//    outside More options' menu closes only the menu (Manage extensions
//    waits for the next click); one that opens over the Extensions page is
//    in front of it, closed by a press on the page and by Escape before the
//    page, and the page opening closes one open under it;
//  - the puzzle piece's list as Chrome's extensions menu: the sections by
//    access, the pin; unpinned, the button leaves the bar and pops out
//    while its popup shows;
//  - Remove from its menu asks in Chrome's dialog, then it is gone;
//  - the address bar's status chip stays the service worker's and the
//    transport's: nothing of the extension's install, pins, a failed call
//    or its removal shows there (Chrome says "Extension pinned" to a screen
//    reader only);
//  - Options opens its page in a tab whose bar shows chrome-extension://,
//    and such an address typed in the bar opens it; no shields there;
//  - the content script runs in the tab's page;
//  - the cards' copies of the bar carry the buttons as pictures;
//  - at 390px the buttons give way to the puzzle piece and at 320px the
//    piece to the menu's item: the address box keeps 120px, the list, a
//    popup and the page fit the window;
//  - back on the home page from the Extensions page (closed over it, or
//    closed in a tab and then Home or Back), the search box keeps its
//    width, its right edge and its gap to Go on every frame, the home
//    screen's zoom in included;
//  - the same on the same-origin host (the bar's button, its popup), the
//    popup shown at its size with the Shields panel's open animation, the
//    first click after a reload, and a tab older than its worker (a deploy),
//    whose buttons, list and menus work from the first click.
// (the demo page's own globals, read in the page)
/* global activateTab, extAnchor, extButton, openExtensionsPage, openExtMenu, tabs */
import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
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

const PAGE = `${FIXTURE}pages/bookmark-a.html`;
const NAME = 'Demo probe';

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

const PROBE = zip({
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: NAME,
		version: '1.0',
		description: 'The demo suite probe.',
		permissions: ['storage', 'contextMenus'],
		host_permissions: ['<all_urls>'],
		background: { service_worker: 'background.js' },
		action: { default_title: 'Demo probe', default_popup: 'popup.html' },
		options_page: 'options.html',
		content_scripts: [
			{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' },
		],
	}),
	'background.js': `
chrome.contextMenus.removeAll(() => {
	chrome.contextMenus.create({ id: 'hi', title: 'Say hi', contexts: ['action'] });
	chrome.contextMenus.create({ id: 'page', title: 'Page item', contexts: ['page'] });
});
chrome.action.setBadgeText({ text: '7' });
chrome.action.setBadgeBackgroundColor({ color: '#d33' });
chrome.contextMenus.onClicked.addListener((info) => {
	if (info.menuItemId === 'hi') chrome.action.setBadgeText({ text: 'hi' });
});`,
	'popup.html': `<!doctype html><meta charset="utf-8"><title>Probe popup</title>
<body style="margin:0;font:14px sans-serif">
<div id="box" style="width:300px;height:160px">Probe popup</div>
<button id="close">Close</button>
<script src="popup.js"></script></body>`,
	'popup.js': `document.getElementById('close').onclick = () => window.close();`,
	'options.html': `<!doctype html><meta charset="utf-8"><title>Probe options</title><h1>Options</h1>`,
	'content.js': `document.documentElement.dataset.probeExt = '1';`,
});
const PROBE_FILE = {
	name: 'probe.zip',
	mimeType: 'application/zip',
	buffer: PROBE,
};

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
	await sleep(50);
};

/** where an element is, and whether it is what the page shows there */
const box = (page, selector) =>
	page.evaluate((selector) => {
		const element = document.querySelector(selector);
		if (!element) return null;
		const r = element.getBoundingClientRect();
		const hit = document.elementFromPoint(
			r.left + r.width / 2,
			r.top + r.height / 2,
		);
		return {
			left: Math.round(r.left),
			top: Math.round(r.top),
			right: Math.round(r.right),
			bottom: Math.round(r.bottom),
			width: Math.round(r.width),
			height: Math.round(r.height),
			display: getComputedStyle(element).display,
			visible:
				r.width > 0 &&
				getComputedStyle(element).visibility === 'visible' &&
				(hit === element || element.contains(hit)),
		};
	}, selector);

/** the bar's extension buttons */
const barButtons = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#extActions .extAction')].map((button) => ({
			id: button.dataset.ext,
			label: button.getAttribute('aria-label'),
			letter: button.querySelector('.extLetter')?.textContent ?? null,
			badge: button.querySelector('.extBadge')?.hidden
				? ''
				: (button.querySelector('.extBadge')?.textContent ?? ''),
			badgeColor: getComputedStyle(button.querySelector('.extBadge'))
				.backgroundColor,
			shown: button.getClientRects().length > 0,
		})),
	);

/** the Extensions page's cards */
const cards = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#spExtList .extCard')].map((card) => ({
			id: card.dataset.ext,
			name: card.querySelector('.spListName')?.textContent,
			on: card.querySelector('.shieldsToggle')?.checked,
			badge:
				card.querySelector('.xpSourceBadge')?.getAttribute('aria-label') ??
				null,
			buttons: [...card.querySelectorAll('.extButtons .spBtn')].map(
				(button) => button.textContent,
			),
		})),
	);

const status = (page) =>
	page.evaluate(() => {
		const line = document.querySelector('#shieldsPage .spStatus');
		return line
			? { text: line.textContent, bad: line.classList.contains('bad') }
			: null;
	});

/** the demo in the browser view on the fixture page */
async function browsing(base, viewport = {}) {
	const page = await openDemo(browser, base, viewport);
	page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
	await submitLanding(page, PAGE);
	await until(
		page,
		() =>
			!document.getElementById('browser').classList.contains('hidden') &&
			/bookmark-a/.test(document.querySelector('#omni input').value),
		Boolean,
	);
	return page;
}

/** the submenu: open, beside its item, its rows (checked, off), the focus */
const subMenuState = (page) =>
	page.evaluate(() => {
		const sub = document.querySelector('.extSubmenu');
		const owner = document.querySelector(
			'[aria-haspopup="menu"][aria-expanded="true"]',
		);
		const r = sub.getBoundingClientRect();
		const o = owner?.getBoundingClientRect();
		return {
			open: !sub.classList.contains('hidden'),
			entries: [...sub.children].map((item) =>
				item.classList.contains('extMenuRule')
					? '---'
					: `${item.getAttribute('aria-checked') === 'true' ? '(x) ' : ''}${item.disabled ? '(off) ' : ''}${(item.querySelector('.extMenuLabel') ?? item).textContent.trim()}`,
			),
			expanded: document
				.getElementById('menuExtensions')
				.getAttribute('aria-expanded'),
			beside: !!o && (r.left >= o.right - 1 || r.right <= o.left + 1),
			focused: document.activeElement?.textContent?.trim(),
		};
	});

/** add the probe through the Extensions page (from the puzzle's list, or the menu's Extensions) */
async function addProbe(page, { viaMenu = false } = {}) {
	if (viaMenu) {
		await page.click('#toolMenu');
		await painted(page);
		await page.click('#menuExtensions');
		await painted(page);
		await page.click('.extSubmenu [data-command="manage"]');
	} else {
		await page.click('#toolExtensions');
		await painted(page);
		await page.click('#extPanel .extManage');
	}
	await painted(page);
	await page.setInputFiles('#spExtFileInput', PROBE_FILE);
	const added = await until(
		page,
		(name) =>
			[...document.querySelectorAll('#spExtList .extCard')].some((card) =>
				card.querySelector('.spListName')?.textContent.startsWith(name),
			),
		Boolean,
		30000,
		NAME,
	);
	return added;
}

/** the frame of the popup, once its document has loaded */
async function popupFrame(page) {
	const start = Date.now();
	while (Date.now() - start < 20000) {
		// (the frame is named once it is in the page: Chrome keeps the
		// browsing context's first name, so it is found by its document)
		for (const frame of page.frames()) {
			const ready = await frame
				.evaluate(
					() =>
						document.title === 'Probe popup' &&
						!!document.getElementById('box'),
				)
				.catch(() => false);
			if (ready) return frame;
		}
		await sleep(150);
	}
	return null;
}

const popupState = (page) =>
	page.evaluate(() => {
		const panel = document.getElementById('extPopup');
		const frame = panel.querySelector('iframe');
		const r = panel.getBoundingClientRect();
		return {
			open: getComputedStyle(panel).display !== 'none',
			frames: panel.querySelectorAll('iframe').length,
			width: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
			height: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
			left: Math.round(r.left),
			right: Math.round(r.right),
			top: Math.round(r.top),
		};
	});

// ---- the isolated host, desktop ------------------------------------------------
// The home card's Extensions tab mirrors the left Bookmarks tab, and
// opens the same page as Manage extensions with its own keyboard focus.
const home = await openDemo(browser, HOST);
for (const viewport of [
	{ width: 1280, height: 800 },
	{ width: 844, height: 390 },
	{ width: 412, height: 915 },
	{ width: 320, height: 568 },
]) {
	await home.setViewportSize(viewport);
	const edge = await home.evaluate(() => {
		const rect = (selector) => {
			const box = document.querySelector(selector).getBoundingClientRect();
			return {
				left: box.left,
				right: box.right,
				top: box.top,
				bottom: box.bottom,
			};
		};
		return {
			card: rect('.listing'),
			bookmarks: rect('#bookmarksTab'),
			extensions: rect('#extensionsTab'),
			label: document
				.querySelector('#extensionsTab')
				.getAttribute('aria-label'),
		};
	});
	ok(
		`home at ${viewport.width}x${viewport.height}: Extensions hangs off the right edge opposite Bookmarks`,
		edge.label === 'Extensions' &&
			Math.abs(edge.card.right - edge.extensions.right - 1) <= 1 &&
			Math.abs(edge.bookmarks.left - edge.card.left - 1) <= 1 &&
			Math.abs(edge.bookmarks.top - edge.extensions.top) <= 1 &&
			Math.abs(edge.bookmarks.bottom - edge.extensions.bottom) <= 1,
		JSON.stringify(edge),
	);
}
await home.setViewportSize({ width: 1280, height: 800 });
await home.focus('#extensionsTab');
await home.keyboard.press('Enter');
await painted(home);
ok(
	'Enter on the home Extensions tab opens the manager',
	await home.evaluate(() => {
		const manager = document.getElementById('shieldsPage');
		return (
			!manager.classList.contains('hidden') &&
			manager.dataset.view === 'extensions' &&
			document.getElementById('shieldsPageTitle').textContent === 'Extensions'
		);
	}),
);
await home.keyboard.press('Escape');
ok(
	'Escape closes the home Extensions manager and returns focus to its tab',
	await home.evaluate(
		() =>
			document.getElementById('shieldsPage').classList.contains('hidden') &&
			document.activeElement?.id === 'extensionsTab',
	),
);
await home.close();

const page = await browsing(HOST);
// every text the address bar's status chip shows from here on
await page.evaluate(() => {
	const chip = document.getElementById('chromeStatus');
	window.__chipSaid = [chip.textContent];
	new MutationObserver(() => window.__chipSaid.push(chip.textContent)).observe(
		chip,
		{ childList: true, characterData: true, subtree: true },
	);
});
const puzzle = await box(page, '#toolExtensions');
const omniBox = await box(page, '#omni');
const menuBox = await box(page, '#toolMenu');
ok(
	'the puzzle piece sits after the address box, before the menu button',
	puzzle?.visible &&
		puzzle.left >= omniBox.right &&
		puzzle.right <= menuBox.left,
	JSON.stringify({ puzzle, omniBox, menuBox }),
);
await page.click('#toolExtensions');
await painted(page);
const empty = await page.evaluate(() => ({
	open: getComputedStyle(document.getElementById('extPanel')).display,
	text: document.getElementById('extPanel').textContent,
	expanded: document
		.getElementById('toolExtensions')
		.getAttribute('aria-expanded'),
}));
ok(
	'with none installed the list says so and offers Manage extensions',
	empty.open !== 'none' &&
		/No extensions yet/.test(empty.text) &&
		/Manage extensions/.test(empty.text) &&
		empty.expanded === 'true',
	JSON.stringify(empty),
);
await page.click('#extPanel .extManage');
await painted(page);
const view = await page.evaluate(() => ({
	view: document.getElementById('shieldsPage').dataset.view,
	title: document.getElementById('shieldsPageTitle')?.textContent,
	panel: getComputedStyle(document.getElementById('extPanel')).display,
}));
ok(
	'Manage extensions opens the Extensions page, the list gone',
	view.view === 'extensions' &&
		view.title === 'Extensions' &&
		view.panel === 'none',
	JSON.stringify(view),
);

// a Web Store address that is none: the page says why, nothing is added
await page.fill('#spExtStore', 'not an extension');
await page.click('#spExtAdd');
const bad = await until(
	page,
	() =>
		document
			.querySelector('#shieldsPage .spStatus')
			?.classList.contains('bad') &&
		document.querySelector('#shieldsPage .spStatus').textContent,
	Boolean,
	15000,
);
ok(
	'a bad Web Store address says what went wrong, and nothing is added',
	typeof bad === 'string' &&
		bad.length > 10 &&
		!/Adding/.test(bad) &&
		(await cards(page)).length === 0,
	JSON.stringify({ bad, cards: await cards(page) }),
);

await page.setInputFiles('#spExtFileInput', PROBE_FILE);
const added = await until(
	page,
	(name) =>
		[...document.querySelectorAll('#spExtList .extCard')].some((card) =>
			card.querySelector('.spListName')?.textContent.startsWith(name),
		),
	Boolean,
	30000,
	NAME,
);
let list = await cards(page);
const id = list[0]?.id;
ok(
	"a .zip from the file button: its card, on, Chrome's badge for a file, Details and Remove",
	added &&
		list.length === 1 &&
		/^[a-p]{32}$/.test(id) &&
		list[0].name === NAME &&
		list[0].on === true &&
		list[0].badge === 'Not from Chrome Web Store.' &&
		JSON.stringify(list[0].buttons) === JSON.stringify(['Details', 'Remove']),
	JSON.stringify(list),
);
const addedStatus = await status(page);
await page.click(`[data-control="${id}:details"]`);
await painted(page);
const facts = await page.evaluate(() =>
	Object.fromEntries(
		[...document.querySelectorAll('#xpSubView .xpDetails > *')].map((row) => [
			row.querySelector('.spRowLabel')?.textContent,
			[...row.querySelectorAll('.spRowSub')].map((sub) => sub.textContent),
		]),
	),
);
await page.click('#xpSubView .xpBack');
await painted(page);
ok(
	'its details: its version, a file as source, site access on all sites, its options',
	facts.Version?.[0] === '1.0' &&
		facts.Source?.[0] === 'Not from Chrome Web Store.' &&
		!!facts['Site access'] &&
		!!facts['Extension options'],
	JSON.stringify(facts),
);
ok(
	'the page says it was added',
	addedStatus?.text === `Added ${NAME} 1.0.` && !addedStatus.bad,
	JSON.stringify(addedStatus),
);
await page.keyboard.press('Escape');

await until(
	page,
	() =>
		[...document.querySelectorAll('#extActions .extAction')].map((b) => ({
			badge: b.querySelector('.extBadge')?.textContent,
		})),
	(value) => value?.[0]?.badge === '7',
);
const buttons = await barButtons(page);
ok(
	"the bar's button: its title, its initial, the badge and colour its background set",
	buttons.length === 1 &&
		buttons[0].id === id &&
		buttons[0].label === 'Demo probe\nHas access to this site' &&
		buttons[0].letter === 'D' &&
		buttons[0].badge === '7' &&
		buttons[0].badgeColor === 'rgb(221, 51, 51)' &&
		buttons[0].shown,
	JSON.stringify(buttons),
);
const actionBox = await box(page, '#extActions');
ok(
	'the buttons sit between the address box and the puzzle piece',
	actionBox.left >= omniBox.left &&
		actionBox.right <= (await box(page, '#toolExtensions')).left,
	JSON.stringify({ actionBox }),
);

// the content script, in a document the tab loads now
await page.click('#toolReload');
const ran = await (async () => {
	const start = Date.now();
	while (Date.now() - start < 30000) {
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() =>
					document.title === 'Bookmark A'
						? document.documentElement.dataset.probeExt
						: null,
				)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(200);
	}
	return null;
})();
ok("the content script ran in the tab's page", ran === '1', String(ran));

// the popup: under its button, sized as its document asks
await page.click(`#extActions .extAction[data-ext="${id}"]`);
let frame = await popupFrame(page);
await until(
	page,
	() => {
		const f = document.querySelector('#extPopup iframe');
		return f ? Math.round(f.getBoundingClientRect().width) : 0;
	},
	(width) => width >= 280,
	15000,
);
let popup = await popupState(page);
const anchor = await box(page, `#extActions .extAction[data-ext="${id}"]`);
ok(
	'a click shows the popup under its button, its document loaded and sized as it asks',
	!!frame &&
		popup.open &&
		popup.width >= 280 &&
		popup.width <= 340 &&
		popup.height >= 150 &&
		popup.height <= 260 &&
		popup.top >= anchor.bottom &&
		Math.abs(popup.right - anchor.right) <= 2,
	JSON.stringify({ popup, anchor }),
);
await frame.click('#close');
popup = await until(
	page,
	() => getComputedStyle(document.getElementById('extPopup')).display,
	(d) => d === 'none',
	10000,
);
ok("the popup's window.close() closes it", popup === 'none', String(popup));

await page.click(`#extActions .extAction[data-ext="${id}"]`);
frame = await popupFrame(page);
await page.keyboard.press('Escape');
await page.mouse.click(10, 300); // (Escape stays in the popup's document; a click outside)
await painted(page);
popup = await popupState(page);
ok(
	'a click outside closes the popup and unloads it',
	!!frame && !popup.open && popup.frames === 0,
	JSON.stringify(popup),
);

// its menu: the extension's own action items, then the browser's
await page.click(`#extActions .extAction[data-ext="${id}"]`, {
	button: 'right',
});
await painted(page);
const menu = await page.evaluate(() => ({
	open: getComputedStyle(document.getElementById('extMenu')).display !== 'none',
	entries: [...document.querySelectorAll('#extMenu > *')].map((item) =>
		item.classList.contains('extMenuRule')
			? '---'
			: `${item.disabled ? '(off) ' : ''}${item.textContent.trim()}`,
	),
	focused: document.activeElement?.textContent?.trim(),
}));
ok(
	"a right click opens its menu, Chrome 157's: its name, its action items (not its page ones), site access, Options, Remove, Unpin, Manage, View web permissions",
	menu.open &&
		JSON.stringify(menu.entries) ===
			JSON.stringify([
				`(off) ${NAME}`,
				'---',
				'Say hi',
				'---',
				'This can read and change site data',
				'---',
				'Options',
				'Remove from powerMouse',
				'Unpin',
				'---',
				'Manage extension',
				'View web permissions',
			]) &&
		menu.focused === 'Say hi',
	JSON.stringify(menu),
);
await page.keyboard.press('ArrowDown');
const movedTo = await page.evaluate(() =>
	document.activeElement?.textContent?.trim(),
);
await page.keyboard.press('ArrowRight');
await painted(page);
const submenu = await page.evaluate(() => ({
	open: !document.querySelector('.extSubmenu').classList.contains('hidden'),
	entries: [...document.querySelectorAll('.extSubmenu > *')].map((item) =>
		item.classList.contains('extMenuRule')
			? '---'
			: `${item.getAttribute('aria-checked') === 'true' ? '(x) ' : ''}${item.textContent.trim()}`,
	),
	focused: document.activeElement?.textContent?.trim(),
}));
await page.keyboard.press('ArrowLeft');
const backTo = await page.evaluate(() =>
	document.activeElement?.textContent?.trim(),
);
ok(
	"the right arrow opens the site access submenu, Chrome's radios checked on all sites; the left arrow goes back",
	submenu.open &&
		JSON.stringify(submenu.entries) ===
			JSON.stringify([
				'When you click the extension',
				'On 127.0.0.1',
				'(x) On all sites',
				'---',
				'Learn more about site access',
			]) &&
		submenu.focused === 'When you click the extension' &&
		backTo === 'This can read and change site data',
	JSON.stringify({ submenu, backTo }),
);
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
const hi = await until(
	page,
	() => document.querySelector('#extActions .extBadge')?.textContent,
	(text) => text === 'hi',
	15000,
);
ok(
	'the arrows move in the menu, and an item chosen reaches its background (contextMenus.onClicked)',
	movedTo === 'This can read and change site data' && hi === 'hi',
	JSON.stringify({ movedTo, hi }),
);

// the menu's Extensions: Chrome 157's submenu (ExtensionsMenuModel),
// Manage extensions and Visit Chrome Web Store, opened by the pointer and
// by the keyboard
await page.click('#toolMenu');
await painted(page);
await page.hover('#menuExtensions');
await painted(page);
const appExtensions = await subMenuState(page);
ok(
	"the menu's Extensions opens under the pointer: Chrome 157's submenu, beside it",
	appExtensions.open &&
		JSON.stringify(appExtensions.entries) ===
			JSON.stringify(['Manage extensions', 'Visit Chrome Web Store']) &&
		appExtensions.expanded === 'true' &&
		appExtensions.beside,
	JSON.stringify(appExtensions),
);
await page.hover('#menuAbout');
await painted(page);
const afterAbout = await subMenuState(page);
ok(
	'another item under the pointer closes it',
	!afterAbout.open && afterAbout.expanded === 'false',
	JSON.stringify(afterAbout),
);
await page.focus('#menuExtensions');
await page.keyboard.press('ArrowRight');
await painted(page);
const byKeys = await subMenuState(page);
await page.keyboard.press('ArrowDown');
const secondRow = await page.evaluate(() =>
	document.activeElement?.textContent?.trim(),
);
await page.keyboard.press('ArrowDown');
const wrappedRow = await page.evaluate(() =>
	document.activeElement?.textContent?.trim(),
);
await page.keyboard.press('ArrowLeft');
const leftTo = await subMenuState(page);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Escape');
const escapedTo = await subMenuState(page);
const menuStill = await page.evaluate(
	() => !document.getElementById('pmMenu').classList.contains('hidden'),
);
ok(
	'the right arrow opens it on its first row, the arrows go round it, the left arrow and Escape close it alone',
	byKeys.open &&
		byKeys.focused === 'Manage extensions' &&
		secondRow === 'Visit Chrome Web Store' &&
		wrappedRow === 'Manage extensions' &&
		!leftTo.open &&
		leftTo.focused === 'Extensions' &&
		!escapedTo.open &&
		escapedTo.focused === 'Extensions' &&
		menuStill,
	JSON.stringify({
		byKeys,
		secondRow,
		wrappedRow,
		leftTo,
		escapedTo,
		menuStill,
	}),
);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await painted(page);
const managed = await page.evaluate(() => ({
	view: document.getElementById('shieldsPage').dataset.view,
	menu: !document.getElementById('pmMenu').classList.contains('hidden'),
	sub: !document.querySelector('.extSubmenu').classList.contains('hidden'),
}));
ok(
	'Manage extensions opens the Extensions page, the menus closed',
	managed.view === 'extensions' && !managed.menu && !managed.sub,
	JSON.stringify(managed),
);
await page.keyboard.press('Escape');
await painted(page);

// the menu's Themes, over globalThis.PMTheme (a stand-in where the demo
// has no theme system): none without it, the themes with a check on the
// one shown, Get themes and Reset to default
await page.evaluate(() => {
	globalThis.keptPMTheme = globalThis.PMTheme;
	delete globalThis.PMTheme;
});
await page.click('#toolMenu');
await painted(page);
const withoutThemes = await page.evaluate(
	() => document.getElementById('menuThemes').hidden,
);
await page.keyboard.press('Escape');
await page.evaluate(() => {
	if (globalThis.keptPMTheme) {
		globalThis.PMTheme = globalThis.keptPMTheme;
		return;
	}
	const events = new EventTarget();
	const themes = [
		['default', 'Default'],
		['light', 'Light'],
		['dark', 'Dark'],
		['systemya-light', 'SystemYA Light'],
		['system', 'Follow system'],
	].map(([id, name]) => ({ id, name, source: 'builtin' }));
	let shown = 'default';
	globalThis.PMTheme = {
		list: () => themes,
		current: () => themes.find((theme) => theme.id === shown),
		apply(theme) {
			shown = typeof theme === 'string' ? theme : theme.id;
			events.dispatchEvent(
				new CustomEvent('change', { detail: { reason: 'apply', id: shown } }),
			);
		},
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	};
});
await page.click('#toolMenu');
await painted(page);
await page.hover('#menuThemes');
await painted(page);
const themesMenu = await subMenuState(page);
ok(
	'Themes: hidden without PMTheme; with it the themes, a check on the one shown, Get themes and Reset to default (off at the default)',
	withoutThemes &&
		themesMenu.open &&
		JSON.stringify(themesMenu.entries.slice(0, 5)) ===
			JSON.stringify([
				'(x) Default',
				'Light',
				'Dark',
				'SystemYA Light',
				'Follow system',
			]) &&
		JSON.stringify(themesMenu.entries.slice(-3)) ===
			JSON.stringify(['---', 'Get themes', '(off) Reset to default']),
	JSON.stringify({ withoutThemes, themesMenu }),
);
await page.click('.extSubmenu [data-theme="dark"]');
await painted(page);
const darkShown = await page.evaluate(() => ({
	shown: globalThis.PMTheme.current().id,
	menu: !document.getElementById('pmMenu').classList.contains('hidden'),
}));
await page.click('#toolMenu');
await painted(page);
await page.hover('#menuThemes');
await painted(page);
const afterDark = await subMenuState(page);
// a change made elsewhere shows in the open submenu at once
await page.evaluate(() => globalThis.PMTheme.apply('light'));
await painted(page);
const followed = await subMenuState(page);
await page.click('.extSubmenu [data-command="resetTheme"]');
await painted(page);
const reset = await page.evaluate(() => globalThis.PMTheme.current().id);
ok(
	'a theme chosen there is shown and checked, the open submenu follows a change, Reset to default goes back',
	darkShown.shown === 'dark' &&
		!darkShown.menu &&
		afterDark.entries.includes('(x) Dark') &&
		!afterDark.entries.includes('(off) Reset to default') &&
		followed.entries.includes('(x) Light') &&
		!followed.entries.includes('(x) Dark') &&
		reset === 'default',
	JSON.stringify({ darkShown, afterDark, followed, reset }),
);

// the puzzle piece's list, with the badge
await page.click('#toolExtensions');
await painted(page);
const listed = await page.evaluate(() => ({
	open:
		getComputedStyle(document.getElementById('extPanel')).display !== 'none',
	rows: [...document.querySelectorAll('#extPanel .extRow')].map((row) => ({
		name: row.querySelector('.extRowName')?.textContent,
		badge: row.querySelector('.extBadge')?.hidden
			? ''
			: row.querySelector('.extBadge')?.textContent,
	})),
}));
ok(
	"the puzzle piece's list: the extension and its badge",
	listed.open &&
		JSON.stringify(listed.rows) ===
			JSON.stringify([{ name: NAME, badge: 'hi' }]),
	JSON.stringify(listed),
);
const sections = await page.evaluate(() => ({
	title: document.querySelector('#extPanel .extPanelTitle')?.textContent,
	heads: [...document.querySelectorAll('#extPanel .extPanelHead')].map(
		(head) => head.textContent,
	),
	pin: document.querySelector('#extPanel .extPin')?.getAttribute('aria-label'),
	more: document
		.querySelector('#extPanel .extRowMore[aria-haspopup]')
		?.getAttribute('aria-label'),
}));
ok(
	"the list is Chrome's extensions menu: its title, the extension under Full access, its pin and More options",
	sections.title === 'Extensions' &&
		JSON.stringify(sections.heads) === JSON.stringify(['Full access']) &&
		sections.pin === `Unpin ${NAME}` &&
		sections.more === `More options for ${NAME}`,
	JSON.stringify(sections),
);
// a right click on its row: the same menu as More options, without Pin
await page.click('#extPanel .extRowMain', { button: 'right' });
await painted(page);
const rowMenu = await page.evaluate(() =>
	[...document.querySelectorAll('#extMenu .pmMenuItem')].map((item) =>
		item.textContent.trim(),
	),
);
await page.keyboard.press('Escape');
ok(
	"a right click on its row in the list opens its menu there, without Pin or Unpin (Chrome's More options)",
	rowMenu.includes('Remove from powerMouse') &&
		rowMenu.includes('Manage extension') &&
		!rowMenu.includes('Unpin') &&
		!rowMenu.includes('Pin'),
	JSON.stringify(rowMenu),
);
// unpinned from the list: its button leaves the bar, and pops out while
// its popup shows
await page.click('#extPanel .extPin');
const unpinned = await until(
	page,
	() => ({
		bar: document.querySelectorAll('#extActions .extAction').length,
		pin: document
			.querySelector('#extPanel .extPin')
			?.getAttribute('aria-label'),
	}),
	(value) => value?.bar === 0 && /^Pin /.test(value.pin ?? ''),
	15000,
);
await page.click('#extPanel .extRowMain');
await popupFrame(page);
const popped = await page.evaluate(() => {
	const button = document.querySelector('#extActions .extAction');
	const popup = document.getElementById('extPopup').getBoundingClientRect();
	const r = button?.getBoundingClientRect();
	return {
		buttons: document.querySelectorAll('#extActions .extAction').length,
		pressed: button?.getAttribute('aria-expanded'),
		under: r ? Math.abs(popup.right - r.right) <= 2 : false,
		list: getComputedStyle(document.getElementById('extPanel')).display,
	};
});
await page.mouse.click(10, 300);
const back = await until(
	page,
	() => document.querySelectorAll('#extActions .extAction').length,
	(n) => n === 0,
	10000,
);
ok(
	'unpinned: its button leaves the bar, pops out (pressed) under its popup from the list, and goes when the popup closes',
	unpinned?.bar === 0 &&
		popped.buttons === 1 &&
		popped.pressed === 'true' &&
		popped.under &&
		popped.list === 'none' &&
		back === 0,
	JSON.stringify({ unpinned, popped, back }),
);
await page.click('#toolExtensions');
await painted(page);
await page.click('#extPanel .extPin');
const repinned = await until(
	page,
	() => document.querySelectorAll('#extActions .extAction').length,
	(n) => n === 1,
	15000,
);
ok(
	'pinned again: its button is back on the bar',
	repinned === 1,
	String(repinned),
);
await page.keyboard.press('Escape');

// the menus: an extension's opens on a right click on its button whatever
// is open, one menu or popup at a time, and closes wherever the press
// outside it lands (the proxied page's frame, the list it opened from, the
// bar), on Escape, when the window loses the focus or the tab changes
const opened = (page) =>
	page.evaluate(() =>
		Object.fromEntries(
			['extMenu', 'extPanel', 'extPopup', 'pmMenu', 'shieldsPage'].map(
				(name) => [
					name,
					!document.getElementById(name).classList.contains('hidden'),
				],
			),
		),
	);
/** only these of opened()'s are open */
const onlyOpen = (state, ...names) =>
	!!state &&
	Object.entries(state).every(([name, open]) => open === names.includes(name));
const extButtonOf = `#extActions .extAction[data-ext="${id}"]`;
const settled = async () => {
	await painted(page);
	await sleep(100);
	return opened(page);
};
/** a point of `box` that the extension's menu is not over (its scrim is) */
const outsideMenu = (box) =>
	page.evaluate((r) => {
		for (let y = r.top + 4; y < r.bottom; y += 8)
			for (let x = r.left + 4; x < r.right; x += 8)
				if (document.elementFromPoint(x, y)?.id === 'extMenuScrim')
					return [x, y];
		return null;
	}, box);
/** a right click on `selector` (under a popover's scrim, whose press it is), its menu shown */
async function rightClick(selector) {
	await page.click(selector, { button: 'right', force: true });
	await until(
		page,
		() => !document.getElementById('extMenu').classList.contains('hidden'),
		Boolean,
		10000,
	);
	return settled();
}
await page.click('#toolExtensions');
await painted(page);
const overList = await rightClick(extButtonOf);
await page.keyboard.press('Escape');
await page.click('#toolMenu');
await painted(page);
const overMenu = await rightClick(extButtonOf);
await page.keyboard.press('Escape');
await page.click(extButtonOf);
await popupFrame(page);
const overPopup = await rightClick(extButtonOf);
ok(
	"a right click on the extension's button opens its menu while the list, the menu or its popup is open, which closes",
	onlyOpen(overList, 'extMenu') &&
		onlyOpen(overMenu, 'extMenu') &&
		onlyOpen(overPopup, 'extMenu'),
	JSON.stringify({ overList, overMenu, overPopup }),
);
const look = await page.evaluate(() => {
	const style = (element) => {
		const s = getComputedStyle(element);
		return [s.backgroundColor, s.borderRadius, s.boxShadow, s.padding].join();
	};
	const row = (element) => {
		const s = getComputedStyle(element);
		return [s.font, s.color, s.paddingLeft, s.borderRadius].join();
	};
	const menu = document.getElementById('extMenu');
	const app = document.getElementById('pmMenu');
	return {
		same: style(menu) === style(app),
		rows:
			row(menu.querySelector('.pmMenuItem')) ===
			row(app.querySelector('.pmMenuItem')),
	};
});
ok(
	"the extension's menu is the menu's popover, its rows the menu's",
	look.same && look.rows,
	JSON.stringify(look),
);
const frameAt = await box(page, '.frame:not(.hidden)');
const inFrame = [frameAt.left + 200, frameAt.top + 200];
await page.mouse.click(...inFrame);
const afterFrame = await settled();
await rightClick(extButtonOf);
await page.mouse.click(...inFrame, { button: 'right' });
const afterRight = await settled();
await rightClick(extButtonOf);
const omniAt = await box(page, '#omni');
await page.mouse.click(omniAt.left + 30, omniAt.top + omniAt.height / 2);
const afterBar = await settled();
await rightClick(extButtonOf);
await page.keyboard.press('Escape');
const afterEscape = await settled();
await rightClick(extButtonOf);
// (the window losing the focus: a headless page keeps it, so it is told)
await page.evaluate(() => {
	document.hasFocus = () => false;
	dispatchEvent(new FocusEvent('blur'));
});
const afterBlur = await settled();
await page.evaluate(() => delete document.hasFocus);
ok(
	"the extension's menu closes on a press in the page's frame, a right click in the page, on the bar, on Escape and when the window loses the focus",
	[afterFrame, afterRight, afterBar, afterEscape, afterBlur].every((state) =>
		onlyOpen(state),
	),
	JSON.stringify({
		afterFrame,
		afterRight,
		afterBar,
		afterEscape,
		afterBlur,
	}),
);

// in the list: More options' menu closes on a press in the list, which
// stays; the press is the menu's (Manage extensions waits for the next)
await page.click('#toolExtensions');
await painted(page);
await page.click('#extPanel .extRowMore[aria-haspopup]');
await painted(page);
const kebab = await opened(page);
const title = await box(page, '#extPanel .extPanelTitle');
await page.mouse.click(title.left + 10, title.top + 5);
const inList = await settled();
await page.click('#extPanel .extRowMain', { button: 'right' });
await painted(page);
const rowMenu2 = await opened(page);
await page.mouse.click(
	...(await outsideMenu(await box(page, '#extPanel .extManage'))),
);
const onManage = await settled();
await page.click('#extPanel .extManage');
const managing = await settled();
ok(
	"in the list a press outside More options' menu closes it and leaves the list, also on Manage extensions, which the next click opens",
	onlyOpen(kebab, 'extMenu', 'extPanel') &&
		onlyOpen(inList, 'extPanel') &&
		onlyOpen(rowMenu2, 'extMenu', 'extPanel') &&
		onlyOpen(onManage, 'extPanel') &&
		onlyOpen(managing, 'shieldsPage'),
	JSON.stringify({ kebab, inList, rowMenu2, onManage, managing }),
);
// a menu opened over the Extensions page (as an extension's shortcut can):
// in front of it, closed by a press on the page, which stays, and by
// Escape before the page
await page.evaluate((id) => openExtMenu(id, extAnchor(extButton)), id);
await until(
	page,
	() => !document.getElementById('extMenu').classList.contains('hidden'),
	Boolean,
	10000,
);
await painted(page);
const overPage = await page.evaluate(() => {
	const menu = document.getElementById('extMenu');
	const r = menu.getBoundingClientRect();
	const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
	return { inFront: menu.contains(hit), inert: menu.inert };
});
const card = await box(page, '#shieldsPage');
await page.mouse.click(card.left + card.width / 2, card.bottom - 30);
const pressOnPage = await settled();
await page.evaluate((id) => openExtMenu(id, extAnchor(extButton)), id);
await until(
	page,
	() => !document.getElementById('extMenu').classList.contains('hidden'),
	Boolean,
	10000,
);
await page.keyboard.press('Escape');
const escapeOnPage = await settled();
await page.keyboard.press('Escape');
const pageClosed = await settled();
ok(
	'a menu that opens over the Extensions page is in front of it; a press on the page closes it, and Escape closes it before the page',
	overPage.inFront &&
		!overPage.inert &&
		onlyOpen(pressOnPage, 'shieldsPage') &&
		onlyOpen(escapeOnPage, 'shieldsPage') &&
		onlyOpen(pageClosed),
	JSON.stringify({ overPage, pressOnPage, escapeOnPage, pageClosed }),
);
// opening the page closes a menu open under it
await rightClick(extButtonOf);
await page.evaluate(() => openExtensionsPage());
const pageOverMenu = await settled();
await page.keyboard.press('Escape');
ok(
	'the Extensions page opening closes the menu that was open',
	onlyOpen(pageOverMenu, 'shieldsPage'),
	JSON.stringify(pageOverMenu),
);

// Options: its page in a new tab, the bar showing chrome-extension://
const tabsBefore = await page.evaluate(
	() => document.querySelectorAll('#frames iframe.frame').length,
);
await page.click(`#extActions .extAction[data-ext="${id}"]`, {
	button: 'right',
});
await painted(page);
await page.click('#extMenu [data-command="options"]');
const optionsUrl = `chrome-extension://${id}/options.html`;
const options = await until(
	page,
	() => ({
		bar: document.querySelector('#omni input').value,
		tabs: document.querySelectorAll('#frames iframe.frame').length,
		shields: document.getElementById('toolShields').hidden,
	}),
	(value) => value?.bar === optionsUrl,
	20000,
);
const optionsTitle = await (async () => {
	const start = Date.now();
	while (Date.now() - start < 20000) {
		for (const f of page.frames()) {
			const title = await f.evaluate(() => document.title).catch(() => '');
			if (title === 'Probe options') return title;
		}
		await sleep(200);
	}
	return null;
})();
ok(
	'Options opens its page in a new tab, the bar showing chrome-extension://, no shields',
	options?.bar === optionsUrl &&
		options.tabs === tabsBefore + 1 &&
		options.shields === true &&
		optionsTitle === 'Probe options',
	JSON.stringify({ options, tabsBefore, optionsTitle }),
);

// another tab: the menu closes
await rightClick(extButtonOf);
await page.evaluate(() => activateTab(tabs[0]));
const otherTab = await settled();
await page.evaluate(() => activateTab(tabs.at(-1)));
ok(
	"another tab closes the extension's menu",
	onlyOpen(otherTab),
	JSON.stringify(otherTab),
);

// typed: the page it names opens
await submitOmni(page, PAGE);
await until(
	page,
	() => document.querySelector('#omni input').value,
	(v) => /bookmark-a/.test(v ?? ''),
);
await submitOmni(page, optionsUrl);
const typed = await until(
	page,
	() => document.querySelector('#omni input').value,
	(value) => value === optionsUrl,
	20000,
);
await sleep(500);
const typedFrame = await page.evaluate(() => {
	const tab = [...document.querySelectorAll('#frames iframe.frame')].find(
		(element) => !element.classList.contains('hidden'),
	);
	return tab?.src ?? '';
});
ok(
	'a chrome-extension:// address typed in the bar opens that page',
	typed === optionsUrl && /\/stomp\//.test(typedFrame),
	JSON.stringify({ typed, typedFrame }),
);

// the tab manager's cards carry the buttons as pictures
await page.click('#recents');
await until(
	page,
	() => document.body.classList.contains('recents'),
	Boolean,
	10000,
);
await sleep(600);
const copy = await page.evaluate(() => ({
	pictures: document.querySelectorAll('.cardLabel .cardExtensions .extAction')
		.length,
	puzzles: document.querySelectorAll('.cardLabel .cardExtensions .extbtn img')
		.length,
	buttons: document.querySelectorAll('.cardLabel .cardExtensions button')
		.length,
}));
ok(
	"the cards' copies of the bar carry the extension buttons and the puzzle piece as pictures",
	copy.pictures >= 1 && copy.puzzles >= 1 && copy.buttons === 0,
	JSON.stringify(copy),
);
await page.keyboard.press('Escape');
await until(
	page,
	() => !document.body.classList.contains('recents'),
	Boolean,
	10000,
);
await sleep(400);

// off and on again, from its card
await page.click('#toolExtensions');
await painted(page);
await page.click('#extPanel .extManage');
await painted(page);
await page.click(`#spExtList [data-ext="${id}"] .shieldsToggle`);
const off = await until(
	page,
	() => document.querySelectorAll('#extActions .extAction').length,
	(n) => n === 0,
	15000,
);
list = await cards(page);
ok(
	'turned off from its card: its button leaves the bar, the card says off',
	off === 0 && list[0]?.on === false,
	JSON.stringify({ off, list }),
);
await page.click(`#spExtList [data-ext="${id}"] .shieldsToggle`);
const on = await until(
	page,
	() => document.querySelectorAll('#extActions .extAction').length,
	(n) => n === 1,
	15000,
);
ok('turned on again: its button is back', on === 1, String(on));
await page.keyboard.press('Escape');

// a failed call of the extensions API (the extension gone under its
// button): nothing in the status chip
await page.evaluate(() => {
	window.controller.extensions.clickAction = async () => {
		throw new Error('No installed extension probe');
	};
});
await page.click(`#extActions .extAction[data-ext="${id}"]`);
await sleep(500);
await page.evaluate(() => delete window.controller.extensions.clickAction);
const announced = await page.evaluate(
	() => document.querySelector('.extAnnouncer')?.textContent ?? null,
);

// Remove, from its menu: the page asks, then it is gone
await page.click(`#extActions .extAction[data-ext="${id}"]`, {
	button: 'right',
});
await painted(page);
await page.click('#extMenu [data-command="uninstall"]');
await painted(page);
const asked = await page.evaluate(() => ({
	title: document.querySelector('#extMenu .extDialogTitle')?.textContent,
	buttons: [...document.querySelectorAll('#extMenu .extDialog .spBtn')].map(
		(button) => button.textContent,
	),
	focused: document.activeElement?.textContent,
}));
ok(
	"Remove from its menu asks in Chrome's dialog, on the Remove button",
	asked.title === `Remove "${NAME}"?` &&
		JSON.stringify(asked.buttons) === JSON.stringify(['Remove', 'Cancel']) &&
		asked.focused === 'Remove',
	JSON.stringify(asked),
);
await page.click('#extMenu .extDialog .spBtn:first-child');
await page.click('#toolExtensions');
await painted(page);
await page.click('#extPanel .extManage');
const removed = await until(
	page,
	() => ({
		cards: document.querySelectorAll('#spExtList .extCard').length,
		buttons: document.querySelectorAll('#extActions .extAction').length,
	}),
	(value) => value?.cards === 0 && value.buttons === 0,
	15000,
);
ok(
	'removed: no card, no button',
	removed?.cards === 0 && removed.buttons === 0,
	JSON.stringify(removed),
);
await page.keyboard.press('Escape');
const chipSaid = await page.evaluate(() => ({
	said: window.__chipSaid,
	now: document.getElementById('chromeStatus').textContent,
	error: document.getElementById('chromeStatus').classList.contains('error'),
}));
ok(
	"the status chip said only the proxy's state through the install, the pins, a failed call and the removal; the pin was said to a screen reader",
	chipSaid.said.length > 0 &&
		chipSaid.said.every(
			(text) => !/extension|pinned|removed|probe/i.test(text),
		) &&
		/^(Ready|Loaded|Loading…)$/.test(chipSaid.now) &&
		!chipSaid.error &&
		/^Extension (pinned|unpinned)$/.test(announced ?? ''),
	JSON.stringify({ chipSaid, announced }),
);
if (process.env.EXT_SHOTS) {
	await addProbe(page);
	await page.keyboard.press('Escape');
	await until(
		page,
		() => document.querySelectorAll('#extActions .extAction').length,
		(n) => n === 1,
	);
	// the fixture's page, where the probe has full access
	await submitOmni(page, PAGE);
	await until(
		page,
		() => document.querySelector('#omni input').value,
		(v) => /bookmark-a/.test(v ?? ''),
	);
	await sleep(800);
	const shot = (name, clip) =>
		page.screenshot({
			path: `${process.env.EXT_SHOTS}/${name}.png`,
			...(clip ? { clip } : {}),
		});
	const bar = { x: 880, y: 0, width: 400, height: 48 };
	await shot('stomp-toolbar', bar);
	await page.click('#extActions .extAction');
	await popupFrame(page);
	await sleep(500);
	await page.screenshot({ path: `${process.env.EXT_SHOTS}/desktop-popup.png` });
	await shot('stomp-popup', { x: 760, y: 0, width: 520, height: 260 });
	await page.mouse.click(10, 300);
	const action = await box(page, '#extActions .extAction');
	await page.mouse.click(action.left + 17, action.top + 17, {
		button: 'right',
	});
	await painted(page);
	await sleep(300);
	await shot('stomp-menu');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowRight');
	await painted(page);
	await sleep(300);
	await shot('stomp-submenu');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	// the menu's Extensions and Themes
	await page.click('#toolMenu');
	await painted(page);
	await page.hover('#menuExtensions');
	await painted(page);
	await sleep(300);
	await shot('stomp-app-menu-extensions', {
		x: 720,
		y: 0,
		width: 560,
		height: 260,
	});
	await page.hover('#menuThemes');
	await painted(page);
	await sleep(300);
	await shot('stomp-app-menu-themes', {
		x: 720,
		y: 0,
		width: 560,
		height: 420,
	});
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await page.click('#toolExtensions');
	await painted(page);
	await sleep(300);
	await page.screenshot({ path: `${process.env.EXT_SHOTS}/desktop-list.png` });
	await shot('stomp-puzzle', { x: 860, y: 0, width: 420, height: 300 });
	await page.click('#extPanel .extManage');
	await painted(page);
	await page.screenshot({ path: `${process.env.EXT_SHOTS}/desktop-page.png` });
}
errors.push(...page.errors);
await page.close();

// ---- the home page's search bar on the way back from the Extensions page ----
// Every frame from the press to 500 ms after it, read in a
// requestAnimationFrame callback: the box's width and right edge and the gap
// to its Go button, in the form's own frame (the home screen's zoom in
// scales the form, which this takes out), are their settled values on every
// frame the bar is shown. The zoom made the form the containing block of
// its absolute .urlFill, which was sized from the card: the box was 50px
// narrower and 50px short of the button until the zoom's cleanup.
{
	const home = await browsing(HOST);
	await home.evaluate(() => {
		window.__barFrames = (done) => {
			const frames = [];
			const form = document.getElementById('mainForm');
			const input = form.querySelector('input[name="url"]');
			const go = form.querySelector('.visit');
			const read = () => {
				const f = form.getBoundingClientRect();
				const i = input.getBoundingClientRect();
				const b = go.getBoundingClientRect();
				const k = f.width ? form.offsetWidth / f.width : 1;
				return {
					shown:
						!document.getElementById('landing').classList.contains('hidden') &&
						i.width > 0,
					zoom: document
						.getAnimations()
						.some((a) => a.animationName === 'landingZoom'),
					width: +(i.width * k).toFixed(1),
					right: +((i.right - f.left) * k).toFixed(1),
					gap: +((b.left - i.right) * k).toFixed(1),
				};
			};
			const start = performance.now();
			const tick = () => {
				frames.push(read());
				if (performance.now() - start < 500) requestAnimationFrame(tick);
				else
					setTimeout(() => {
						done({ frames, settled: read() });
					}, 300);
			};
			requestAnimationFrame(tick);
		};
	});
	/** the frames of the bar while `act` brings the home page back */
	const barFrames = async (act) => {
		const recording = home.evaluate(
			() => new Promise((resolve) => window.__barFrames(resolve)),
		);
		await act();
		return recording;
	};
	const off = ({ frames, settled }) =>
		frames.filter(
			(f) =>
				f.shown &&
				['width', 'right', 'gap'].some(
					(key) => Math.abs(f[key] - settled[key]) > 0.5,
				),
		);
	const openPage = async (via) => {
		if (via === 'home') await home.click('#extensionsTab');
		else if (via === 'menu') {
			await home.click('#toolMenu');
			await painted(home);
			await home.click('#menuExtensions');
			await painted(home);
			await home.click('.extSubmenu [data-command="manage"]');
		} else {
			await home.click('#toolExtensions');
			await painted(home);
			await home.click('#extPanel .extManage');
		}
		await painted(home);
		return home.evaluate(
			() => document.getElementById('shieldsPage').dataset.view,
		);
	};
	const backInTab = async () => {
		await submitLanding(home, PAGE);
		await until(
			home,
			() => !document.getElementById('browser').classList.contains('hidden'),
			Boolean,
		);
		await painted(home);
	};
	const runs = {};
	// on the home page: the page over it, closed by Escape (no zoom)
	await home.click('#home');
	await sleep(400);
	let view = await openPage('home');
	runs['home tab, Escape'] = {
		view,
		...(await barFrames(() => home.keyboard.press('Escape'))),
	};
	// from a tab: the menu's Manage extensions, closed, then Home; the
	// puzzle piece's, Escape, then Back at the start of the tab's history
	for (const [via, close, back] of [
		['menu', '#shieldsPage .spClose', '#home'],
		['puzzle', 'Escape', '#back'],
	]) {
		await backInTab();
		view = await openPage(via);
		if (close === 'Escape') await home.keyboard.press('Escape');
		else await home.click(close);
		await painted(home);
		runs[`${via}, ${close === 'Escape' ? 'Escape' : 'close'}, ${back}`] = {
			view,
			...(await barFrames(() => home.click(back))),
		};
	}
	const summary = Object.fromEntries(
		Object.entries(runs).map(([name, run]) => [
			name,
			{
				view: run.view,
				settled: run.settled,
				shown: run.frames.filter((f) => f.shown).length,
				zoomed: run.frames.filter((f) => f.shown && f.zoom).length,
				off: off(run).slice(0, 4),
			},
		]),
	);
	ok(
		"after the Extensions page, every frame of the home page shows its search box's width, right edge and gap to Go at their settled values, the zoom in included",
		Object.values(summary).every(
			(run) =>
				run.view === 'extensions' &&
				run.shown >= 5 &&
				!run.off.length &&
				run.settled.gap > 0 &&
				run.settled.gap < 20,
		) &&
			summary['menu, close, #home'].zoomed > 0 &&
			summary['puzzle, Escape, #back'].zoomed > 0,
		JSON.stringify(summary),
	);
	errors.push(...home.errors);
	await home.close();
}

// ---- phone widths --------------------------------------------------------------
for (const [width, height] of [
	[390, 844],
	[320, 640],
]) {
	const phone = await browsing(HOST, { width, height });
	await addProbe(phone, { viaMenu: true });
	await phone.keyboard.press('Escape');
	await until(
		phone,
		() => document.querySelectorAll('#extActions .extAction').length,
		(n) => n === 1,
	);
	const fit = await phone.evaluate(() => ({
		overflow: document.documentElement.scrollWidth - innerWidth,
		form: document.getElementById('omni').getBoundingClientRect().width,
		actions: getComputedStyle(document.getElementById('extActions')).display,
		puzzle:
			document.getElementById('toolExtensions').getClientRects().length > 0,
		menu: document.getElementById('toolMenu').getBoundingClientRect().right,
	}));
	ok(
		`${width}px: the address box keeps 120px, the buttons give way${width < 360 ? ', and the puzzle piece' : ' to the puzzle piece'}`,
		fit.overflow <= 0 &&
			fit.form >= 120 &&
			fit.actions === 'none' &&
			fit.puzzle === width >= 360 &&
			fit.menu <= width,
		JSON.stringify(fit),
	);
	// (with no room for the puzzle piece, the menu's Extensions lists them)
	if (width >= 360) await phone.click('#toolExtensions');
	else {
		await phone.click('#toolMenu');
		await painted(phone);
		await phone.click('#menuExtensions');
	}
	await painted(phone);
	const panel = await box(phone, width >= 360 ? '#extPanel' : '.extSubmenu');
	const phoneRows = await subMenuState(phone);
	ok(
		`${width}px: the list fits the window${width < 360 ? ", the menu's Extensions listing the extension before Chrome's two rows" : ''}`,
		panel?.display !== 'none' &&
			panel.left >= 0 &&
			panel.right <= width &&
			(width >= 360 ||
				JSON.stringify(phoneRows.entries) ===
					JSON.stringify([
						NAME,
						'---',
						'Manage extensions',
						'Visit Chrome Web Store',
					])),
		JSON.stringify({ panel, phoneRows }),
	);
	await phone.click(
		width >= 360
			? '#extPanel .extRowMain'
			: '.extSubmenu [data-command="extension"]',
	);
	const phoneFrame = await popupFrame(phone);
	await until(
		phone,
		() => {
			const f = document.querySelector('#extPopup iframe');
			return f ? f.getBoundingClientRect().width : 0;
		},
		(w) => w >= 280,
		15000,
	);
	const phonePopup = await popupState(phone);
	ok(
		`${width}px: its popup opens from the list and fits the window`,
		!!phoneFrame &&
			phonePopup.open &&
			phonePopup.left >= 0 &&
			phonePopup.right <= width,
		JSON.stringify(phonePopup),
	);
	if (process.env.EXT_SHOTS)
		await phone.screenshot({
			path: `${process.env.EXT_SHOTS}/phone-${width}-popup.png`,
		});
	await phone.mouse.click(5, height - 120);
	await painted(phone);
	await phone.click('#toolMenu');
	await painted(phone);
	await phone.click('#menuExtensions');
	await painted(phone);
	await phone.click('.extSubmenu [data-command="manage"]');
	await painted(phone);
	await sleep(300);
	const sheet = await phone.evaluate(() => {
		const dialog = document.getElementById('shieldsPage');
		const r = dialog.getBoundingClientRect();
		const body = dialog.querySelector('.spBody');
		return {
			left: r.left,
			right: r.right,
			scroll: body.scrollWidth - body.clientWidth,
			view: dialog.dataset.view,
		};
	});
	ok(
		`${width}px: the Extensions page fits the window, no horizontal scroll`,
		sheet.view === 'extensions' &&
			sheet.left >= 0 &&
			sheet.right <= width &&
			sheet.scroll <= 0,
		JSON.stringify(sheet),
	);
	if (process.env.EXT_SHOTS)
		await phone.screenshot({
			path: `${process.env.EXT_SHOTS}/phone-${width}-page.png`,
		});
	errors.push(...phone.errors);
	await phone.close();
}

// ---- the same-origin host ------------------------------------------------------
const same = await browsing(PROXY);
await addProbe(same);
await same.keyboard.press('Escape');
const sameButtons = await until(
	same,
	() =>
		[...document.querySelectorAll('#extActions .extAction')].map(
			(b) => b.querySelector('.extBadge')?.textContent,
		),
	(value) => value?.[0] === '7',
);
await same.click('#extActions .extAction');
const sameFrame = await popupFrame(same);
const samePopup = await until(
	same,
	() => {
		const f = document.querySelector('#extPopup iframe');
		return f ? Math.round(f.getBoundingClientRect().width) : 0;
	},
	(w) => w >= 280,
	15000,
);
ok(
	'same origin: the button with its badge, and its popup sized as it asks',
	JSON.stringify(sameButtons) === JSON.stringify(['7']) &&
		!!sameFrame &&
		samePopup >= 280,
	JSON.stringify({ sameButtons, samePopup }),
);
await same.keyboard.press('Escape');
await painted(same);

// the popup shows at its document's size, with the Shields panel's open
// animation, and never grows into shape (the universal transition did)
const shieldsIn = await (async () => {
	await same.click('#toolShields');
	const names = await same.evaluate(() =>
		document
			.getElementById('shieldsPanel')
			.getAnimations()
			.map((a) => `${a.animationName} ${a.effect.getTiming().duration}`),
	);
	await same.keyboard.press('Escape');
	await painted(same);
	return names;
})();
await same.evaluate(() => {
	const panel = document.getElementById('extPopup');
	const frames = (window.__extPopupFrames = []);
	const start = performance.now();
	const tick = () => {
		const style = getComputedStyle(panel);
		const r = panel.getBoundingClientRect();
		if (style.display !== 'none' && style.visibility === 'visible')
			frames.push({
				size: `${Math.round(r.width)}x${Math.round(r.height)}`,
				opacity: Number(style.opacity),
				animations: panel
					.getAnimations()
					.map((a) => `${a.animationName} ${a.effect.getTiming().duration}`),
			});
		if (performance.now() - start < 2000) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
});
await same.click('#extActions .extAction');
await popupFrame(same);
await sleep(2100);
const opening = await same.evaluate(() => window.__extPopupFrames);
const openSizes = [...new Set(opening.map((frame) => frame.size))];
ok(
	"the popup shows at its document's size and opens with the Shields panel's animation",
	shieldsIn.length === 1 &&
		openSizes.length === 1 &&
		parseInt(openSizes[0]) >= 300 &&
		opening[0].opacity < 0.6 &&
		JSON.stringify(opening[0].animations) === JSON.stringify(shieldsIn),
	JSON.stringify({ shieldsIn, openSizes, first: opening[0] }),
);
await same.keyboard.press('Escape');
const shut = await same.evaluate(
	() => getComputedStyle(document.getElementById('extPopup')).display,
);
ok("Escape closes it at once, as the Shields panel's", shut === 'none', shut);

// the first click after a reload: once the worker lists the extension, the
// controller's hub knows it (it answered "No enabled extension with id ...
// is installed" until its own first list was in)
await same.reload();
const firstClick = await same.evaluate(async (id) => {
	const start = Date.now();
	while (!window.controller?.extensions && Date.now() - start < 30000)
		await new Promise((resolve) => setTimeout(resolve, 5));
	const api = window.controller.extensions;
	while (Date.now() - start < 30000)
		if ((await api.list().catch(() => [])).some((info) => info.id === id))
			break;
	return api.clickAction(id).catch((error) => `error: ${error.message}`);
}, id);
ok(
	'after a reload, the first click once the extension is listed opens its popup',
	firstClick === 'popup',
	firstClick,
);

// a tab open during a deploy (the page's build is older than the worker's):
// the controller goes on with the worker, and so do the extensions, whose
// buttons, list and menus work from the first click
const pageBuild = JSON.parse(
	readFileSync(new URL('../../dist/build.json', import.meta.url), 'utf8'),
).build;
const olderBuild = `${pageBuild.slice(0, -1)}${pageBuild.endsWith('0') ? '1' : '0'}`;
// (the page's own copy of the controller, from a path the worker does not
// answer: a route never sees what the worker answers)
// (the page's address may name its tab by a token, `?3`: the route takes
// the page at any query)
await same.route(
	(url) => `${url.origin}${url.pathname}` === PROXY,
	async (route) => {
		const response = await route.fetch();
		route.fulfill({
			response,
			body: (await response.text()).replace(
				/\/stomp\/Controller\.js(\?[^"']*)?/,
				'/stale-build/Controller.js',
			),
		});
	},
);
await same.route('**/stale-build/Controller.js', (route) =>
	route.fulfill({
		contentType: 'text/javascript',
		body: readFileSync(
			new URL('../../dist/Controller.js', import.meta.url),
			'utf8',
		)
			.split(pageBuild)
			.join(olderBuild),
	}),
);
// (the demo's app worker answers the page's load, which the route then
// never sees: it goes first)
await same.evaluate(async () => {
	const registration = await navigator.serviceWorker.getRegistration('/');
	if (registration && new URL(registration.scope).pathname === '/')
		await registration.unregister();
});
// (a failed extensions call is a console warning: extFailed)
const staleWarnings = [];
same.on('console', (message) => {
	if (/No enabled extension/.test(message.text()))
		staleWarnings.push(message.text());
});
await same.reload();
await same.waitForFunction(
	() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
	null,
	{ timeout: 45000 },
);
const staleTab = await until(
	same,
	async (id) => ({
		stale: window.controller.stale?.newer ?? null,
		bar: document.querySelectorAll(`#extActions .extAction[data-ext="${id}"]`)
			.length,
		menu: await window.controller.extensions.contextMenu(id).then(
			(entries) => entries.length,
			(error) => error.message,
		),
	}),
	(value) => value?.bar === 1,
	15000,
	id,
);
await same.click('#toolExtensions');
await painted(same);
await same.click(`#extPanel .extRowMain[data-ext="${id}"]`);
const staleFrame = await popupFrame(same);
ok(
	"a tab older than its worker: the button, its menu and the list's row work at once",
	staleTab?.stale === 'worker' &&
		staleTab.bar === 1 &&
		typeof staleTab.menu === 'number' &&
		!!staleFrame &&
		!staleWarnings.length,
	JSON.stringify({ staleTab, staleWarnings }),
);
errors.push(...same.errors);
await same.close();

ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
