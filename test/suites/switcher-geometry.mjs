// The switcher's geometry: a card is the whole browser view (bar copy plus
// frame) under one transform, expanding it lands the frame on its resting
// box without a jump or a resize, non-focused cards appear in place, the bar
// copy stays visible while a card expands, and the dock fades out when a
// card is opened from a switcher that was entered from the home screen.
// Each card's bar copy is the live bar as that tab would show it (Back,
// Forward and Reload in their places and states, the tab's URL), at desktop
// and phone widths.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const ONE = `${FIXTURE}pages/hist-1.html`;
const TWO = `${FIXTURE}pages/hist-2.html`;
const shows = (title) =>
	waitActive(
		page,
		`document.title === ${JSON.stringify(title)} &&
			document.readyState === 'complete'`,
	).then(() => sleep(500));
// tab A: two pages in, on the second (Back on, Forward off)
await submitLanding(page, ONE);
await shows('HIST 1');
await submitOmni(page, TWO);
await shows('HIST 2');
// tab B: two pages in, back on the first (Back off, Forward on)
await page.click('#home');
await submitLanding(page, `${ONE}?b`);
await shows('HIST 1');
await submitOmni(page, `${TWO}?b`);
await shows('HIST 2');
await page.click('#toolBack');
await shows('HIST 1');
const toolStates = () =>
	page.evaluate(() =>
		['toolBack', 'toolForward', 'toolReload'].map(
			(id) => document.getElementById(id).disabled,
		),
	);
for (let i = 0; i < 40; i++) {
	if (JSON.stringify(await toolStates()) === '[true,false,false]') break;
	await sleep(250);
}

/**
 * Every card's bar copy against the live bar: its pieces (Back, Forward,
 * Reload, the address box, the status chip) measured in the card and scaled
 * back to page pixels must sit where the live bar's are, so expanding a card
 * lands each one on its counterpart. Also each card's URL and button states.
 */
const cardBars = () =>
	page.evaluate(() => {
		const chrome = document.querySelector('.chrome');
		const c = chrome.getBoundingClientRect();
		const live = [
			'#toolBack',
			'#toolForward',
			'#toolReload',
			'#omni input',
			'#chromeStatus',
		].map((sel) => {
			const r = document.querySelector(sel).getBoundingClientRect();
			return [r.left - c.left, r.top - c.top, r.width, r.height];
		});
		const cards = [...document.querySelectorAll('.cardLabel')].map((label) => {
			const l = label.getBoundingClientRect();
			const k = l.width / innerWidth;
			const bar = label.querySelector('.cardChrome');
			const pieces = [
				...bar.querySelectorAll('.toolbtn'),
				bar.querySelector('.url'),
				bar.querySelector('.status'),
			].map((el) => {
				const r = el.getBoundingClientRect();
				return [
					(r.left - l.left) / k,
					(r.top - l.top) / k,
					r.width / k,
					r.height / k,
				];
			});
			return {
				url: bar.querySelector('.url').textContent,
				tools: [...bar.querySelectorAll('.toolbtn')].map((t) => [
					t.dataset.tool,
					t.classList.contains('disabled'),
					!!t.querySelector('img')?.complete,
				]),
				// furthest any piece is from its place on the live bar, page px
				off: Math.max(
					...pieces.flatMap((p, i) =>
						p.map((v, j) => Math.abs(v - live[i][j])),
					),
				),
			};
		});
		return { live: live.map((p) => p.map(Math.round)), cards };
	});

const boxes = () =>
	page.evaluate(() => {
		const box = (el) => {
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return [
				Math.round(b.left),
				Math.round(b.top),
				Math.round(b.width),
				Math.round(b.height),
			];
		};
		const labels = [...document.querySelectorAll('.cardLabel')];
		const active = labels.find((l) => l.style.opacity === '1');
		return {
			frame: box(document.querySelector('.frame:not(.hidden)')),
			chrome: box(document.querySelector('.chrome')),
			label: box(active),
			strip: box(active?.querySelector('.cardChrome')),
		};
	});

