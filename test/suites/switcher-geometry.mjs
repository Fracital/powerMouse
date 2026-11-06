// The switcher's geometry: a card is the whole browser view (bar copy plus
// frame) under one transform, expanding it lands the frame on its resting
// box without a jump or a resize, non-focused cards appear in place, the bar
// copy stays visible while a card expands, and the dock fades out when a
// card is opened from a switcher that was entered from the home screen.
import { done, launch, ok, openDemo, sleep, submitLanding } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const open = async (url) => {
	await page.click('#home');
	await submitLanding(page, url);
	await sleep(2500);
};
await open('https://example.com/?a');
await open('https://example.org/?b');

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
ok(
	'frame settles on its resting box with no jump at teardown',
	maxJump < 30 &&
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

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
