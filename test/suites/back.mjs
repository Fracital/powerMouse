// The Back button walks the tab's own history, never the host page, and
// Alt+Right goes forward again after re-entering the tab from the switcher.
import {
	clickWikipediaLink,
	done,
	launch,
	ok,
	omni,
	onLanding,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const HOST = page.url();

const omniIs = (value) =>
	page.waitForFunction(
		(b) => document.querySelector('#omni input').value === b,
		value,
		{ timeout: 30000 },
	);

await submitLanding(page, 'https://en.wikipedia.org/wiki/Main_Page');
await page.waitForFunction(
	() =>
		document
			.querySelector('#omni input')
			.value.startsWith('https://en.wikipedia.org/wiki/'),
	null,
	{ timeout: 40000 },
);
await sleep(1500);
const first = await omni(page);

const visited = [];
const clickLink = async () => {
	const before = await omni(page);
	visited.push(before.split('#')[0]);
	await clickWikipediaLink(page, visited);
	await page.waitForFunction(
		(b) => document.querySelector('#omni input').value !== b,
		before,
		{ timeout: 30000 },
	);
	await sleep(1200);
	return omni(page);
};
const second = await clickLink();
const third = await clickLink();
ok(
	'three distinct pages visited',
	new Set([first, second, third]).size === 3,
	[first, second, third].map((u) => u.slice(-25)).join(' | '),
);

await page.click('#back');
await omniIs(second).then(
	() => ok('back 1 -> second page', true),
	() => ok('back 1 -> second page', false),
);
await sleep(800);
await page.click('#back');
await omniIs(first).then(
	() => ok('back 2 -> first page', true),
	() => ok('back 2 -> first page', false),
);
await sleep(800);

// mash Back: must never leave the demo page
for (let i = 0; i < 5; i++) {
	await page.click('#back');
	await sleep(300);
}
ok(
	'mashing back never leaves the demo',
	page.url().startsWith(HOST),
	page.url(),
);
ok('back at the start of history shows the landing', await onLanding(page));
ok(
	'the tab is still open',
	await page.evaluate(() => document.querySelectorAll('.frame').length === 1),
);
await page.click('#back');
ok('back on the landing stays on the landing', await onLanding(page));

// forward still works after re-entering the tab through the switcher
await page.click('#recents');
await sleep(800);
await page.click('.cardLabel');
await sleep(500);
await page.keyboard.down('Alt');
await page.keyboard.press('ArrowRight');
await page.keyboard.up('Alt');
await omniIs(second).then(
	() => ok('Alt+Right goes forward', true),
	() => ok('Alt+Right goes forward', false),
);

await done(browser, page.errors);
