// The address bar's Back, Forward and Reload buttons act on the active tab:
// Back and Forward step its history and grey out with nowhere to go, Back at
// the start of history stays in the tab (the navigation bar's goes home),
// and Reload reloads the page in place.
import {
	done,
	FIXTURE,
	launch,
	ok,
	omni,
	onLanding,
	openDemo,
	sleep,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const HOST = page.url();
const ONE = `${FIXTURE}pages/hist-1.html`;
const TWO = `${FIXTURE}pages/hist-2.html`;

const omniIs = (value) =>
	page
		.waitForFunction(
			(v) => document.querySelector('#omni input').value === v,
			value,
			{ timeout: 30000 },
		)
		.then(
			() => true,
			() => false,
		);
const disabled = () =>
	page.evaluate(() =>
		['toolBack', 'toolForward', 'toolReload'].map(
			(id) => document.getElementById(id).disabled,
		),
	);
// the buttons follow the frame's history on its load event: give it a moment
const settle = async (want) => {
	for (let i = 0; i < 40; i++) {
		const now = await disabled();
		if (JSON.stringify(now) === JSON.stringify(want)) return now;
		await sleep(250);
	}
	return disabled();
};

await submitLanding(page, ONE);
ok('the first page opens', await omniIs(ONE), await omni(page));
ok(
	'one page in: Back and Forward greyed out, Reload not',
	JSON.stringify(await settle([true, true, false])) === '[true,true,false]',
	JSON.stringify(await disabled()),
);

await sleep(500);
await submitOmni(page, TWO);
ok('the second page opens', await omniIs(TWO), await omni(page));
ok(
	'two pages in: Back on, Forward greyed out',
	JSON.stringify(await settle([false, true, false])) === '[false,true,false]',
	JSON.stringify(await disabled()),
);

await page.click('#toolBack');
ok('Back goes to the first page', await omniIs(ONE), await omni(page));
ok(
	'at the first page: Back greyed out, Forward on',
	JSON.stringify(await settle([true, false, false])) === '[true,false,false]',
	JSON.stringify(await disabled()),
);

// a greyed-out Back neither leaves the tab nor walks the host page
await page.click('#toolBack', { force: true }).catch(() => {});
await sleep(800);
ok('Back at the start stays in the tab', !(await onLanding(page)));
ok('the demo page is still the top', page.url().startsWith(HOST), page.url());

await page.click('#toolForward');
ok('Forward goes to the second page', await omniIs(TWO), await omni(page));
ok(
	'Forward greyed out again at the end',
	JSON.stringify(await settle([false, true, false])) === '[false,true,false]',
	JSON.stringify(await disabled()),
);

// Reload: a mark left in the page is gone afterwards, the URL is the same
const frame = await waitActive(page, () => document.title === 'HIST 2');
await frame.evaluate(() => {
	window.__mark = 1;
});
await page.click('#toolReload');
let reloaded = false;
for (let i = 0; i < 80 && !reloaded; i++) {
	await sleep(250);
	const now = await waitActive(page, () => document.readyState === 'complete');
	reloaded = await now
		.evaluate(
			() => window.__mark === undefined && !!document.querySelector('h1'),
		)
		.catch(() => false);
}
ok('Reload reloads the page', reloaded);
ok(
	'the URL is unchanged after Reload',
	(await omni(page)) === TWO,
	await omni(page),
);
ok(
	'Reload adds no history entry',
	JSON.stringify(await settle([false, true, false])) === '[false,true,false]',
	JSON.stringify(await disabled()),
);

await done(browser, page.errors);
