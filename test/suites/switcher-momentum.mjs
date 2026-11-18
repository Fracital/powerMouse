// Swiping through the switcher: a slow drag of one card's pitch moves exactly
// one card either way, a fast flick carries several with a settle time that
// scales with the distance, and nothing in the switcher is text-selectable.
// The flick's checks depend on the velocity measured from the pointer's
// timing, which a two-core runner misreads: SKIP_TIMING=1 leaves them out
// and keeps the rest. A slow drag reads no velocity (the pointer rests
// before it lifts, so the last 80 ms hold one sample).
import {
	done,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const SKIP_TIMING = process.env.SKIP_TIMING === '1';

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

/** a slow drag of one pitch, the pointer resting before it lifts */
const slowDrag = async (direction) => {
	await page.mouse.move(640, 300);
	await page.mouse.down();
	for (let d = 0; d <= 740; d += 20) {
		await page.mouse.move(640 + direction * d, 300);
		await sleep(40);
	}
	await sleep(120);
	await page.mouse.up();
	await sleep(700);
};

// rightwards from the last card goes back one, leftwards forward again
let before = await index();
await slowDrag(1);
ok(
	'slow drag of one pitch to the right moves back one card',
	(await index()) === before - 1,
	`${before} -> ${await index()}`,
);
before = await index();
await slowDrag(-1);
ok(
	'slow drag of one pitch moves one card',
	(await index()) === before + 1,
	`${before} -> ${await index()}`,
);

// a fast flick: short travel, high velocity, carries several cards
if (SKIP_TIMING)
	console.log('SKIP the fast flick (pointer timing; SKIP_TIMING=1)');
else {
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
}

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
