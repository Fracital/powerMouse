// The demo's menu and the Shields panel's popover it is built on:
//  - the menu button sits beside the address box, outside it, in the browser
//    view; the menu is the tab's, so the tab manager (which hides the bar)
//    has no menu button, only its new-tab button, and the cards' copies of
//    the bar carry the menu button's picture;
//  - the menu fades in when it opens and is gone at once when it closes, by
//    every way (its button, a click outside, Escape, an item chosen), and
//    so is the Shields panel: no fade-out, nothing left to see or click;
//  - Fullscreen puts the demo's own page in fullscreen and out of it, its
//    label and icon saying what choosing it does, also after the page left
//    fullscreen another way; where the page cannot be made fullscreen the
//    menu leaves it out;
//  - with the Block ads switch off the shields read down on every site,
//    and what each site has stored is kept for when it is on again;
//  - About opens a modal dialog with the version, build id, commit and build
//    date the server serves (dist/build.json through /api/status), and the
//    console badges' facts; Escape, its Close button and the backdrop close
//    it, the focus stays in it and goes back to the menu button;
//  - the keyboard: Enter opens the menu on its first item, the arrows move,
//    Enter chooses, and no key reaches the tab manager behind it;
//  - phone widths (390 and 320 px): the bar keeps the address box at 120px
//    or more, with no horizontal scroll, and the menu and About fit.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PAGE = `${FIXTURE}pages/bookmark-a.html`;

const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, timeout = 30000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

/**
 * After the page has drawn what it just opened: Chrome routes a click by
 * what the compositor last drew, and over a cross-origin frame (the isolated
 * mode's proxied page) a click in the same frame as the opening went to
 * that frame, through the scrim no person could have seen yet
 */
const painted = async (page) => {
	await page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	);
	await sleep(50);
};

/** the demo in the browser view on the fixture page, its shields button up */
async function browsing(viewport = {}, before = null) {
	const page = await openDemo(browser, undefined, viewport, before);
	await submitLanding(page, PAGE);
	await until(
		page,
		() =>
			!document.getElementById('browser').classList.contains('hidden') &&
			!document.getElementById('toolShields').hidden,
		Boolean,
	);
	return page;
}

/** what is left of a popover the moment after it closed */
const leftover = (page, panel, scrim) =>
	page.evaluate(
		([panel, scrim]) =>
			new Promise((resolve) => {
				const element = document.getElementById(panel);
				const read = () => {
					const style = getComputedStyle(element);
					return {
						display: style.display,
						visibility: style.visibility,
						scrim: getComputedStyle(document.getElementById(scrim)).display,
						animations: element
							.getAnimations({ subtree: true })
							.filter((a) => a.playState === 'running').length,
						focusInside: element.contains(document.activeElement),
					};
				};
				const now = read();
				// and on the next frame: nothing fades out after the fact
				requestAnimationFrame(() => resolve({ now, frame: read() }));
			}),
		[panel, scrim],
	);
const gone = (state) =>
	[state.now, state.frame].every(
		(s) =>
			s.display === 'none' &&
			s.scrim === 'none' &&
			s.animations === 0 &&
			!s.focusInside,
	);

/** the menu's state and its items' labels */
const menuState = (page) =>
	page.evaluate(() => {
		const panel = document.getElementById('pmMenu');
		const items = [...panel.querySelectorAll('[role="menuitem"]')].filter(
			(item) => !item.hidden,
		);
		return {
			open: getComputedStyle(panel).display !== 'none',
			items: items.map((item) => item.textContent.trim()),
			icons: items.map((item) => item.querySelector('svg')?.innerHTML ?? ''),
			focused: document.activeElement?.textContent?.trim() ?? null,
			// its fade-in (the animation itself may be over by the time a
			// loaded machine reads it)
			fading: getComputedStyle(panel).animationName === 'popoverIn',
			toolExpanded: document
				.getElementById('toolMenu')
				.getAttribute('aria-expanded'),
		};
	});