const rest = await boxes();
ok(
	'at rest the frame sits below the bar and above the navbar',
	rest.frame[1] === rest.chrome[3] &&
		rest.frame[1] + rest.frame[3] === 800 - 48,
	JSON.stringify(rest),
);

// entering from a tab: the inactive card never moves, the active bar shrinks
const entry = await page.evaluate(
	() =>
		new Promise((resolve) => {
			const out = [];
			document.getElementById('recents').click();
			const start = performance.now();
			const tick = () => {
				const labels = [...document.querySelectorAll('.cardLabel')];
				const inactive = labels.find((l) => l.style.opacity !== '1');
				const active = labels.find((l) => l.style.opacity === '1');
				const r = inactive?.getBoundingClientRect();
				const a = active?.getBoundingClientRect();
				out.push([
					Math.round(performance.now() - start),
					r ? Math.round(r.left) : null,
					a ? Math.round(a.width) : null,
				]);
				if (performance.now() - start < 350) requestAnimationFrame(tick);
				else resolve(out);
			};
			tick();
		}),
);
const inactiveLefts = new Set(entry.map((s) => s[1]).filter((v) => v !== null));
ok(
	'non-focused card appears in place (no slide)',
	inactiveLefts.size === 1,
	[...inactiveLefts].join(','),
);
ok(
	'focused card shrinks from full width',
	entry[0][2] === 1280 && entry.at(-1)[2] < 1000,
	`${entry[0][2]} -> ${entry.at(-1)[2]}`,
);
await sleep(400);

const bars = await cardBars();
ok(
	"each card's bar copy has Back, Forward and Reload with its tab's states",
	JSON.stringify(bars.cards.map((c) => c.tools)) ===
		JSON.stringify([
			[
				['toolBack', false, true],
				['toolForward', true, true],
				['toolReload', false, true],
			],
			[
				['toolBack', true, true],
				['toolForward', false, true],
				['toolReload', false, true],
			],
		]),
	JSON.stringify(bars.cards.map((c) => c.tools)),
);
ok(
	"each card's bar copy shows its own tab's URL",
	JSON.stringify(bars.cards.map((c) => c.url)) ===
		JSON.stringify([TWO, `${ONE}?b`]),
	JSON.stringify(bars.cards.map((c) => c.url)),
);
ok(
	"every piece of a card's bar sits where the live bar's does",
	bars.cards.every((c) => c.off <= 1),
	`${bars.cards.map((c) => c.off.toFixed(2))} live ${JSON.stringify(bars.live)}`,
);

const inSwitcher = await boxes();
const k = inSwitcher.label[3] / (800 - 48);
ok(
	'card is the whole view: bar copy on top, frame directly under it',
	Math.abs(inSwitcher.strip[3] - rest.chrome[3] * k) <= 1 &&
		inSwitcher.frame[1] === inSwitcher.label[1] + inSwitcher.strip[3] &&
		Math.abs(inSwitcher.frame[3] - rest.frame[3] * k) <= 1,
	JSON.stringify(inSwitcher),
);

// leaving: the bar copy stays until the real bar covers it, the frame lands
// on its resting box without a jump at teardown
const leave = await page.evaluate(
	() =>
		new Promise((resolve) => {
			const out = [];
			const label = [...document.querySelectorAll('.cardLabel')].find(
				(l) => l.style.opacity === '1',
			);
			const bar = label.querySelector('.cardChrome');
			const frame = document.querySelector('.frame:not(.hidden)');
			label.click();
			const start = performance.now();
			const tick = () => {
				const f = frame.getBoundingClientRect();
				out.push([
					Math.round(performance.now() - start),
					+f.top.toFixed(1),
					+f.height.toFixed(1),
					+(+getComputedStyle(bar).opacity).toFixed(2),
					getComputedStyle(document.querySelector('.chrome')).visibility,
				]);
				if (performance.now() - start < 500) requestAnimationFrame(tick);
				else resolve(out);
			};
			tick();
		}),
);
let maxJump = 0;
for (let i = 1; i < leave.length; i++)
	maxJump = Math.max(maxJump, Math.abs(leave[i][1] - leave[i - 1][1]));
