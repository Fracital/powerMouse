// Opening the switcher from the home screen slides the dock buttons out of
// the quick-link tiles (and back); from the browser view the dock fades in.
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

const sampleAfterClick = (id, selector) =>
	page.evaluate(
		([id, selector]) =>
			new Promise((resolve) => {
				document.getElementById(id).click();
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						resolve(
							[...document.querySelectorAll(selector)].map((element) => {
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
		[id, selector],
	);

const tiles = await rects(page, '.btn-fancy');
const early = await sampleAfterClick('recents', '.dockButton');
ok(
	'dock buttons start on top of the home tiles',
	near(early, tiles, 40),
	JSON.stringify({ early: early[0], tile: tiles[0] }),
);
ok(
	'dock is solid during the move',
	await page.evaluate(
		() => getComputedStyle(document.querySelector('.dock')).opacity === '1',
	),
);
await sleep(500);
const dock = await rects(page, '.dockButton');
ok(
	'dock buttons end in the dock (bottom, full width)',
	dock[0][1] + dock[0][3] === 800 - 48 &&
		dock.reduce((w, r) => w + r[2], 0) >= 1270,
	JSON.stringify(dock[0]),
);
ok(
	'no inline transform left on dock buttons',
	await page.evaluate(() =>
		[...document.querySelectorAll('.dockButton')].every(
			(e) => !e.style.transform,
		),
	),
);

const earlyTiles = await sampleAfterClick('home', '.btn-fancy');
ok(
	'home tiles start on top of the dock buttons',
	near(earlyTiles, dock, 40),
	JSON.stringify({ early: earlyTiles[0], dock: dock[0] }),
);
await sleep(500);
ok(
	'home tiles end back in place',
	near(await rects(page, '.btn-fancy'), tiles, 1),
);

await submitLanding(page, 'https://example.com');
await waitActive(page, () => document.title === 'Example Domain');
// the dock's opacity on every frame for a second after the click: a fade
// has values strictly between 0 and 1 and ends at 1. Sampling one instant is
// a timing measurement (a loaded runner may not have drawn the first frame
// yet), so under SKIP_TIMING it is enough that the dock went from hidden to
// fully shown
const fade = await page.evaluate(
	() =>
		new Promise((resolve) => {
			const dock = document.querySelector('.dock');
			const samples = [];
			document.getElementById('recents').click();
			const start = performance.now();
			const tick = () => {
				samples.push(parseFloat(getComputedStyle(dock).opacity));
				if (performance.now() - start < 1000) requestAnimationFrame(tick);
				else resolve(samples);
			};
			requestAnimationFrame(tick);
		}),
);
const between = fade.some((o) => o > 0 && o < 1);
ok(
	'from the browser view the dock fades in',
	fade.at(-1) === 1 &&
		(between || (process.env.SKIP_TIMING === '1' && fade[0] < 1)),
	JSON.stringify([fade[0], fade.find((o) => o > 0 && o < 1), fade.at(-1)]),
);

await done(browser, page.errors);
