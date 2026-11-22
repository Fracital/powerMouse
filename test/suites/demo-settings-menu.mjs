// The home Settings tab and the browser hamburger open the same menu. The
// Proxy submenu owns the existing ad-block, Tor and transport controls, and
// its controls survive switching between the menus and reloading the page.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	submitLanding,
} from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hasVibe = existsSync(`${root}dist/vibeos/embed.js`);
const browser = await launch();
const errors = [];

const ready = (page) =>
	page.waitForFunction(
		() => /^Ready/.test(document.getElementById('logMsg')?.textContent ?? ''),
		undefined,
		{ timeout: 45000 },
	);

const readMenu = (page) =>
	page.evaluate(() => {
		const menu = document.getElementById('pmMenu');
		const proxy = document.getElementById('proxySettings');
		const submenu = proxy.closest('.extSubmenu');
		const settings = document.getElementById('settingsTab');
		const theme = document.getElementById('customizeTab');
		const sr = settings.getBoundingClientRect();
		const tr = theme.getBoundingClientRect();
		const menuRect = menu.getBoundingClientRect();
		const childRect = submenu?.getBoundingClientRect();
		return {
			open: !menu.classList.contains('hidden'),
			expanded: settings.getAttribute('aria-expanded'),
			items: [...menu.querySelectorAll('[role="menuitem"]')]
				.filter((item) => !item.hidden)
				.map((item) => item.textContent.trim()),
			submenu: !!submenu && !submenu.classList.contains('hidden'),
			stored: document.getElementById('proxySettingsStore').contains(proxy),
			controls: [...proxy.querySelectorAll('input, select')].map((el) => el.id),
			menuRect: {
				left: menuRect.left,
				right: menuRect.right,
				top: menuRect.top,
				bottom: menuRect.bottom,
			},
			childRect: childRect && {
				left: childRect.left,
				right: childRect.right,
				top: childRect.top,
				bottom: childRect.bottom,
			},
			settingsRect: {
				left: sr.left,
				right: sr.right,
				top: sr.top,
				bottom: sr.bottom,
			},
			themeRect: { left: tr.left, right: tr.right, top: tr.top },
			focused: document.activeElement?.id,
			about: document.getElementById('menuAbout')?.textContent.trim(),
			vibe: !!document.getElementById('menuVibe'),
		};
	});

