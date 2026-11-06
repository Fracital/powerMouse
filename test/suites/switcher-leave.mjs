// Every way of leaving the switcher for the home screen slides the quick-link
// tiles out of the dock and settles them in place.
import {
	done,
	launch,
	near,
	ok,
	openDemo,
	rects,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

/** run `source` in the page and sample the tiles two frames later */
const leaveAndSample = (source) =>
	page.evaluate(
		(src) =>
			new Promise((resolve) => {
				new Function(src)();
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						resolve(
							[...document.querySelectorAll('.btn-fancy')].map((element) => {
								const r = element.getBoundingClientRect();
								return [
									Math.round(r.left),
									Math.round(r.top),
									Math.round(r.width),
									Math.round(r.height),
								];
							}),
						),
					),
				);
			}),
		source,
	);

const tiles = await rects(page, '.btn-fancy');
const ways = {
	'Back button': "document.getElementById('back').click()",
	'+ (new tab)': "document.getElementById('newTab').click()",
	'Recents button again': "document.getElementById('recents').click()",
	Escape:
		"document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
};
for (const [name, source] of Object.entries(ways)) {
	await page.evaluate(() => document.getElementById('recents').click());
	await sleep(450);
	const dock = await rects(page, '.dockButton');
	const early = await leaveAndSample(source);
	await sleep(450);
	const landingShown = await page.evaluate(
		() =>
			!document.getElementById('landing').classList.contains('hidden') &&
			!document.body.classList.contains('recents'),
	);
	ok(
		`${name}: tiles slide out of the dock and settle`,
		landingShown &&
			near(early, dock, 40) &&
			near(await rects(page, '.btn-fancy'), tiles, 1),
		JSON.stringify({ early: early[0], dock: dock[0] }),
	);
}

// Close all on the last tab
await submitLanding(page, 'https://example.com');
await waitActive(page, () => document.title === 'Example Domain');
await page.click('#home');
await sleep(400);
await page.evaluate(() => document.getElementById('recents').click());
await sleep(450);
const dock = await rects(page, '.dockButton');
const early = await leaveAndSample(
	"document.getElementById('closeAll').click()",
);
await sleep(450);
ok(
	'Close all on the last tab: tiles slide out of the dock',
	near(early, dock, 40) && near(await rects(page, '.btn-fancy'), tiles, 1),
	JSON.stringify({ early: early[0], dock: dock[0] }),
);

await done(browser, page.errors);