const closing = leave.filter((s) => s[4] === 'hidden');
ok(
	'bar copy stays opaque while the card expands',
	closing.length > 5 && closing.every((s) => s[3] === 1),
	JSON.stringify(closing.slice(-3)),
);
// the per-frame delta is a timing measurement: a dropped frame on a loaded
// runner reads as a jump, so under SKIP_TIMING only the resting box counts
const smooth = process.env.SKIP_TIMING === '1' || maxJump < 30;
ok(
	'frame settles on its resting box with no jump at teardown',
	smooth &&
		leave.at(-1)[1] === rest.frame[1] &&
		leave.at(-1)[2] === rest.frame[3],
	`max per-frame top change ${maxJump.toFixed(1)}, final ${JSON.stringify(leave.at(-1))}`,
);
const after = await boxes();
ok(
	'frame back at rest',
	JSON.stringify(after.frame) === JSON.stringify(rest.frame),
	JSON.stringify(after.frame),
);

// opening the other tab's card: its bar copy shows what the live bar will
// (that tab's URL and states) from the first frame, not the tab it left
await page.click('#recents');
await sleep(500);
await page.evaluate(() =>
	[...document.querySelectorAll('.cardLabel')]
		.find((l) => l.style.opacity !== '1')
		.click(),
);
await sleep(500);
const opened = await page.evaluate(() => {
	const label = [...document.querySelectorAll('.cardLabel')].find(
		(l) => l.style.opacity === '1',
	);
	label.click();
	const bar = label.querySelector('.cardChrome');
	return {
		copy: [
			bar.querySelector('.url').textContent,
			...[...bar.querySelectorAll('.toolbtn')].map((t) =>
				t.classList.contains('disabled'),
			),
		],
		live: [
			document.querySelector('#omni input').value,
			...['toolBack', 'toolForward', 'toolReload'].map(
				(id) => document.getElementById(id).disabled,
			),
		],
	};
});
ok(
	'an opening card shows the live bar it lands on',
	JSON.stringify(opened.copy) === JSON.stringify(opened.live) &&
		JSON.stringify(opened.live) === JSON.stringify([TWO, false, true, false]),
	JSON.stringify(opened),
);
await sleep(600);

/**
 * Open the centred card and watch every frame of the animation: a grid of
 * points over the opening card must never hit another card's label (its bar
 * copy, close button or body), and no other tab's frame may still be visible within
 * the card's box. Every label is drawn over every frame, so a neighbour that
 * merely faded out painted its bar over the opening page for ~150 ms.
 */
const sampleOpen = () =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				const labels = [...document.querySelectorAll('.cardLabel')];
				const label = labels.find((l) => l.style.opacity === '1');
				const frames = [...document.querySelectorAll('.frames .frame')];
				label.click();
				const own = document.querySelector('.frame:not(.hidden)');
				const bad = [];
				let painted = 0;
				const start = performance.now();
				const tick = () => {
					if (!document.body.classList.contains('recents')) {
						resolve({ frames: painted, bad: bad.slice(0, 5) });
						return;
					}
					painted++;
					const t = Math.round(performance.now() - start);
					const r = label.getBoundingClientRect();
					for (let i = 1; i < 8; i++)
						for (let j = 1; j < 8; j++) {
							const x = r.left + (r.width * i) / 8;
							const y = r.top + (r.height * j) / 8;
							const hit = document.elementFromPoint(x, y);
							const other = hit?.closest('.cardLabel');
							if (other && other !== label)
								bad.push([t, 'label', hit.className, x | 0, y | 0]);
						}
					for (const frame of frames) {
						if (frame === own) continue;
						const f = frame.getBoundingClientRect();
						const style = getComputedStyle(frame);
						const overlaps =
							f.right > r.left &&
							f.left < r.right &&
							f.bottom > r.top &&
							f.top < r.bottom;
						if (
							overlaps &&
							style.visibility !== 'hidden' &&
							+style.opacity > 0.01
						)
							bad.push([t, 'frame', +(+style.opacity).toFixed(2)]);
					}
					if (performance.now() - start < 1000) requestAnimationFrame(tick);
					else resolve({ frames: painted, bad: bad.slice(0, 5), stuck: true });
				};
				tick();
			}),
	);