/** where an element is and whether it is what the page shows there */
const shown = (page, selector) =>
	page.evaluate((selector) => {
		const element = document.querySelector(selector);
		if (!element) return null;
		const r = element.getBoundingClientRect();
		const hit = document.elementFromPoint(
			r.left + r.width / 2,
			r.top + r.height / 2,
		);
		return {
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
			width: r.width,
			hit: hit ? `${hit.tagName}#${hit.id}.${hit.className}` : null,
			visible:
				r.width > 0 &&
				getComputedStyle(element).visibility === 'visible' &&
				(hit === element || element.contains(hit)),
		};
	}, selector);

/** `shown`, once the element shows (a view that just changed may still settle) */
async function shownSoon(page, selector, timeout = 5000) {
	const start = Date.now();
	let value = await shown(page, selector);
	while (!value?.visible && Date.now() - start < timeout) {
		await sleep(150);
		value = await shown(page, selector);
	}
	return value;
}

const fullscreenOf = (page) =>
	page.evaluate(() =>
		document.fullscreenElement === document.documentElement
			? 'root'
			: document.fullscreenElement
				? 'other'
				: 'none',
	);

/** the About dialog's rows, by fact */
const about = (page) =>
	page.evaluate(() => {
		const dialog = document.getElementById('shieldsPage');
		const rows = {};
		for (const row of dialog.querySelectorAll('.aboutRow'))
			rows[row.dataset.fact] = {
				text: row.querySelector('dd').textContent,
				title: row.querySelector('dd').title,
				datetime: row.querySelector('time')?.getAttribute('datetime') ?? null,
			};
		return {
			open: getComputedStyle(dialog).display !== 'none',
			view: dialog.dataset.view,
			role: dialog.getAttribute('role'),
			modal: dialog.getAttribute('aria-modal'),
			title: document.getElementById('shieldsPageTitle')?.textContent,
			rows,
			focusInside: dialog.contains(document.activeElement),
			focused: document.activeElement?.id || null,
			inert: ['browser', 'recentsPanel', 'landing'].map(
				(id) => document.getElementById(id).inert,
			),
			navInert: document.querySelector('nav.navbar').inert,
			recents: document.body.classList.contains('recents'),
		};
	});

// ---- the browser view -------------------------------------------------------
const page = await browsing();
const served = JSON.parse(readFileSync(`${root}dist/build.json`, 'utf8'));
const status = await page.evaluate(async () =>
	(await fetch('/api/status')).json(),
);
ok(
	"the server serves dist/build.json's build in /api/status",
	JSON.stringify(status.build) === JSON.stringify(served) &&
		/^[0-9a-f]{40}$/.test(served.commit ?? '') &&
		!Number.isNaN(Date.parse(served.date)) &&
		served.version === status.version &&
		served.build.startsWith(`${served.version}+`),
	JSON.stringify({ served, status: status.build }),
);

const bar = await page.evaluate(() => {
	const box = (element) => {
		const r = element.getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
	};
	const button = document.getElementById('toolMenu');
	const form = document.getElementById('omni');
	return {
		button: box(button),
		form: box(form),
		inForm: form.contains(button),
		inBar: button.parentElement.classList.contains('chrome'),
		label: button.getAttribute('aria-label'),
		haspopup: button.getAttribute('aria-haspopup'),
	};
});
ok(
	'the menu button is in the bar beside the address box, not in it',
	!bar.inForm &&
		bar.inBar &&
		bar.button.left >= bar.form.right &&
		bar.button.left - bar.form.right <= 8 &&
		bar.label === 'Menu' &&
		bar.haspopup === 'menu',
	JSON.stringify(bar),
);
ok(
	'the menu button shows in the browser view',
	(await shownSoon(page, '#toolMenu'))?.visible,
	JSON.stringify(await shown(page, '#toolMenu')),
);

