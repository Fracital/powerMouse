// The tab manager with tabs whose next page is still on its way. A dialed
// tab loads each document in a fresh frame beside the one it shows, swapped
// in when the answer arrives (src/controller/justCallStomp.ts):
//  - while the manager is open, that loading frame is never seen: only the
//    cards are, each the tab's one frame, scaled down;
//  - a page that arrives while the manager is open lands on its card, and
//    opening the card shows it full screen;
//  - a tab closed while its page is on its way is gone: its page does not
//    arrive later in a frame of its own, behind the home page and full
//    screen over the manager's cards (the frame of no card);
//  - on a phone, as on a desktop.
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
const slow = (tag, ms = 3000) => `${FIXTURE}slow-page?ms=${ms}&${tag}`;

const browser = await launch();
const errors = [];

async function until(page, read, want, timeout = 30000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read).catch(() => undefined);
		if (want(value)) return value;
		await sleep(100);
	}
	return value;
}

/**
 * The frames in .frames: how many there are, how many cards, and those that
 * are drawn at (nearly) the stage's full size
 */
const frames = (page) =>
	page.evaluate(() => {
		const all = [...document.querySelectorAll('#frames > iframe')];
		const drawn = all.filter((frame) => {
			const style = getComputedStyle(frame);
			return style.display !== 'none' && style.visibility !== 'hidden';
		});
		return {
			frames: all.length,
			cards: document.querySelectorAll('#recentsLabels .cardLabel').length,
			recents: document.body.classList.contains('recents'),
			full: drawn.filter(
				(frame) => frame.getBoundingClientRect().width > innerWidth * 0.9,
			).length,
		};
	});

/** sample frames() every animation frame until stopped */
const startSampling = (page) =>
	page.evaluate(() => {
		window.__samples = [];
		window.__sampling = true;
		const tick = () => {
			if (!window.__sampling) return;
			const drawn = [...document.querySelectorAll('#frames > iframe')].filter(
				(frame) => {
					const style = getComputedStyle(frame);
					return style.display !== 'none' && style.visibility !== 'hidden';
				},
			);
			window.__samples.push(
				drawn.filter(
					(frame) => frame.getBoundingClientRect().width > innerWidth * 0.9,
				).length,
			);
			requestAnimationFrame(tick);
		};
		tick();
	});
const stopSampling = (page) =>
	page.evaluate(() => {
		window.__sampling = false;
		return window.__samples;
	});

async function run(label, viewport) {
	const page = await openDemo(browser, PROXY, viewport);
	const omniIs = (url) =>
		until(
			page,
			() => document.querySelector('#omni input').value,
			(v) => v === url,
		);
	const loaded = (text) =>
		until(
			page,
			() =>
				[...document.querySelectorAll('#frames > iframe')].map((frame) => {
					try {
						return frame.contentDocument?.body?.textContent || '';
					} catch {
						return '';
					}
				}),
			(texts) => Array.isArray(texts) && texts.some((t) => t.includes(text)),
			15000,
		);

	// a tab whose page is on its way, closed on its card: it is gone
	const gone = slow('gone', 2500);
	await submitLanding(page, gone);
	await sleep(400);
	await page.click('#recents');
	await sleep(400);
	await page.click('#recentsLabels .cardLabel .close');
	await sleep(3500); // past the page's answer
	const home = await frames(page);
	ok(
		`${label}: a tab closed while loading leaves no frame behind`,
		home.frames === 0,
		JSON.stringify(home),
	);

	// a tab on a page, then one on its way to the next: the manager opened
	// meanwhile shows cards only
	await submitLanding(page, A);
	await omniIs(A);
	await loaded('bookmark');
	await sleep(500);
	const two = slow('two', 2500);
	await submitOmni(page, two);
	await sleep(300);
	await page.click('#recents');
	await sleep(400); // the active card's zoom out of the full view is over
	await startSampling(page);
	await sleep(1000);
	const before = await stopSampling(page);
	const open = await frames(page);
	ok(
		`${label}: while the manager is open, the loading frame is never seen full size`,
		open.recents && before.length > 10 && before.every((n) => n === 0),
		JSON.stringify({ open, full: before.filter(Boolean).length }),
	);
	await sleep(2500); // the page arrives under the manager
	const arrived = await frames(page);
	ok(
		`${label}: the page that arrived while the manager is open is on its card, not full screen`,
		arrived.recents &&
			arrived.full === 0 &&
			arrived.frames === arrived.cards &&
			arrived.cards === 1,
		JSON.stringify(arrived),
	);
	await page.click('#recentsLabels .cardLabel .hit');
	await sleep(600);
	const shown = await frames(page);
	ok(
		`${label}: opening its card shows the page full screen`,
		!shown.recents && shown.full === 1 && shown.frames === 1,
		JSON.stringify(shown),
	);

	// home and back to the manager, again and again: still one card, no frame
	// full size over it
	for (let i = 0; i < 3; i++) {
		await page.click('#home');
		await sleep(150);
		await page.click('#recents');
		await sleep(350);
	}
	const toggled = await frames(page);
	ok(
		`${label}: home and the manager in turn leave one card and nothing full screen`,
		toggled.recents && toggled.full === 0 && toggled.frames === toggled.cards,
		JSON.stringify(toggled),
	);
	errors.push(...page.errors.map((e) => `${label}: ${e}`));
	await page.close();
}

await run('desktop', {});
await run('phone', { width: 390, height: 844 });
await done(browser, errors);
