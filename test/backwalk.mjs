// Back, step by step, in three independent parts (one suite file each under
// suites/, so they run on separate servers at once): through redirects and
// in-page links in one tab, only the active tab with two open, and the
// browser's own Back, which must never find history entries the demo added.
import {
	clickWikipediaLink,
	done,
	HOST,
	launch,
	ok,
	omni,
	onLanding,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from './lib.mjs';

// a page visited before the demo, so browser Back has somewhere real to go
const PRE = `${PROXY}api/status`;

let browser;

async function fresh() {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	page.on('pageerror', (error) => console.log('pageerror', error.message));
	await page.goto(PRE);
	await page.goto(HOST);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 30000 },
	);
	return page;
}
const hostOk = (page) => page.url().startsWith(HOST);

async function go(page, url, { newTab = false } = {}) {
	const before = await omni(page).catch(() => '');
	if (newTab) await submitLanding(page, url);
	else await submitOmni(page, url);
	await page.waitForFunction(
		(b) => {
			const v = document.querySelector('#omni input').value;
			return v && v !== b;
		},
		before,
		{ timeout: 40000 },
	);
	await sleep(1500);
	return omni(page);
}

async function clickLink(page, visited) {
	const before = await omni(page);
	await clickWikipediaLink(page, visited);
	await page.waitForFunction(
		(b) => document.querySelector('#omni input').value !== b,
		before,
		{ timeout: 30000 },
	);
	await sleep(1500);
	return omni(page);
}

async function pressBack(page) {
	const before = await page.evaluate(() => [
		document.querySelector('#omni input').value,
		!document.getElementById('landing').classList.contains('hidden'),
	]);
	await page.click('#back');
	// a step commits once the previous page has loaded through the proxy
	await page
		.waitForFunction(
			(b) => {
				const v = document.querySelector('#omni input').value;
				const l = !document
					.getElementById('landing')
					.classList.contains('hidden');
				return v !== b[0] || l !== b[1];
			},
			before,
			{ timeout: 15000 },
		)
		.catch(() => {});
	await sleep(800);
	return {
		omni: await omni(page),
		landing: await onLanding(page),
		url: page.url(),
	};
}

/** one tab: redirects and in-page links */
export async function singleTab() {
	const page = await fresh();
	const trail = [];
	trail.push(await go(page, 'https://example.com', { newTab: true }));
	// the bare host redirects twice (www, then Main_Page)
	trail.push(await go(page, 'https://en.wikipedia.org'));
	const visited = [trail[1].split('#')[0]];
	trail.push(await clickLink(page, visited));
	visited.push(trail.at(-1));
	trail.push(await clickLink(page, visited));
	visited.push(trail.at(-1));
	trail.push(await clickLink(page, visited));
	console.log(
		'trail:',
		trail.map((u) => u.slice(-40)),
	);
	ok('1: five pages visited', trail.length === 5 && new Set(trail).size === 5);
	// expected walk: 4 -> 3 -> 2 -> 1 -> 0 -> landing -> landing...
	const expected = [...trail].reverse().slice(1);
	let allHost = true;
	for (let i = 0; i < expected.length; i++) {
		const r = await pressBack(page);
		allHost &&= hostOk(page);
		ok(
			`1: back ${i + 1} -> ${expected[i].slice(-40)}`,
			r.omni === expected[i] && !r.landing,
			`${r.omni.slice(-40)} landing=${r.landing} ${r.url}`,
		);
	}
	for (let i = 0; i < 4; i++) {
		const r = await pressBack(page);
		allHost &&= hostOk(page);
		ok(
			`1: back ${expected.length + i + 1} -> landing`,
			r.landing,
			`omni=${r.omni.slice(-40)} ${r.url}`,
		);
	}
	ok('1: host page never left', allHost && hostOk(page), page.url());
	ok(
		'1: tab still open',
		await page.evaluate(() => document.querySelectorAll('.frame').length === 1),
	);
	await page.close();
}

/** two tabs: Back only walks the active tab */
export async function twoTabs() {
	const page = await fresh();
	const a1 = await go(page, 'https://example.com', { newTab: true });
	const a2 = await go(page, 'https://example.org');
	await page.click('#home');
	await sleep(500);
	const b1 = await go(page, 'https://en.wikipedia.org/wiki/Main_Page', {
		newTab: true,
	});
	await clickLink(page, [b1]);
	ok(
		'2: two tabs',
		await page.evaluate(() => document.querySelectorAll('.frame').length === 2),
	);
	let r = await pressBack(page);
	ok('2: back -> b1', r.omni === b1 && !r.landing, r.omni.slice(-40));
	r = await pressBack(page);
	ok('2: back -> landing', r.landing, r.omni.slice(-40));
	r = await pressBack(page);
	ok('2: back again stays on landing', r.landing && hostOk(page), r.url);
	// the first tab was not walked: still on a2
	const locA = await page.evaluate(() => window.controller.frames[0].url);
	ok('2: tab A frame still shows a2 after walking tab B', locA === a2, locA);
	await page.click('#recents');
	await sleep(900);
	// a side card centres on the first click and opens on the second
	await page.evaluate(() => document.querySelectorAll('.cardLabel')[0].click());
	await sleep(700);
	await page.evaluate(() => document.querySelectorAll('.cardLabel')[0].click());
	await sleep(1500);
	ok(
		'2: tab A opened from the manager',
		await page.evaluate(() => document.body.classList.contains('browsing')),
	);
	const first = await omni(page);
	ok('2: tab A selected, omnibox shows a2', first === a2, `${first} vs ${a2}`);
	r = await pressBack(page);
	ok('2: tab A back -> a1', r.omni === a1 && !r.landing, r.omni);
	ok('2: host page never left', hostOk(page), page.url());
	await page.close();
}

/** browser-level Back: the demo adds no history entries of its own */
export async function browserBack() {
	const page = await fresh();
	await go(page, 'https://example.com', { newTab: true });
	const n = await page.evaluate(() => history.length);
	await page.goBack().catch(() => {});
	await sleep(1500);
	// PRE, the demo, the frame's navigation: the hash updates added nothing
	ok(
		'3: demo adds no browser history entries of its own (hash is replaceState)',
		n === 3,
		`history.length=${n}`,
	);
	ok(
		'3: browser back goes where the browser history says, not into a dangling hash entry',
		page.url() === PRE,
		page.url(),
	);
	await page.close();
}

/** run one part as a suite: its own browser, verdict and exit code */
export async function runPart(part) {
	browser = await launch();
	await part();
	await done(browser);
}