// open with the mouse: the menu fades in, on its first item
await page.click('#toolMenu');
await painted(page);
let menu = await menuState(page);
ok(
	'the menu opens fading in, with Fullscreen and About, on its first item',
	menu.open &&
		menu.fading &&
		JSON.stringify(menu.items) === JSON.stringify(['Fullscreen', 'About']) &&
		menu.focused === 'Fullscreen' &&
		menu.toolExpanded === 'true',
	JSON.stringify(menu),
);
const enterIcon = menu.icons[0];
const menuBox = await shown(page, '#pmMenu');
ok(
	'the menu opens under its button, inside the window',
	menuBox &&
		menuBox.top >= bar.button.bottom &&
		menuBox.right <= 1280 &&
		menuBox.left >= 0,
	JSON.stringify({ menuBox, button: bar.button }),
);

// Fullscreen: the item closes the menu at once and puts the page in
// fullscreen
await page.click('#menuFullscreen');
const afterItem = await leftover(page, 'pmMenu', 'menuScrim');
ok(
	'choosing Fullscreen closes the menu at once',
	gone(afterItem),
	JSON.stringify(afterItem),
);
let fullscreen = await until(
	page,
	() =>
		document.fullscreenElement === document.documentElement ? 'root' : 'none',
	(value) => value === 'root',
	5000,
);
ok(
	'Fullscreen puts the demo page in fullscreen',
	fullscreen === 'root',
	fullscreen,
);
ok(
	'the focus goes back to the menu button',
	(await page.evaluate(() => document.activeElement?.id)) === 'toolMenu',
);
await page.click('#toolMenu');
await painted(page);
menu = await menuState(page);
ok(
	'in fullscreen the item says Exit fullscreen, with the other icon',
	menu.items[0] === 'Exit fullscreen' && menu.icons[0] !== enterIcon,
	JSON.stringify(menu),
);
await page.click('#menuFullscreen');
fullscreen = await until(
	page,
	() => (document.fullscreenElement ? 'on' : 'none'),
	(value) => value === 'none',
	5000,
);
ok('Exit fullscreen leaves fullscreen', fullscreen === 'none', fullscreen);
await page.click('#toolMenu');
await painted(page);
menu = await menuState(page);
ok(
	'out of fullscreen the item says Fullscreen again',
	menu.items[0] === 'Fullscreen' && menu.icons[0] === enterIcon,
	JSON.stringify(menu),
);
// fullscreen left another way (Escape, the browser's own controls): the
// label follows the fullscreenchange event
await page.click('#menuFullscreen');
await until(page, () => !!document.fullscreenElement, Boolean, 5000);
await page.evaluate(() => document.exitFullscreen());
await until(page, () => !document.fullscreenElement, Boolean, 5000);
await page.click('#toolMenu');
await painted(page);
menu = await menuState(page);
ok(
	'fullscreen left without the menu: the item says Fullscreen',
	menu.items[0] === 'Fullscreen' && (await fullscreenOf(page)) === 'none',
	JSON.stringify(menu),
);

// every way to close the menu leaves nothing behind
await page.evaluate(() => document.getElementById('toolMenu').click());
let state = await leftover(page, 'pmMenu', 'menuScrim');
ok(
	'the menu button closes the menu at once',
	gone(state),
	JSON.stringify(state),
);
await page.click('#toolMenu');
await painted(page);
await page.mouse.click(400, 400);
state = await leftover(page, 'pmMenu', 'menuScrim');
ok(
	'a click outside closes the menu at once',
	gone(state),
	JSON.stringify(state),
);
ok(
	'the click outside does not reach the page under it',
	(await page.evaluate(() => document.activeElement?.tagName)) !== 'IFRAME',
);
await page.click('#toolMenu');
await painted(page);
await page.keyboard.press('Escape');
state = await leftover(page, 'pmMenu', 'menuScrim');
ok(
	'Escape closes the menu at once, the focus back on its button',
	gone(state) &&
		(await page.evaluate(() => document.activeElement?.id)) === 'toolMenu' &&
		(await page.evaluate(() =>
			document.getElementById('toolMenu').getAttribute('aria-expanded'),
		)) === 'false',
	JSON.stringify(state),
);