for (const [mode, base, width, height] of [
	['same-origin desktop', PROXY, 1280, 800],
	['isolated phone', HOST, 320, 800],
	['short phone', HOST, 320, 568],
]) {
	const context = await browser.newContext({
		viewport: { width, height },
	});
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(base);
	await ready(page);

	let menu = await readMenu(page);
	ok(
		`${mode}: Settings is on the same row immediately right of Themes`,
		menu.settingsRect.left >= menu.themeRect.right &&
			menu.settingsRect.left - menu.themeRect.right <= 2 &&
			Math.abs(menu.settingsRect.top - menu.themeRect.top) < 2 &&
			menu.settingsRect.right <= width &&
			menu.controls.join(',') === 'adblock,tor,transport',
		JSON.stringify(menu),
	);
	await page.click('#settingsTab');
	menu = await readMenu(page);
	ok(
		`${mode}: Settings opens the shared menu with Proxy, vibeOS where available, and About`,
		menu.open &&
			menu.expanded === 'true' &&
			menu.items.includes('Proxy') &&
			menu.items.includes('Themes') &&
			menu.items.includes('Settings') &&
			menu.items.includes('About') &&
			menu.vibe === hasVibe &&
			menu.menuRect.left >= 0 &&
			menu.menuRect.right <= width &&
			menu.menuRect.top >= 0 &&
			menu.menuRect.bottom <= height,
		JSON.stringify(menu),
	);
	// the entry's > is drawn, not an empty icon (submenuArrow was defined
	// after the Proxy entry was built, which left its <svg> empty)
	const arrow = await page.evaluate(() => {
		const icon = document.querySelector('#menuProxy .pmSubmenuArrow');
		const box = icon?.getBoundingClientRect();
		return {
			paths: icon?.querySelectorAll('path').length ?? 0,
			width: box?.width ?? 0,
		};
	});
	ok(
		`${mode}: the Proxy entry shows its submenu arrow`,
		arrow.paths > 0 && arrow.width > 0,
		JSON.stringify(arrow),
	);

	await page.click('#menuProxy');
	menu = await readMenu(page);
	ok(
		`${mode}: Proxy submenu shows the real settings, within the viewport`,
		menu.submenu &&
			!menu.stored &&
			(await page.locator('#adblock').isVisible()) &&
			(await page.locator('#tor').isVisible()) &&
			(await page.locator('#transport').isVisible()) &&
			menu.childRect.left >= 0 &&
			menu.childRect.right <= width &&
			menu.childRect.top >= 0 &&
			menu.childRect.bottom <= height,
		JSON.stringify(menu),
	);
	await page.focus('#adblock');
	await page.keyboard.press('ArrowDown');
	ok(
		`${mode}: submenu arrow keys reach Tor`,
		(await readMenu(page)).focused === 'tor',
	);
	await page.keyboard.press('Escape');
	menu = await readMenu(page);
	ok(
		`${mode}: Escape closes only Proxy and returns the controls to storage`,
		menu.open && !menu.submenu && menu.stored,
		JSON.stringify(menu),
	);
	await page.keyboard.press('Escape');
	ok(
		`${mode}: Escape closes Settings and resets aria-expanded`,
		!(await readMenu(page)).open &&
			(await page.getAttribute('#settingsTab', 'aria-expanded')) === 'false',
	);

	await page.click('#settingsTab');
	await page.click('#menuAbout');
	ok(
		`${mode}: Settings opens the existing About dialog`,
		await page.evaluate(
			() =>
				document.getElementById('shieldsPage').dataset.view === 'about' &&
				!document.getElementById('shieldsPage').classList.contains('hidden'),
		),
	);
	await page.click('#spClose');
	await page.click('#settingsTab');
	await page.click('#menuProxy');
	const priorBlock = await page.isChecked('#adblock');
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.click('#adblock'),
	]);
	await ready(page);
	ok(
		`${mode}: Block ads changes its stored setting and reloads`,
		(await page.isChecked('#adblock')) !== priorBlock &&
			(await page.evaluate(() =>
				localStorage.getItem('stomp-demo:adblock'),
			)) === (priorBlock ? '0' : '1'),
	);

	// Restore the choice, exercising the same control in the other direction.
	await page.click('#settingsTab');
	await page.click('#menuProxy');
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.click('#adblock'),
	]);
	await ready(page);

	await page.click('#settingsTab');
	await page.click('#menuProxy');
	await page.selectOption('#transport', 'libcurl');
	await ready(page);
	const transport = await page.evaluate(() => ({
		selected: document.getElementById('transport').value,
		stored: localStorage.getItem('stomp-demo:transport'),
	}));
	ok(
		`${mode}: Transport changes through Proxy and remains stored`,
		transport.selected === 'libcurl' && transport.stored === 'libcurl',
		JSON.stringify(transport),
	);
	await page.selectOption('#transport', 'epoxy');
	await ready(page);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	// The same menu is available from the browser's hamburger, not just home.
	await submitLanding(page, `${FIXTURE}pages/bookmark-a.html`);
	await page.waitForSelector('#browser:not(.hidden)', { timeout: 30000 });
	await page.click('#toolMenu');
	await page.click('#menuProxy');
	menu = await readMenu(page);
	ok(
		`${mode}: hamburger Proxy submenu has the same settings`,
		menu.submenu &&
			(await page.locator('#transport').isVisible()) &&
			(await page.locator('#tor').isVisible()) &&
			menu.controls.join(',') === 'adblock,tor,transport',
		JSON.stringify(menu),
	);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	ok(
		`${mode}: closing the hamburger restores the Proxy controls`,
		(await readMenu(page)).stored,
	);

	await context.close();
}

if (hasVibe) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(PROXY);
	await ready(page);
	await page.click('#settingsTab');
	await page.click('#menuVibe');
	const entered = await page
		.waitForFunction(
			() => document.body.classList.contains('vibeos'),
			undefined,
			{
				timeout: 60000,
			},
		)
		.then(() => true)
		.catch(() => false);
	ok(
		'the home Settings menu launches the real vibeOS desktop',
		entered &&
			(await page.evaluate(
				() =>
					!!document.querySelector('#vibeos-root') &&
					document.getElementById('pmMenu').classList.contains('hidden'),
			)),
	);
	await context.close();
}

await done(browser, errors);
