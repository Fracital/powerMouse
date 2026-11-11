// The demo's request viewer: Ctrl+Shift+X slides it up with the active tab's
// proxied requests (real URLs, statuses, a cached tag on a cache hit), new
// rows land on top without moving a scrolled list, a URL copies itself when
// clicked, Clear empties it, Back and Escape close it, a long press on
// Recents toggles it, and the switcher still works afterwards. The cache is
// on by default, so the demo is opened with no query at all.
import {
	done,
	FIXTURE,
	launch,
	ok,
	omni,
	openDemo,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

const isOpen = () =>
	page.evaluate(() =>
		document.getElementById('requests').classList.contains('open'),
	);
const rows = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('#requestsList .req')].map((row) => ({
			method: row.querySelector('.method').textContent,
			status: row.querySelector('.status').textContent,
			url: row.querySelector('.url').title,
			dest: row.querySelector('.dest').textContent,
			ms: row.querySelector('.ms').textContent,
			size: row.querySelector('.size').textContent,
			tag: row.querySelector('.tag').textContent,
			error: row.querySelector('.error')?.textContent || '',
		})),
	);
const rowCount = () =>
	page.evaluate(() => document.querySelectorAll('#requestsList .req').length);
const waitForRows = (n) =>
	page.waitForFunction(
		(n) => document.querySelectorAll('#requestsList .req').length >= n,
		n,
		{ timeout: 20000 },
	);
const inRecents = () =>
	page.evaluate(() => document.body.classList.contains('recents'));
const fetchInFrame = async (n) => {
	const frame = await waitActive(page, () => true);
	await frame.evaluate(
		(n) =>
			Promise.all(
				Array.from({ length: n }, (_, i) =>
					fetch(`/pages/fresh.json?n=${Date.now()}-${i}`),
				),
			),
		n,
	);
};

// a fixture page that fetches four files twice, then /hits
await submitLanding(page, `${FIXTURE}pages/cache.html`);
await waitActive(page, () => window.__cache?.done === true);
await sleep(500);

ok('viewer starts closed', !(await isOpen()));
await page.evaluate(() => (window.__marker = 1));
await page.keyboard.press('Control+Shift+X');
await sleep(400);
ok('Ctrl+Shift+X opens the viewer', await isOpen());
ok(
	'the shortcut did not reload the page',
	(await page.evaluate(() => window.__marker)) === 1,
);
ok(
	'the panel is visible above the navigation bar',
	await page.evaluate(() => {
		const r = document.getElementById('requests').getBoundingClientRect();
		return (
			getComputedStyle(document.getElementById('requests')).visibility ===
				'visible' &&
			Math.round(r.bottom) === innerHeight - 48 &&
			r.height >= 200
		);
	}),
);

