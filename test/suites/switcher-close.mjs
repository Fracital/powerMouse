// Closing tabs in the switcher: the X button, a short drag that keeps the
// tab, a swipe up that closes it, a click that opens it, and swiping the
// last tab away, which goes home.
import {
	done,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

const open = async (url) => {
	await page.click('#home');
	await submitLanding(page, url);
	await waitActive(page, () => document.title === 'Example Domain');
};
for (const url of [
	'https://example.com',
	'https://example.org',
	'https://example.net',
])
	await open(url);
await page.click('#recents');
await page.waitForSelector('.cardLabel');
await sleep(400);

const tabsCount = () =>
	page.evaluate(() => document.querySelectorAll('.frame').length);
const centred = () =>
	page.evaluate(() => {
		const label = [...document.querySelectorAll('.cardLabel')].find(
			(l) => l.style.opacity === '1',
		);
		const r = label.getBoundingClientRect();
		const c = label.querySelector('.close').getBoundingClientRect();
		return {
			x: r.left + r.width / 2,
			y: r.top + r.height / 2,
			cx: c.left + c.width / 2,
			cy: c.top + c.height / 2,
		};
	});
const dragUp = async (distance, step, pause) => {
	const c = await centred();
	await page.mouse.move(c.x, c.y);
	await page.mouse.down();
	for (let y = c.y; y > c.y - distance; y -= step) {
		await page.mouse.move(c.x, y);
		await sleep(pause);
	}
	await page.mouse.up();
	await sleep(400);
};

let c = await centred();
await page.mouse.click(c.cx, c.cy);
await sleep(400);
ok(
	'mouse click on X closes the tab',
	(await tabsCount()) === 2,
	String(await tabsCount()),
);
ok(
	'manager stays open after X',
	!(await page.evaluate(() =>
		document.getElementById('recentsPanel').classList.contains('hidden'),
	)),
);

await dragUp(40, 8, 30);
ok(
	'short upward drag keeps the tab',
	(await tabsCount()) === 2,
	String(await tabsCount()),
);
ok(
	'card settles back (no lift left)',
	await page.evaluate(() =>
		[...document.querySelectorAll('.frame')].every(
			(f) => f.style.opacity === '',
		),
	),
);

await dragUp(260, 20, 16);
ok(
	'swipe up closes the tab',
	(await tabsCount()) === 1,
	String(await tabsCount()),
);

c = await centred();
await page.mouse.click(c.x, c.y);
await sleep(300);
ok(
	'mouse click on card opens it',
	await page.evaluate(
		() =>
			document.getElementById('recentsPanel').classList.contains('hidden') &&
			!document.getElementById('browser').classList.contains('hidden'),
	),
);

await page.click('#recents');
await page.waitForSelector('.cardLabel');
await sleep(400);
await dragUp(260, 20, 16);
ok(
	'last tab swiped away',
	(await tabsCount()) === 0,
	String(await tabsCount()),
);
ok(
	'goes home with no tabs',
	await page.evaluate(
		() =>
			!document.getElementById('landing').classList.contains('hidden') &&
			document.getElementById('recentsPanel').classList.contains('hidden') &&
			!document.body.classList.contains('recents'),
	),
);

await done(browser, page.errors);
