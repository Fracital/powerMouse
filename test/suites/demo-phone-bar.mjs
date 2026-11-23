// A phone's browser bar is the address box and the menu button, nothing
// else, and the tab manager's cards are pictures of that bar. What the rest
// of the bar does is in the menu's phone part, at its top: Back, Forward,
// Reload and the star in a row, then Saved pages and Shields, each doing
// what the bar's button does and showing its state. A desktop's bar keeps
// every button and its menu has no phone part.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const A = `${FIXTURE}pages/bookmark-a.html`;
const B = `${FIXTURE}pages/bookmark-b.html`;

const browser = await launch();
const errors = [];

async function until(page, read, want, timeout = 20000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read).catch(() => undefined);
		if (want(value)) return value;
		await sleep(100);
	}
	return value;
}

/** the ids or classes of what a bar draws (a box of some size) */
const drawn = (page, selector) =>
	page.evaluate((selector) => {
		const bar = document.querySelector(selector);
		return [...bar.querySelectorAll('*')]
			.filter((el) => {
				if (el.closest('.omnibox, .urlText, img')) return false;
				const box = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				return (
					box.width > 0 &&
					box.height > 0 &&
					style.visibility !== 'hidden' &&
					(el.matches('button, .toolbtn, .menubtn, .starbtn, .shieldsbtn') ||
						el.matches('#chromeStatus, .status, .urlBox, form'))
				);
			})
			.map((el) => el.id || el.className);
	}, selector);

const omniIs = (page, url) =>
	until(
		page,
		() => document.querySelector('#omni input').value,
		(v) => v === url,
	);

const menuState = (page) =>
	page.evaluate(() => {
		const tools = document.querySelector('.pmMenuTools');
		const seen = (el) => !!el && el.getBoundingClientRect().height > 0;
		return {
			row: seen(tools),
			tools: tools
				? [...tools.children].map((b) => ({
						label: b.getAttribute('aria-label'),
						disabled: b.disabled,
						shown: seen(b),
					}))
				: [],
			saved: seen(document.getElementById('menuSaved')),
			shields: seen(document.getElementById('menuShields')),
			shieldsText: document.getElementById('menuShields')?.textContent,
		};
	});