// the Shields panel, on the same popover: fades in, goes at once
const shieldsIn = await page.evaluate(() => {
	document.getElementById('toolShields').click();
	const panel = document.getElementById('shieldsPanel');
	return {
		open: getComputedStyle(panel).display !== 'none',
		fading: getComputedStyle(panel).animationName === 'popoverIn',
	};
});
ok(
	'the Shields panel opens fading in',
	shieldsIn.open && shieldsIn.fading,
	JSON.stringify(shieldsIn),
);
await page.evaluate(() => document.getElementById('toolShields').click());
state = await leftover(page, 'shieldsPanel', 'shieldsScrim');
ok(
	'its button closes the Shields panel at once',
	gone(state),
	JSON.stringify(state),
);
await page.click('#toolShields');
await painted(page);
await page.mouse.click(400, 400);
state = await leftover(page, 'shieldsPanel', 'shieldsScrim');
ok(
	'a click outside closes the Shields panel at once',
	gone(state),
	JSON.stringify(state),
);
await page.click('#toolShields');
await painted(page);
await page.keyboard.press('Escape');
state = await leftover(page, 'shieldsPanel', 'shieldsScrim');
ok(
	'Escape closes the Shields panel at once',
	gone(state),
	JSON.stringify(state),
);
await page.click('#toolShields');
await painted(page);
await page.click('#shGlobal');
state = await leftover(page, 'shieldsPanel', 'shieldsScrim');
ok(
	'choosing Global Settings closes the Shields panel at once',
	gone(state) &&
		(await page.evaluate(
			() => document.getElementById('shieldsPage').dataset.view,
		)) === 'global',
	JSON.stringify(state),
);
await page.keyboard.press('Escape');

// About, from the keyboard: Enter opens the menu on Fullscreen, ArrowDown
// moves to About, Enter chooses it
await page.focus('#toolMenu');
await page.keyboard.press('Enter');
menu = await menuState(page);
ok(
	'Enter on the menu button opens the menu on its first item',
	menu.open && menu.focused === 'Fullscreen',
	JSON.stringify(menu),
);
await page.keyboard.press('ArrowDown');
const second = (await menuState(page)).focused;
await page.keyboard.press('ArrowDown');
const wrapped = (await menuState(page)).focused;
await page.keyboard.press('ArrowUp');
ok(
	'the arrows move between the items, round the ends',
	second === 'About' && wrapped === 'Fullscreen',
	JSON.stringify({ second, wrapped }),
);
await page.keyboard.press('Enter');
let dialog = await until(
	page,
	() => document.querySelector('#shieldsPage .aboutRow[data-fact="version"]'),
	Boolean,
	5000,
).then(() => about(page));
ok(
	'About opens a modal dialog, the menu gone',
	dialog.open &&
		dialog.view === 'about' &&
		dialog.role === 'dialog' &&
		dialog.modal === 'true' &&
		dialog.title === 'About STomp' &&
		dialog.focusInside &&
		!(await menuState(page)).open,
	JSON.stringify(dialog),
);
ok(
	"About shows the server's version, build id, commit and build date",
	dialog.rows.version?.text === served.version &&
		dialog.rows.build?.text === served.build &&
		dialog.rows.commit?.text === served.commit.slice(0, 7) &&
		dialog.rows.commit?.title === served.commit &&
		dialog.rows.date?.datetime === served.date &&
		dialog.rows.date.text.includes(String(new Date(served.date).getFullYear())),
	JSON.stringify({ rows: dialog.rows, served }),
);
ok(
	"About shows the console badges' facts and the server",
	/same origin|isolated/.test(dialog.rows.mode?.text ?? '') &&
		/^(epoxy|libcurl) over wss?:\/\//.test(dialog.rows.transport?.text ?? '') &&
		/^ready, codec /.test(dialog.rows.controller?.text ?? '') &&
		dialog.rows.server?.text.startsWith(`Node ${status.node}`),
	JSON.stringify(dialog.rows),
);
{
	// the Server line's uptime moves every second while About is open
	const read = () =>
		page.evaluate(
			() =>
				document.querySelector('#shieldsPage .aboutRow[data-fact="server"] dd')
					?.textContent ?? null,
		);
	const before = await read();
	await new Promise((resolve) => setTimeout(resolve, 2100));
	const after = await read();
	ok(
		"About's server uptime ticks while it is open",
		/, up \d+ hours, \d+ minutes, \d+ seconds$/.test(before ?? '') &&
			/, up /.test(after ?? '') &&
			after !== before,
		JSON.stringify({ before, after }),
	);
}
ok(
	'About keeps the focus: everything behind it is inert',
	dialog.inert.every(Boolean) && dialog.navInert,
	JSON.stringify({ inert: dialog.inert, nav: dialog.navInert }),
);
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
ok(
	'Tab stays in the dialog',
	(await about(page)).focusInside,
	JSON.stringify(await page.evaluate(() => document.activeElement?.outerHTML)),
);
await page.keyboard.press('Escape');
dialog = await about(page);
ok(
	'Escape closes About, the focus back on the menu button, nothing inert',
	!dialog.open &&
		dialog.focused === 'toolMenu' &&
		!dialog.inert.some(Boolean) &&
		!dialog.navInert,
	JSON.stringify(dialog),
);
await page.click('#toolMenu');
await painted(page);
await page.click('#menuAbout');
await painted(page);
await page.click('#spClose');
ok("About's Close button closes it", !(await about(page)).open);
await page.click('#toolMenu');
await painted(page);
await page.click('#menuAbout');
await painted(page);
await page.mouse.click(5, 400);
ok('a click on the backdrop closes About', !(await about(page)).open);

