// Swiping through the switcher: a fast flick carries several cards with a
// settle time that scales with the distance, a slow drag moves exactly one,
// and nothing in the switcher is text-selectable.
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

for (let i = 0; i < 6; i++) {
	await page.click('#home');
	await submitLanding(page, `https://example.com/?t=${i}`);
	await waitActive(page, () => document.title === 'Example Domain');
}
await page.click('#recents');
await page.waitForSelector('.cardLabel');
await sleep(500);

const index = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.cardLabel')].findIndex(
			(l) => l.style.opacity === '1',
		),
	);
const settleVar = () =>
	page.evaluate(() =>
		getComputedStyle(document.documentElement)
			.getPropertyValue('--recents-settle')
			.trim(),
	);

ok('six tabs, last centred', (await index()) === 5, String(await index()));

// a fast flick: short travel, high velocity, carries several cards
await page.mouse.move(640, 300);
await page.mouse.down();
for (let x = 640; x <= 900; x += 65) {
	await page.mouse.move(x, 300);
	await sleep(8);
}
await page.mouse.up();
const settle = await settleVar();
await sleep(800);
const afterFlick = await index();
ok(
	'fast flick travels more than one card',
	afterFlick <= 3,
	`index ${afterFlick}, settle ${settle}`,
);
ok(
	'settle duration scales with distance',
	/^\d+ms$/.test(settle) && parseInt(settle) > 250,
	settle,
);
ok('settle variable cleared afterwards', (await settleVar()) === '');

// a slow drag of one card width moves exactly one
const before = await index();
await page.mouse.move(640, 300);
await page.mouse.down();
for (let x = 640; x >= 640 - 740; x -= 20) {
	await page.mouse.move(x, 300);
	await sleep(40);
}
await sleep(120);
await page.mouse.up();
await sleep(700);
ok(
	'slow drag of one pitch moves one card',
	(await index()) === before + 1,
	`${before} -> ${await index()}`,
);

const selectable = await page.evaluate(() =>
	[
		'.cardLabel .status',
		'.dockButton',
		'.closeAll',
		'.recentsCount',
		'.navbtn',
	].map((s) => getComputedStyle(document.querySelector(s)).userSelect),
);
ok(
	'status chip, buttons and bar are not selectable',
	selectable.every((v) => v === 'none'),
	selectable.join(','),
);

await done(browser, page.errors);
