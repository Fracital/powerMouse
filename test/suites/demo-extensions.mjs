// The demo's extensions UI (docs/extensions.md), on a probe extension built
// here and added as a .zip through the Extensions page:
//  - the puzzle piece after the address box lists the extensions and opens
//    the Extensions page, as does the menu's Extensions item;
//  - the page adds a .zip (its card: name, version, where it came from,
//    its permissions in Chrome's words), says what a bad Web Store address
//    did, turns an extension off and on, and removes it after asking;
//  - the bar's button for the extension, its initial for an icon and the
//    badge its background set for the tab, after the address box;
//  - a click shows its popup under the button, in the menu's popover, sized
//    as its document asks; the popup's window.close() closes it, and so do
//    a click outside and Escape, which unload it;
//  - its menu (a right click): the extension's own action items, Options,
//    Manage extension, Remove; an item chosen reaches the background;
//  - Options opens its page in a tab whose bar shows chrome-extension://,
//    and such an address typed in the bar opens it; no shields there;
//  - the content script runs in the tab's page;
//  - the cards' copies of the bar carry the buttons as pictures;
//  - at 390px the buttons give way to the puzzle piece and at 320px the
//    piece to the menu's item: the address box keeps 120px, the list, a
//    popup and the page fit the window;
//  - the same on the same-origin host (the bar's button, its popup).
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
			facts: card.querySelector('.extFacts')?.textContent,
			permissions: [...card.querySelectorAll('.extPerms li')].map(
				(li) => li.textContent,
			),
			buttons: [...card.querySelectorAll('.extButtons .spBtn')].map(
				(button) => button.textContent,
			),
			confirm: card.querySelector('.extConfirm')?.textContent ?? null,
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

/** add the probe through the Extensions page (opened from the puzzle's list) */
async function addProbe(page, { viaMenu = false } = {}) {
	if (viaMenu) {
		await page.click('#toolMenu');
		await painted(page);
		await page.click('#menuExtensions');
	} else await page.click('#toolExtensions');
	await painted(page);
	await page.click('#extPanel .extManage');
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
const page = await browsing(HOST);
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
	'a .zip from the file button: its card, on, with its version, origin and permissions',
	added &&
		list.length === 1 &&
		/^[a-p]{32}$/.test(id) &&
		list[0].name === `${NAME} 1.0` &&
		list[0].on === true &&
		/From a file/.test(list[0].facts) &&
		/Manifest V3/.test(list[0].facts) &&
		list[0].permissions.includes(
			'Read and change all your data on all websites',
		) &&
		list[0].permissions.includes('contextMenus') &&
		JSON.stringify(list[0].buttons) === JSON.stringify(['Options', 'Remove']),
	JSON.stringify(list),
);
const addedStatus = await status(page);
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
		buttons[0].label === 'Demo probe' &&
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
	head: document.querySelector('#extMenu .extPanelHead')?.textContent,
	items: [...document.querySelectorAll('#extMenu .pmMenuItem')].map((item) =>
		item.textContent.trim(),
	),
	focused: document.activeElement?.textContent?.trim(),
}));
ok(
	'a right click opens its menu: its action items (not its page ones), Options, Manage, Remove',
	menu.open &&
		menu.head === NAME &&
		JSON.stringify(menu.items) ===
			JSON.stringify([
				'Say hi',
				'Options',
				'Manage extension',
				'Remove from powerMouse',
			]) &&
		menu.focused === 'Say hi',
	JSON.stringify(menu),
);
await page.keyboard.press('ArrowDown');
const movedTo = await page.evaluate(() =>
	document.activeElement?.textContent?.trim(),
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
	movedTo === 'Options' && hi === 'hi',
	JSON.stringify({ movedTo, hi }),
);

// the menu's Extensions item: the same list, with its badge
await page.click('#toolMenu');
await painted(page);
await page.click('#menuExtensions');
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
	"the menu's Extensions item opens the list: the extension and its badge",
	listed.open &&
		JSON.stringify(listed.rows) ===
			JSON.stringify([{ name: NAME, badge: 'hi' }]),
	JSON.stringify(listed),
);
await page.keyboard.press('Escape');

// Options: its page in a new tab, the bar showing chrome-extension://
const tabsBefore = await page.evaluate(
	() => document.querySelectorAll('#frames iframe.frame').length,
);
await page.click(`#extActions .extAction[data-ext="${id}"]`, {
	button: 'right',
});
await painted(page);
await page.click('#extMenu .pmMenuItem:nth-of-type(2)');
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

// Remove, from its menu: the page asks, then it is gone
await page.click(`#extActions .extAction[data-ext="${id}"]`, {
	button: 'right',
});
await painted(page);
await page.click('#extMenu .pmMenuItem:last-of-type');
await painted(page);
list = await cards(page);
const asked = await page.evaluate(() => document.activeElement?.textContent);
ok(
	'Remove from its menu opens the page asking, on the Remove button',
	/Remove Demo probe\?/.test(list[0]?.confirm ?? '') &&
		JSON.stringify(list[0]?.buttons) === JSON.stringify(['Remove', 'Cancel']) &&
		asked === 'Remove',
	JSON.stringify({ list, asked }),
);
await page.click(`#spExtList [data-control="${id}:confirm"]`);
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
if (process.env.EXT_SHOTS) {
	await addProbe(page);
	await page.keyboard.press('Escape');
	await until(
		page,
		() => document.querySelectorAll('#extActions .extAction').length,
		(n) => n === 1,
	);
	await page.click('#extActions .extAction');
	await popupFrame(page);
	await sleep(500);
	await page.screenshot({ path: `${process.env.EXT_SHOTS}/desktop-popup.png` });
	await page.mouse.click(10, 300);
	await page.click('#toolExtensions');
	await painted(page);
	await page.screenshot({ path: `${process.env.EXT_SHOTS}/desktop-list.png` });
	await page.click('#extPanel .extManage');
	await painted(page);
	await page.screenshot({ path: `${process.env.EXT_SHOTS}/desktop-page.png` });
}
errors.push(...page.errors);
await page.close();

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
	if (width >= 360) await phone.click('#toolExtensions');
	else {
		await phone.click('#toolMenu');
		await painted(phone);
		await phone.click('#menuExtensions');
	}
	await painted(phone);
	const panel = await box(phone, '#extPanel');
	ok(
		`${width}px: the list fits the window`,
		panel?.display !== 'none' && panel.left >= 0 && panel.right <= width,
		JSON.stringify(panel),
	);
	await phone.click('#extPanel .extRowMain');
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
	await phone.click('#extPanel .extManage');
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
errors.push(...same.errors);
await same.close();

ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