async function phone() {
	const page = await openDemo(browser, PROXY, { width: 390, height: 844 });
	await submitLanding(page, A);
	await omniIs(page, A);
	await until(
		page,
		() => !document.getElementById('toolStar').disabled,
		Boolean,
	);

	const bar = await drawn(page, '.chrome');
	ok(
		'phone: the bar draws the address box and the menu button alone',
		bar.length === 2 && bar.includes('omni') && bar.includes('toolMenu'),
		JSON.stringify(bar),
	);
	const room = await page.evaluate(() => {
		const input = document.querySelector('#omni input');
		return {
			input: input.getBoundingClientRect().width,
			padding: parseFloat(getComputedStyle(input).paddingRight),
		};
	});
	ok(
		'phone: the address box takes the bar, its text up to its end',
		room.input > 300 && room.padding <= 16,
		JSON.stringify(room),
	);

	// the menu's phone part: Back off on the first page, the rest on
	await page.click('#toolMenu');
	await sleep(250);
	let menu = await menuState(page);
	ok(
		"phone: the menu opens with the page's row (Back, Forward, Reload, star), Saved pages and Shields",
		menu.row &&
			menu.tools.length === 4 &&
			menu.tools.every((t) => t.shown) &&
			menu.saved &&
			menu.shields,
		JSON.stringify(menu),
	);
	ok(
		'phone: Back and Forward are off on the first page, Reload and the star on',
		menu.tools[0].disabled &&
			menu.tools[1].disabled &&
			!menu.tools[2].disabled &&
			!menu.tools[3].disabled,
		JSON.stringify(menu.tools),
	);
	// the star bookmarks the page
	await page.click('.pmMenuTools .starbtn');
	const starred = await until(
		page,
		() => document.getElementById('toolStar').getAttribute('aria-pressed'),
		(v) => v === 'true',
	);
	ok("phone: the menu's star bookmarks the page", starred === 'true');

	// Back from the menu goes back
	await submitOmni(page, B);
	await omniIs(page, B);
	await sleep(500);
	await page.click('#toolMenu');
	await sleep(250);
	menu = await menuState(page);
	ok(
		'phone: on the second page Back is on',
		!menu.tools[0].disabled,
		JSON.stringify(menu.tools),
	);
	await page.click('.pmMenuTools [data-tool="toolBack"]');
	ok("phone: the menu's Back goes back", (await omniIs(page, A)) === A);
	await sleep(500);

	// Saved pages opens the bookmarks, with the page bookmarked above
	await page.click('#toolMenu');
	await sleep(250);
	await page.click('#menuSaved');
	const saved = await until(
		page,
		() => ({
			open: document.getElementById('bookmarks').classList.contains('open'),
			rows: document.querySelectorAll('#bookmarks .bookmarkOpen').length,
		}),
		(v) => v?.open && v.rows > 0,
	);
	ok(
		'phone: Saved pages opens the bookmarks',
		saved?.open && saved.rows > 0,
		JSON.stringify(saved),
	);
	await page.keyboard.press('Escape');
	await page.evaluate(() => document.getElementById('bookmarksClose').click());
	await sleep(400);

	// Shields opens the site's panel, on screen
	await page.click('#toolMenu');
	await sleep(250);
	await page.click('#menuShields');
	await sleep(400);
	const panel = await page.evaluate(() => {
		const el = document.getElementById('shieldsPanel');
		const box = el.getBoundingClientRect();
		return {
			open: !el.classList.contains('hidden'),
			onScreen: box.top >= 0 && box.left >= 0 && box.right <= innerWidth,
			host: el.dataset.host,
		};
	});
	ok(
		"phone: Shields opens the site's panel, on screen",
		panel.open && panel.onScreen && panel.host === '127.0.0.1',
		JSON.stringify(panel),
	);
	await page.keyboard.press('Escape');
	await sleep(300);

	// the cards' copies of the bar are pictures of it
	await page.click('#recents');
	await sleep(600);
	const card = await drawn(page, '.cardLabel .cardChrome');
	ok(
		"phone: a card's bar draws the address box and the menu button alone",
		card.length === 2 &&
			card.includes('urlBox') &&
			card.some((c) => /menubtn/.test(c)),
		JSON.stringify(card),
	);

	// from home the menu has no phone part (there is no page)
	await page.click('#home');
	await sleep(500);
	await page.click('#settingsTab');
	await sleep(250);
	menu = await menuState(page);
	ok(
		"phone: the home screen's menu has no phone part",
		!menu.row && !menu.saved && !menu.shields,
		JSON.stringify(menu),
	);
	errors.push(...page.errors.map((e) => `phone: ${e}`));
	await page.close();
}

async function desktop() {
	const page = await openDemo(browser, PROXY, { width: 1280, height: 800 });
	await submitLanding(page, A);
	await omniIs(page, A);
	await until(
		page,
		() => !document.getElementById('toolStar').disabled,
		Boolean,
	);
	const bar = await drawn(page, '.chrome');
	ok(
		'desktop: the bar keeps Back, Forward, Reload, Saved pages, the extensions, the status, Shields and the star',
		[
			'toolBack',
			'toolForward',
			'toolReload',
			'toolSaved',
			'toolExtensions',
			'chromeStatus',
			'toolShields',
			'toolStar',
			'toolMenu',
		].every((id) => bar.includes(id)),
		JSON.stringify(bar),
	);
	await page.click('#toolMenu');
	await sleep(250);
	const menu = await menuState(page);
	ok(
		'desktop: the menu has no phone part',
		!menu.row && !menu.saved && !menu.shields,
		JSON.stringify(menu),
	);
	errors.push(...page.errors.map((e) => `desktop: ${e}`));
	await page.close();
}

await phone();
await desktop();
await done(browser, errors);