// ---- the tab manager ---------------------------------------------------------
await page.click('#recents');
await until(
	page,
	() => document.body.classList.contains('recents-visible'),
	Boolean,
	5000,
);
await sleep(400);
// the menu is the tab's: the tab manager has its new-tab button only
const actions = await page.evaluate(() =>
	[...document.querySelectorAll('#recentsPanel .recentsActions > *')].map(
		(element) => element.id,
	),
);
const plus = await shownSoon(page, '#newTab');
ok(
	'the tab manager has no menu button, only its new-tab button',
	JSON.stringify(actions) === JSON.stringify(['newTab']) &&
		plus?.visible &&
		!(await page.evaluate(() =>
			[
				...document.querySelectorAll('#recentsPanel [aria-haspopup="menu"]'),
			].some((element) => element.getClientRects().length > 0),
		)),
	JSON.stringify({ actions, plus }),
);
ok(
	"the card's bar copy carries the menu button's picture",
	await page.evaluate(
		() =>
			!!document.querySelector('.cardLabel .cardChrome .menubtn img') &&
			!document.querySelector('.cardLabel .cardChrome .menubtn.toolbtn'),
	),
);
await page.keyboard.press('Escape'); // leave the tab manager
errors.push(...page.errors);
await page.close();

// ---- phone widths --------------------------------------------------------------
for (const [width, height] of [
	[390, 844],
	[320, 640],
]) {
	const phone = await browsing({ width, height });
	const fit = await phone.evaluate(() => ({
		overflow: document.documentElement.scrollWidth - innerWidth,
		form: document.getElementById('omni').getBoundingClientRect().width,
		button: document.getElementById('toolMenu').getBoundingClientRect().right,
	}));
	ok(
		`${width}px: the bar fits with the menu button, the address box 120px or more`,
		fit.overflow <= 0 && fit.form >= 120 && fit.button <= width,
		JSON.stringify(fit),
	);
	const barButton = await shownSoon(phone, '#toolMenu');
	ok(
		`${width}px: the menu button shows`,
		barButton?.visible,
		JSON.stringify(barButton),
	);
	await phone.click('#toolMenu');
	await painted(phone);
	const panel = await shown(phone, '#pmMenu');
	ok(
		`${width}px: the menu fits the window`,
		panel.left >= 0 && panel.right <= width,
		JSON.stringify(panel),
	);
	await phone.click('#menuAbout');
	await painted(phone);
	await sleep(300);
	const box = await shown(phone, '#shieldsPage');
	ok(
		`${width}px: About fits the window, no horizontal scroll`,
		box.left >= 0 &&
			box.right <= width &&
			(await phone.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			)) <= 0,
		JSON.stringify(box),
	);
	await phone.keyboard.press('Escape');
	await phone.click('#recents');
	await sleep(800);
	const phonePlus = await shownSoon(phone, '#newTab');
	ok(
		`${width}px: the tab manager shows its new-tab button and no menu button`,
		phonePlus?.visible &&
			!(await phone.evaluate(() => document.getElementById('recentsMenu'))),
		JSON.stringify(phonePlus),
	);
	errors.push(...phone.errors);
	await phone.close();
}