// the first tab's card (its neighbour to the right), then the second's (its
// neighbour to the left; a side card centres on the first press)
for (const [which, centre] of [
	['first', false],
	['second', true],
]) {
	await page.click('#recents');
	await sleep(500);
	if (centre) {
		await page.evaluate(() =>
			[...document.querySelectorAll('.cardLabel')]
				.find((l) => l.style.opacity !== '1')
				.click(),
		);
		await sleep(500);
	}
	const open = await sampleOpen();
	ok(
		`opening the ${which} card: no other card shows over it`,
		open.frames > 3 && !open.stuck && open.bad.length === 0,
		JSON.stringify(open),
	);
	await sleep(400);
}

// the dock fades out whichever way the switcher was entered
for (const from of ['home', 'browser']) {
	if (from === 'home') await page.click('#home');
	else {
		await page.click('#recents');
		await sleep(400);
		await page.evaluate(() =>
			[...document.querySelectorAll('.cardLabel')]
				.find((l) => l.style.opacity === '1')
				.click(),
		);
		await sleep(600);
	}
	await page.click('#recents');
	await sleep(700);
	const samples = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const out = [];
				const dock = document.getElementById('dock');
				const start = performance.now();
				const tick = () => {
					out.push([
						Math.round(performance.now() - start),
						+getComputedStyle(dock).opacity,
						document.body.classList.contains('recents'),
					]);
					if (performance.now() - start < 300) requestAnimationFrame(tick);
					else resolve(out);
				};
				// the centred card opens on one click; a side card would only centre
				[...document.querySelectorAll('.cardLabel')]
					.find((l) => l.style.opacity === '1')
					.click();
				tick();
			}),
	);
	const whileOpen = samples.filter((s) => s[2]);
	ok(
		`dock fades out when opening a card (entered from ${from})`,
		whileOpen.length > 3 && whileOpen.at(-1)[1] < 0.2 && whileOpen[0][1] > 0.8,
		`${whileOpen[0]?.[1]} -> ${whileOpen.at(-1)?.[1]}`,
	);
	await sleep(400);
}

// a phone: the bar is cramped (the address box gives way), and the copy
// still matches it piece by piece and lands on it
await page.setViewportSize({ width: 390, height: 844 });
await sleep(500);
const phoneRest = await boxes();
await page.click('#recents');
await sleep(600);
const phoneBars = await cardBars();
ok(
	"phone: every piece of a card's bar sits where the live bar's does",
	phoneBars.cards.every((c) => c.off <= 1),
	`${phoneBars.cards.map((c) => c.off.toFixed(2))} live ${JSON.stringify(phoneBars.live)}`,
);
const phoneOpen = await sampleOpen();
ok(
	'phone: no other card shows over the opening card',
	phoneOpen.frames > 3 && !phoneOpen.stuck && phoneOpen.bad.length === 0,
	JSON.stringify(phoneOpen),
);
await sleep(700);
const phoneAfter = await boxes();
ok(
	'phone: frame and bar back at rest after opening a card',
	JSON.stringify(phoneAfter.frame) === JSON.stringify(phoneRest.frame) &&
		JSON.stringify(phoneAfter.chrome) === JSON.stringify(phoneRest.chrome),
	JSON.stringify([phoneRest, phoneAfter]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
