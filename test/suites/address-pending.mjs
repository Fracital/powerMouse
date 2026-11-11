// The address bar shows where a navigation is going from the moment it
// starts until the new document commits, as a browser's does: the document
// it leaves still reports while a slow page is on its way, and that must
// never put the old URL back. The tab cards and the bookmark star follow
// the same URL; Reload stops the navigation and shows the page again. Both
// controller modes at once, each in a context of its own.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} from '../lib.mjs';

const A = `${FIXTURE}pages/bookmark-a.html`;
const slow = (tag) => `${FIXTURE}slow-page?ms=2500&${tag}`;

const browser = await launch();
const errors = [];

async function until(page, read, want, timeout = 30000, arg = undefined) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(100);
	}
	return value;
}

/**
 * Sample every frame until stopped: the live bar's URL and star, or the
 * centred card's copies of them
 */
const startSampling = (page, what) =>
	page.evaluate((kind) => {
		const read = () => {
			if (kind === 'live')
				return [
					document.querySelector('#omni input').value,
					document.getElementById('toolStar').getAttribute('aria-pressed'),
				];
			const label = [...document.querySelectorAll('.cardLabel')].find(
				(l) => l.style.opacity === '1',
			);
			return label
				? [
						label.querySelector('.urlText').textContent,
						label.querySelector('.starbtn').getAttribute('aria-pressed'),
					]
				: null;
		};
		window.__samples = [];
		window.__sampling = true;
		const tick = () => {
			if (!window.__sampling) return;
			window.__samples.push(read());
			requestAnimationFrame(tick);
		};
		tick();
	}, what);
const stopSampling = (page) =>
	page.evaluate(() => {
		window.__sampling = false;
		return window.__samples;
	});

/** the samples from the first that shows `url` on, and whether any shows `old` */
function after(samples, url, old) {
	const first = samples.findIndex((s) => s && s[0] === url);
	const rest = first === -1 ? [] : samples.slice(first);
	return {
		first,
		count: samples.length,
		old: rest.filter((s) => !s || s[0] === old).length,
		starred: rest.filter((s) => s && s[1] === 'true').length,
	};
}

async function run(mode, base) {
	await waitForServer(base);
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	await page.goto(base);
	await page.waitForFunction(
		() => document.getElementById('logMsg').textContent === 'Ready',
		null,
		{ timeout: 45000 },
	);
	const omniIs = (url) =>
		until(
			page,
			() => document.querySelector('#omni input').value,
			(v) => v === url,
		);

	// A, bookmarked: its star is on
	await submitLanding(page, A);
	await omniIs(A);
	await until(
		page,
		() => !document.getElementById('toolStar').disabled,
		Boolean,
	);
	await sleep(800);
	await page.click('#toolStar');
	await page.click('#omni input'); // the page had the focus; a user types here
	await page.keyboard.press('Escape');

	// a slow page from the address bar: never A again once it shows
	const one = slow('one');
	await startSampling(page, 'live');
	await submitOmni(page, one);
	await sleep(4500); // past the page's arrival and the old one's reports
	const live = after(await stopSampling(page), one, A);
	ok(
		`${mode}: from the press on, every frame the address bar shows the slow page, never the page it leaves nor its star`,
		live.first !== -1 && live.old === 0 && live.starred === 0,
		JSON.stringify(live),
	);
	ok(
		`${mode}: the slow page arrived and the bar still shows it`,
		(await omniIs(one)) === one,
	);

	// the same on the tab manager's card, opened while the page is on its way
	await submitOmni(page, A);
	await omniIs(A);
	await until(
		page,
		() => document.getElementById('toolStar').getAttribute('aria-pressed'),
		(v) => v === 'true',
	);
	await sleep(800);
	const two = slow('two');
	await submitOmni(page, two);
	await sleep(100);
	await page.click('#recents');
	await startSampling(page, 'card');
	await sleep(1500);
	const card = after(await stopSampling(page), two, A);
	ok(
		`${mode}: the card shows the page the tab is going to, and its star, every frame`,
		card.first === 0 && card.old === 0 && card.starred === 0,
		JSON.stringify(card),
	);
	await page.keyboard.press('Escape');
	await omniIs(two);

	// Reload stops a navigation on its way: the bar shows the page again
	await sleep(3000);
	const three = slow('three');
	await submitOmni(page, three);
	await sleep(300);
	ok(
		`${mode}: while it is on its way the bar shows the new page`,
		(await page.evaluate(() => document.querySelector('#omni input').value)) ===
			three,
	);
	await page.click('#toolReload');
	ok(
		`${mode}: Reload stops it and the bar shows the page the tab is on`,
		(await page.evaluate(() => document.querySelector('#omni input').value)) ===
			two,
	);
	await context.close();
}

await Promise.all([run('same-origin', PROXY), run('isolated', HOST)]);
await done(browser, errors);