// the page load itself is a row too (destination iframe, logged by the
// worker after it served the body, so its place among the first fetches
// varies); the fetch checks below look at the fetches
const all = await rows();
const list = all.filter((r) => r.dest !== 'iframe');
ok('rows appear', list.length >= 9, String(list.length));
ok(
	'the page load is a row with destination iframe',
	all.some(
		(r) => r.dest === 'iframe' && r.url === `${FIXTURE}pages/cache.html`,
	),
	JSON.stringify(all.filter((r) => r.dest === 'iframe').map((r) => r.url)),
);
ok(
	'rows carry the real URL, not the proxied one',
	list.every((r) => r.url.startsWith(FIXTURE)),
	JSON.stringify(list.map((r) => r.url).slice(0, 3)),
);
ok(
	'statuses, times and sizes are shown',
	list.every((r) => r.status === '200' && /^\d+ ms$/.test(r.ms)) &&
		list.some((r) => /\d B$/.test(r.size)),
	JSON.stringify(list.slice(0, 3)),
);
ok(
	'newest first: /hits (fetched last) is the top row',
	list[0]?.url === `${FIXTURE}hits`,
	list[0]?.url,
);
ok(
	'destination shows fetch for a fetch()',
	list.every((r) => r.dest === 'fetch'),
	JSON.stringify([...new Set(list.map((r) => r.dest))]),
);
const fresh = list.filter((r) => r.url.endsWith('/pages/fresh.json'));
ok(
	'the second fetch of a fresh file carries the cached tag (cache on by default)',
	fresh.length === 2 && fresh[0].tag === 'cached' && fresh[1].tag === '',
	JSON.stringify(fresh.map((r) => r.tag)),
);
ok(
	'the host is bold, the path dimmed, and only the URL is selectable',
	await page.evaluate(() => {
		const row = document.querySelector('#requestsList .req');
		const style = (el) => getComputedStyle(el);
		return (
			Number(style(row.querySelector('.host')).fontWeight) >= 600 &&
			style(row.querySelector('.method')).userSelect === 'none' &&
			style(row.querySelector('.url')).userSelect === 'text'
		);
	}),
);
ok(
	'a long path keeps its tail and ellipsises in the middle',
	await page.evaluate(() => {
		const row = document.querySelector('#requestsList .req');
		const head = row.querySelector('.path .pathHead');
		const tail = row.querySelector('.path .pathTail');
		return (
			head &&
			tail &&
			tail.textContent.length > 0 &&
			getComputedStyle(head).textOverflow === 'ellipsis'
		);
	}),
);
const counts = await page.textContent('#requestsCount');
ok(
	'header counts requests, cached and failed',
	/^\d+ requests \d+ cached \d+ failed$/.test(counts) &&
		parseInt(counts) >= 9 &&
		/ [1-9]\d* cached/.test(counts),
	counts,
);
ok(
	'header names the tab',
	(await page.textContent('#requestsTitle')) === 'CACHE',
	await page.textContent('#requestsTitle'),
);

// a click on a URL copies it and flashes "copied"
await page.evaluate(() => {
	window.__copied = [];
	navigator.clipboard.writeText = (text) => {
		window.__copied.push(text);
		return Promise.resolve();
	};
});
await page.evaluate((url) => {
	[...document.querySelectorAll('#requestsList .req .url')]
		.find((el) => el.title === url)
		.click();
}, `${FIXTURE}hits`);
await sleep(150);
ok(
	'clicking a URL copies it',
	(await page.evaluate(() => window.__copied))[0] === `${FIXTURE}hits`,
	JSON.stringify(await page.evaluate(() => window.__copied)),
);
ok(
	'and flashes copied',
	await page.evaluate(
		() =>
			getComputedStyle(
				document.querySelector('#requestsList .req .url.copied'),
				'::after',
			).content === '"copied"',
	),
);
await sleep(1000);
ok('the flash goes away', !(await page.$('#requestsList .req .url.copied')));

// rows added while open land on top; a scrolled list does not jump
const before = await rowCount();
await fetchInFrame(30);
await waitForRows(before + 30);
await sleep(100);
ok(
	'rows arriving while open are added on top',
	(await rows())[0].url.includes('fresh.json?n='),
);
const anchored = await page.evaluate(() => {
	const list = document.getElementById('requestsList');
	list.scrollTop = list.scrollHeight;
	const last = list.lastElementChild;
	return {
		scrollable: list.scrollHeight > list.clientHeight,
		scrollTop: list.scrollTop,
		top: last.getBoundingClientRect().top,
		url: last.querySelector('.url').title,
	};
});
ok('the list scrolls', anchored.scrollable && anchored.scrollTop > 0);
await fetchInFrame(1);
await waitForRows(before + 31);
await sleep(100);
const after = await page.evaluate(() => {
	const list = document.getElementById('requestsList');
	const last = list.lastElementChild;
	return {
		top: last.getBoundingClientRect().top,
		url: last.querySelector('.url').title,
	};
});
ok(
	'a new row does not move what a scrolled reader is looking at',
	after.url === anchored.url && Math.abs(after.top - anchored.top) <= 1,
	JSON.stringify({ anchored, after }),
);
await page.evaluate(
	() => (document.getElementById('requestsList').scrollTop = 0),
);
await fetchInFrame(1);
await waitForRows(before + 32);
await sleep(100);
ok(
	'at the top, the list stays at the top',
	(await page.evaluate(
		() => document.getElementById('requestsList').scrollTop,
	)) === 0,
);