// ---- Block ads off: shields down everywhere --------------------------------------
// the demo's Block ads switch off takes the shields down on every site: the
// button reads down, the panel says why and its master switch is off and
// disabled, and what was stored for a site is kept as it was (on again, the
// sites come back as they were left)
const unblocked = await browsing({}, (page) =>
	page.addInitScript(() => {
		if (window !== top || sessionStorage.getItem('seeded')) return;
		sessionStorage.setItem('seeded', '1');
		localStorage.setItem('stomp-demo:adblock', '0');
		localStorage.setItem(
			'stomp-demo:shields',
			JSON.stringify([{ host: 'kept.example', enabled: true }]),
		);
	}),
);
const upWhileOff = await unblocked.evaluate(() =>
	document.getElementById('toolShields').classList.contains('up'),
);
await unblocked.click('#toolShields');
await painted(unblocked);
const offPanel = await unblocked.evaluate(() => {
	const master = document.getElementById('shMaster');
	return {
		state: document.querySelector('#shieldsPanel .shieldsState')?.textContent,
		checked: master?.checked,
		disabled: master?.disabled,
		stored: JSON.parse(localStorage.getItem('stomp-demo:shields') || '[]'),
	};
});
ok(
	'with Block ads off the shields read down on every site, the master switch off and disabled',
	upWhileOff === false &&
		/Shields down while Block ads is off/.test(offPanel.state ?? '') &&
		offPanel.checked === false &&
		offPanel.disabled === true,
	JSON.stringify({ upWhileOff, ...offPanel }),
);
ok(
	'and what each site has stored is kept as it was, none written down',
	offPanel.stored.length > 0 &&
		offPanel.stored.every((entry) => entry.enabled !== false) &&
		offPanel.stored.find((entry) => entry.host === 'kept.example')?.enabled ===
			true,
	JSON.stringify(offPanel.stored),
);
errors.push(...unblocked.errors);
await unblocked.close();
const blocking = await browsing();
ok(
	'with Block ads on the shields are up',
	await blocking.evaluate(() =>
		document.getElementById('toolShields').classList.contains('up'),
	),
);
errors.push(...blocking.errors);
await blocking.close();

// ---- no Fullscreen API ----------------------------------------------------------
// an iPhone's Safari has no element fullscreen, under either name (Chrome
// still has the prefixed one): the menu has About only
const without = await browsing({}, (page) =>
	page.addInitScript(() => {
		for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled'])
			Object.defineProperty(Document.prototype, name, { get: () => false });
	}),
);
await without.click('#toolMenu');
await painted(without);
menu = await menuState(without);
ok(
	'without the Fullscreen API the menu offers About only',
	JSON.stringify(menu.items) === JSON.stringify(['About']) &&
		menu.focused === 'About',
	JSON.stringify(menu),
);
errors.push(...without.errors);
await without.close();

ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