// Clear
await page.click('#requestsClear');
ok('Clear empties the list', (await rowCount()) === 0);
ok(
	'empty state',
	await page.evaluate(
		() =>
			!document.getElementById('requestsEmpty').classList.contains('hidden') &&
			document.getElementById('requestsEmpty').textContent ===
				'No requests yet',
	),
);
ok(
	'counts reset',
	(await page.textContent('#requestsCount')) === '0 requests 0 cached 0 failed',
	await page.textContent('#requestsCount'),
);
await fetchInFrame(1);
await waitForRows(1);
// at least the fetch; the page load itself can be attributed late on a slow machine
ok('requests after Clear show up again', (await rowCount()) >= 1);

// Back closes the viewer and does nothing else
const url = await omni(page);
await page.click('#back');
await sleep(400);
ok('Back closes the viewer', !(await isOpen()));
ok(
	'Back did not step or go home',
	(await omni(page)) === url &&
		!(await page.$eval('#browser', (e) => e.classList.contains('hidden'))),
);
ok(
	'the rows are dropped once the panel is closed',
	(await rowCount()) === 0,
	String(await rowCount()),
);

// Escape closes it too
await page.keyboard.press('Control+Shift+X');
await sleep(300);
ok('shortcut reopens', await isOpen());
ok(
	// the tab's fetch, plus the page load itself once the document request is
	// attributed to its frame
	'the ring buffer survives closing: rows are back',
	(await rowCount()) >= 1,
	String(await rowCount()),
);
await page.keyboard.press('Escape');
await sleep(300);
ok('Escape closes the viewer', !(await isOpen()));

// long press on Recents toggles it; a short click still opens the switcher
const recents = await page.locator('#recents').boundingBox();
const press = async (ms) => {
	await page.mouse.move(
		recents.x + recents.width / 2,
		recents.y + recents.height / 2,
	);
	await page.mouse.down();
	await sleep(ms);
	await page.mouse.up();
	await sleep(350);
};
await press(700);
ok('long press on Recents opens the viewer', await isOpen());
ok('without opening the switcher', !(await inRecents()));
await press(700);
ok('a second long press closes it', !(await isOpen()));
await press(700);
ok('and a third opens it again', await isOpen());
await page.click('#recents');
await sleep(400);
ok('a short click closes the viewer', !(await isOpen()));
ok('and opens the switcher as before', await inRecents());
await page.waitForSelector('.cardLabel');

// a second tab has its own log; the switcher brings the first one back
await page.keyboard.press('Escape');
await sleep(300);
ok('Escape closes the switcher', !(await inRecents()));
await page.click('#home');
await submitLanding(page, `${FIXTURE}pages/dom.html`);
await waitActive(page, () => document.readyState === 'complete');
await sleep(500);
await page.keyboard.press('Control+Shift+X');
await sleep(300);
ok(
	'the viewer shows the new tab',
	(await page.textContent('#requestsTitle')) !== 'CACHE' &&
		!(await rows()).some((r) => r.url.includes('fresh.json')),
	JSON.stringify({
		title: await page.textContent('#requestsTitle'),
		rows: (await rows()).length,
	}),
);
await page.keyboard.press('Escape');
await page.click('#recents');
await page.waitForSelector('.cardLabel');
await sleep(400);
await page.keyboard.press('ArrowLeft');
await sleep(400);
await page.keyboard.press('Enter');
await sleep(400);
ok(
	'the switcher still works: first tab back in view',
	!(await inRecents()) && (await omni(page)).endsWith('/pages/cache.html'),
	await omni(page),
);
await page.keyboard.press('Control+Shift+X');
await sleep(300);
ok(
	'and the viewer shows its log again',
	(await page.textContent('#requestsTitle')) === 'CACHE' &&
		(await rowCount()) >= 1,
	JSON.stringify({
		title: await page.textContent('#requestsTitle'),
		rows: await rowCount(),
	}),
);

await done(browser, page.errors);
