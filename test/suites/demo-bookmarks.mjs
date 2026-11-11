// The demo's bookmarks: the four it starts with, once (a removed one stays
// removed); the home page's star tab in its own band between the
// status line and the commits, hanging off the card's left edge; the
// sidebar it opens (empty state, rows, open, remove, Escape); the address
// bar's star and every tab card's, in step with each other, the sidebar and
// another window of the demo; the real URL stored, never the route, with
// the title and the page's icon; the list kept across a reload; and no
// links beside the title, the bookmarks having taken them over. Both
// controller modes at once, each in a context of its own.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	omni,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} from '../lib.mjs';

const A = `${FIXTURE}pages/bookmark-a.html`;
const B = `${FIXTURE}pages/bookmark-b.html`;
const CROSS = `${FIXTURE}pages/bookmark-cross.html`;
const SOFT = `${FIXTURE}pages/bookmark-soft.html`;
// on another origin than every other page here (localhost, not 127.0.0.1),
// so no open page of its site can ask for its icon before it has come
const SLOW = `${FIXTURE.replace('//127.0.0.1:', '//localhost:')}slow-page?ms=3000`;
const KEY = 'stomp-demo:bookmarks';
const DEFAULTS = [
	{
		title: 'Fracital',
		url: 'https://fracit.al/',
		icon: '/pm/icons/fracital.svg',
	},
	{
		title: 'vibeOS',
		url: 'https://vibeos.fracit.al/',
		icon: '/pm/icons/vibeos.png',
	},
	{ title: 'Estro', url: 'https://estro.help/', icon: '/pm/icons/estro.svg' },
	{ title: 'Krunk', url: 'https://krunk.io/', icon: '/pm/icons/krunker.png' },
];
const DEFAULT_URLS = DEFAULTS.map((entry) => entry.url);
const urlsOf = (list) => JSON.stringify(list.map((entry) => entry.url));

const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, timeout = 30000, arg = undefined) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

const stored = (page) =>
	page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), KEY);
const liveStar = (page) =>
	page.evaluate(() => {
		const star = document.getElementById('toolStar');
		return star.disabled ? 'disabled' : star.getAttribute('aria-pressed');
	});
const cardStars = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('.cardLabel .starbtn')].map((star) =>
			star.getAttribute('aria-pressed'),
		),
	);
const rows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#bookmarksList .bookmark')].map((row) => ({
			title: row.querySelector('.bookmarkTitle').textContent,
			url: row.querySelector('.bookmarkUrl').textContent,
			// a picture kept in the list shows as its kind only
			icon: row
				.querySelector('img.bookmarkIcon')
				.getAttribute('src')
				.replace(/^(data:image\/png;base64,).*/, '$1'),
		})),
	);
const sidebarOpen = (page) =>
	page.evaluate(() =>
		document.getElementById('bookmarks').classList.contains('open'),
	);
const omniIs = (page, url) =>
	until(
		page,
		() => document.querySelector('#omni input').value,
		(v) => v === url,
	);
/** the active tab's page is in: its star is live, its icon port posted */
const loaded = async (page) => {
	await until(
		page,
		() => !document.getElementById('toolStar').disabled,
		Boolean,
	);
	await sleep(1000);
};

/** the home page's boxes: the tab must have a band of its own */
function layout(page) {
	return page.evaluate(() => {
		const box = (selector) => {
			const element = document.querySelector(selector);
			if (!element || !element.getClientRects().length) return null;
			const r = element.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
		};
		// the status line's text, not its padded box
		const range = document.createRange();
		range.selectNodeContents(document.getElementById('logMsg'));
		const text = range.getBoundingClientRect();
		const visible = (selector) =>
			getComputedStyle(document.querySelector(selector)).visibility !==
				'hidden' && box(selector);
		return {
			tab: box('#bookmarksTab'),
			listing: box('.listing'),
			status: { top: text.top, bottom: text.bottom },
			commitsHead: visible('.commits') ? box('.commitsHead') : null,
			tiles: [...document.querySelectorAll('.btn-fancy')]
				.filter((tile) => tile.getClientRects().length)
				.map((tile) => {
					const r = tile.getBoundingClientRect();
					return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
				}),
			footer: box('.lbottom'),
		};
	});
}

const overlaps = (a, b) =>
	!!a &&
	!!b &&
	a.left < b.right &&
	b.left < a.right &&
	a.top < b.bottom &&
	b.top < a.bottom;

async function checkLayout(page, mode, size) {
	const box = await layout(page);
	const where = `${mode} ${size}`;
	ok(
		`${where}: the star tab hangs off the card's left edge, against its border`,
		box.tab &&
			Math.abs(box.tab.left - (box.listing.left + 1)) <= 1 &&
			(await page.evaluate(() => {
				const style = getComputedStyle(document.getElementById('bookmarksTab'));
				return (
					style.borderLeftWidth === '0px' &&
					style.borderTopLeftRadius === '0px' &&
					style.borderBottomLeftRadius === '0px'
				);
			})),
		JSON.stringify({ tab: box.tab, listing: box.listing }),
	);
	ok(
		`${where}: the tab sits below the status line, never over it`,
		box.tab && box.tab.top >= box.status.bottom,
		JSON.stringify({ tab: box.tab, status: box.status }),
	);
	ok(
		`${where}: the tab sits above the commits`,
		!box.commitsHead || box.tab.bottom <= box.commitsHead.top,
		JSON.stringify({ tab: box.tab, commitsHead: box.commitsHead }),
	);
	ok(
		`${where}: no quick-link tile and no footer over the tab`,
		!box.tiles.some((tile) => overlaps(tile, box.tab)) &&
			!overlaps(box.footer, box.tab),
		JSON.stringify(box),
	);
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

	// the tab's own band, at desktop and phone sizes
	await page
		.waitForFunction(
			() => document.querySelectorAll('#commitList li').length,
			null,
			{
				timeout: 20000,
			},
		)
		.catch(() => {});
	for (const [width, height] of [
		[1280, 800],
		[1024, 600],
		[844, 390],
		[412, 915],
		[360, 640],
		[360, 610],
		[320, 568],
	]) {
		await page.setViewportSize({ width, height });
		await sleep(300);
		await checkLayout(page, mode, `${width}x${height}`);
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	await sleep(300);

	ok(
		`${mode}: no links beside the title but GitHub's`,
		JSON.stringify(
			await page.$$eval('.head a', (links) => links.map((a) => a.href)),
		) ===
			JSON.stringify([
				`${new URL(base).origin}/`,
				'https://github.com/Fracital/powerMouse',
			]),
		JSON.stringify(
			await page.$$eval('.head a', (links) => links.map((a) => a.href)),
		),
	);

	// the first visit's sidebar, from the keyboard
	await page.focus('#bookmarksTab');
	await page.keyboard.press('Enter');
	ok(
		`${mode}: Enter on the tab opens the sidebar`,
		(await until(
			page,
			() => document.getElementById('bookmarks').classList.contains('open'),
			Boolean,
			3000,
		)) &&
			(await page.getAttribute('#bookmarksTab', 'aria-expanded')) === 'true',
	);
	ok(
		`${mode}: the first visit starts with Fracital, vibeOS, Estro and Krunk, each with its bundled icon`,
		JSON.stringify(await rows(page)) === JSON.stringify(DEFAULTS) &&
			(await until(
				page,
				() =>
					[...document.querySelectorAll('#bookmarksList img')].every(
						(image) => image.complete && image.naturalWidth > 0,
					),
				Boolean,
				5000,
			)) === true &&
			(await page.textContent('#bookmarksCount')) === '4' &&
			urlsOf(await stored(page)) === JSON.stringify(DEFAULT_URLS),
		JSON.stringify(await rows(page)),
	);
	// Estro's and Krunker's icons are whole tiles and cover theirs; vibeOS's
	// is drawn at 22 px and shows at that size, never stretched
	const tiles = await page.evaluate(() =>
		[...document.querySelectorAll('#bookmarksList .bookmarkTile')].map(
			(tile) => {
				const image = tile.querySelector('img');
				const t = tile.getBoundingClientRect();
				const i = image.getBoundingClientRect();
				return {
					tile: [Math.round(t.width), Math.round(t.height)],
					image: [
						Math.round(i.left - t.left),
						Math.round(i.top - t.top),
						Math.round(i.width),
						Math.round(i.height),
					],
					natural: [image.naturalWidth, image.naturalHeight],
				};
			},
		),
	);
	ok(
		`${mode}: Estro's and Krunk's icons fill their 34 px tiles, vibeOS's shows at its natural 22 px`,
		JSON.stringify(tiles.map((t) => t.tile)) ===
			JSON.stringify([
				[34, 34],
				[34, 34],
				[34, 34],
				[34, 34],
			]) &&
			JSON.stringify(tiles[2].image) === '[0,0,34,34]' &&
			JSON.stringify(tiles[3].image) === '[0,0,34,34]' &&
			JSON.stringify(tiles[1].image.slice(2)) === '[22,22]' &&
			JSON.stringify(tiles[1].natural) === '[22,22]',
		JSON.stringify(tiles),
	);
	ok(
		`${mode}: the keyboard is in the sidebar, on the first bookmark`,
		(await page.evaluate(
			() =>
				document.activeElement ===
				document.querySelector('#bookmarksList .bookmarkOpen'),
		)) === true,
		await page.evaluate(() => document.activeElement?.className),
	);
	await page.keyboard.press('Escape');
	ok(
		`${mode}: Escape closes it and gives the tab its focus back`,
		!(await until(
			page,
			() => document.getElementById('bookmarks').classList.contains('open'),
			(v) => !v,
			3000,
		)) &&
			(await page.evaluate(() => document.activeElement?.id)) ===
				'bookmarksTab' &&
			(await page.getAttribute('#bookmarksTab', 'aria-expanded')) === 'false',
	);

	// the address bar's star
	await submitLanding(page, A);
	ok(`${mode}: page A opens`, (await omniIs(page, A)) === A, await omni(page));
	await loaded(page);
	ok(
		`${mode}: A not bookmarked yet: the star is off`,
		(await until(
			page,
			() =>
				document.getElementById('toolStar').getAttribute('aria-pressed') ===
					'false' && !document.getElementById('toolStar').disabled,
			Boolean,
		)) === true,
		await liveStar(page),
	);
	await page.click('#toolStar');
	ok(
		`${mode}: the address bar's star bookmarks A`,
		(await liveStar(page)) === 'true',
		await liveStar(page),
	);
	let list = await stored(page);
	ok(
		`${mode}: the real URL is stored, not the route, with the title`,
		urlsOf(list) === JSON.stringify([A, ...DEFAULT_URLS]) &&
			!list[0].url.includes('/stomp/') &&
			list[0].title === 'Bookmark A',
		JSON.stringify(list),
	);
	list = await until(
		page,
		() => JSON.parse(localStorage.getItem('stomp-demo:bookmarks') || '[]'),
		(value) => value?.[0]?.icon,
		15000,
	);
	const picture = await page.evaluate(async (icon) => {
		const image = new Image();
		image.src = icon || 'data:,';
		await image.decode().catch(() => {});
		return [image.naturalWidth, image.naturalHeight];
	}, list?.[0]?.icon);
	ok(
		`${mode}: the icon A declared is kept as a 64 px picture in the list, fetched through the proxy`,
		/^data:image\/png;base64,/.test(list?.[0]?.icon || '') &&
			JSON.stringify(picture) === '[64,64]',
		`${JSON.stringify(picture)} ${JSON.stringify(list).slice(0, 160)}`,
	);

	// a second tab; its card's star in the tab manager
	await page.click('#home');
	await sleep(400);
	await submitLanding(page, B);
	ok(`${mode}: page B opens in a new tab`, (await omniIs(page, B)) === B);
	await loaded(page);
	ok(
		`${mode}: B's star is off`,
		(await until(
			page,
			() => document.getElementById('toolStar').getAttribute('aria-pressed'),
			(v) => v === 'false',
		)) === 'false',
	);
	await page.click('#recents');
	await sleep(600);
	ok(
		`${mode}: the tab cards show A starred, B not`,
		JSON.stringify(await cardStars(page)) === '["true","false"]',
		JSON.stringify(await cardStars(page)),
	);
	// the active card's status chip is the live one, scaled: switching
	// between the page and the manager never moves it
	const chips = await page.evaluate(() => {
		const relative = (element, frame, k = 1) => {
			const r = element.getBoundingClientRect();
			const f = frame.getBoundingClientRect();
			return [r.left - f.left, r.top - f.top, r.width, r.height].map(
				(v) => Math.round((v / k) * 10) / 10,
			);
		};
		const label = [...document.querySelectorAll('.cardLabel')].find(
			(l) => l.style.opacity === '1',
		);
		const k = label.getBoundingClientRect().width / innerWidth;
		return {
			live: relative(
				document.getElementById('chromeStatus'),
				document.getElementById('omni'),
			),
			card: relative(
				label.querySelector('.status'),
				label.querySelector('.urlBox'),
				k,
			),
		};
	});
	ok(
		`${mode}: the active card's status chip has the live chip's box, scaled`,
		chips.live.every((v, i) => Math.abs(v - chips.card[i]) <= 0.5),
		JSON.stringify(chips),
	);
	await page.click('.cardLabel:nth-of-type(2) .starbtn');
	ok(
		`${mode}: B's card star bookmarks B and leaves the manager open`,
		JSON.stringify(await cardStars(page)) === '["true","true"]' &&
			(await page.evaluate(() => document.body.classList.contains('recents'))),
		JSON.stringify(await cardStars(page)),
	);
	list = await stored(page);
	ok(
		`${mode}: newest first, one entry per page`,
		urlsOf(list) === JSON.stringify([B, A, ...DEFAULT_URLS]),
		urlsOf(list),
	);
	// B again from the live bar: no second entry for it
	await page.click('.cardLabel:nth-of-type(2) .hit'); // the centred card, B
	await omniIs(page, B);
	ok(
		`${mode}: B's live star shows the card's choice`,
		(await until(
			page,
			() => document.getElementById('toolStar').getAttribute('aria-pressed'),
			(v) => v === 'true',
		)) === 'true',
	);
	// B declares no icon: the site's /favicon.ico is asked, through the
	// proxy (the request viewer lists the tab's proxied requests), and it is
	// a page, not a picture, so B has none and shows the globe
	const favicon = `${FIXTURE}favicon.ico`;
	await page.keyboard.press('Control+Shift+KeyX');
	ok(
		`${mode}: B's /favicon.ico is asked through the proxy`,
		(await until(
			page,
			(url) =>
				[...document.querySelectorAll('#requestsList .url')].some(
					(cell) => cell.title === url,
				),
			Boolean,
			15000,
			favicon,
		)) === true,
	);
	await page.keyboard.press('Escape');
	await sleep(1000);
	ok(
		`${mode}: B, with no picture to be had, keeps no icon`,
		(await stored(page))[0].icon === null,
		JSON.stringify((await stored(page))[0]),
	);

	// another window of the demo follows (the storage event)
	const other = await context.newPage();
	await other.goto(base);
	await other.waitForFunction(
		() => document.getElementById('logMsg').textContent === 'Ready',
		null,
		{ timeout: 45000 },
	);
	await other.click('#bookmarksTab');
	ok(
		`${mode}: another window lists both`,
		(await until(
			other,
			() => document.querySelectorAll('#bookmarksList .bookmark').length,
			(n) => n === 6,
			5000,
		)) === 6,
	);

	// the sidebar: rows, remove, and the stars follow
	await page.click('#home');
	await sleep(400);
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		(n) => n === 6,
		5000,
	);
	const shown = await rows(page);
	ok(
		`${mode}: the sidebar lists both with title, real URL and icon (B's the globe), the defaults with theirs`,
		JSON.stringify(shown) ===
			JSON.stringify([
				{ title: 'Bookmark B', url: B, icon: '/pm/icons/globe.png' },
				{ title: 'Bookmark A', url: A, icon: 'data:image/png;base64,' },
				...DEFAULTS,
			]),
		JSON.stringify(shown),
	);
	await page.click('#bookmarksList .bookmark:first-child .bookmarkRemove');
	ok(
		`${mode}: removing B from the sidebar drops its row and its entry`,
		urlsOf(await rows(page)) === JSON.stringify([A, ...DEFAULT_URLS]) &&
			urlsOf(await stored(page)) === JSON.stringify([A, ...DEFAULT_URLS]),
		JSON.stringify(await rows(page)),
	);
	ok(
		`${mode}: the other window drops it too`,
		(await until(
			other,
			() => document.querySelectorAll('#bookmarksList .bookmark').length,
			(n) => n === 5,
			5000,
		)) === 5,
	);
	await other.close();
	await page.keyboard.press('Escape');
	await sleep(300);
	await page.click('#recents');
	await sleep(600);
	ok(
		`${mode}: B's card star went off with the sidebar's remove`,
		JSON.stringify(await cardStars(page)) === '["true","false"]',
		JSON.stringify(await cardStars(page)),
	);
	await page.click('#home');
	await sleep(400);

	// opening a bookmark: a click in the current tab, the middle button in a new one
	const frames = () =>
		page.evaluate(() => document.querySelectorAll('.frames .frame').length);
	const before = await frames();
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		Boolean,
		5000,
	);
	await page.click('#bookmarksList .bookmarkOpen', { button: 'middle' });
	ok(
		`${mode}: the middle button opens A in a new tab`,
		(await omniIs(page, A)) === A &&
			(await frames()) === before + 1 &&
			!(await sidebarOpen(page)),
		JSON.stringify({ before, after: await frames() }),
	);
	await page.click('#home');
	await sleep(400);
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		Boolean,
		5000,
	);
	await page.click('#bookmarksList .bookmarkOpen');
	ok(
		`${mode}: a click opens A in the current tab`,
		(await omniIs(page, A)) === A && (await frames()) === before + 1,
		JSON.stringify({ before, after: await frames() }),
	);
	await loaded(page);

	// the address box: the status chip right of the text, left of the star
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 800 });
		await sleep(400);
		const bar = await page.evaluate(() => {
			const box = (element) => element.getBoundingClientRect();
			const input = document.querySelector('#omni input');
			const field = box(input);
			const style = getComputedStyle(input);
			return {
				field: [field.left, field.top, field.right, field.bottom],
				textRight: field.right - parseFloat(style.paddingRight),
				chip: box(document.getElementById('chromeStatus')),
				star: box(document.getElementById('toolStar')),
				inForm: !!document.querySelector('#omni #chromeStatus'),
			};
		});
		const middle = (r) => (r.top + r.bottom) / 2;
		const fieldMiddle = (bar.field[1] + bar.field[3]) / 2;
		ok(
			`${mode} ${width}px: the status chip sits in the address box, left of the star, both centred, clear of the text`,
			bar.inForm &&
				bar.chip.right <= bar.star.left &&
				bar.chip.left >= bar.textRight &&
				bar.star.right <= bar.field[2] &&
				Math.abs(middle(bar.chip) - fieldMiddle) <= 1 &&
				Math.abs(middle(bar.star) - fieldMiddle) <= 1,
			JSON.stringify(bar),
		);
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	await sleep(300);

	// Saved pages, beside Reload: the sidebar over the page
	const saved = (open) =>
		until(
			page,
			() => document.getElementById('bookmarks').classList.contains('open'),
			(v) => v === open,
			3000,
		);
	ok(
		`${mode}: Saved pages sits right after Reload`,
		await page.evaluate(
			() =>
				document.getElementById('toolReload').nextElementSibling ===
					document.getElementById('toolSaved') &&
				document.getElementById('toolSaved').getAttribute('aria-label') ===
					'Saved pages' &&
				document.getElementById('toolSaved').title === 'Saved pages',
		),
	);
	await page.click('#toolSaved');
	ok(
		`${mode}: Saved pages opens the sidebar over the page, the keyboard in it`,
		(await saved(true)) === true &&
			(await page.getAttribute('#toolSaved', 'aria-expanded')) === 'true' &&
			(await page.evaluate(() =>
				document.getElementById('bookmarks').contains(document.activeElement),
			)),
	);
	await page.keyboard.press('Escape');
	ok(
		`${mode}: Escape closes it and gives Saved pages the focus back`,
		(await saved(false)) === false &&
			(await page.evaluate(() => document.activeElement?.id)) === 'toolSaved' &&
			(await page.getAttribute('#toolSaved', 'aria-expanded')) === 'false',
	);
	await page.click('#toolSaved');
	await saved(true);
	await sleep(300); // slid in
	const under = await page.evaluate(
		() => document.elementFromPoint(1200, 400)?.id,
	);
	await page.mouse.click(1200, 400); // the scrim, beside the sidebar
	ok(
		`${mode}: the scrim closes it`,
		under === 'bookmarksScrim' && (await saved(false)) === false,
		under,
	);
	await submitOmni(page, B);
	await omniIs(page, B);
	await loaded(page);
	await page.click('#toolSaved');
	await saved(true);
	await page.click('#bookmarksList .bookmarkOpen');
	ok(
		`${mode}: a bookmark from Saved pages opens in the current tab`,
		(await omniIs(page, A)) === A &&
			(await frames()) === before + 1 &&
			(await saved(false)) === false,
		JSON.stringify({ before, after: await frames() }),
	);
	await loaded(page);
	await page.click('#toolSaved');
	await saved(true);
	await page.click('#bookmarksList .bookmarkOpen', { button: 'middle' });
	ok(
		`${mode}: and the middle button opens it in a new tab`,
		(await omniIs(page, A)) === A && (await frames()) === before + 2,
		JSON.stringify({ before, after: await frames() }),
	);
	await loaded(page);

	// kept across a reload (the fragment brings A back in a tab)
	await page.reload();
	await page.waitForFunction(
		() => document.getElementById('logMsg').textContent !== 'Starting…',
		null,
		{ timeout: 45000 },
	);
	await omniIs(page, A);
	await loaded(page);
	ok(
		`${mode}: after a reload A's star is still on`,
		(await until(
			page,
			() => document.getElementById('toolStar').getAttribute('aria-pressed'),
			(v) => v === 'true',
		)) === 'true',
	);
	// off from the address bar, by the keyboard
	await page.focus('#toolStar');
	await page.keyboard.press('Space');
	ok(
		`${mode}: Space on the star takes A off`,
		(await liveStar(page)) === 'false' &&
			urlsOf(await stored(page)) === JSON.stringify(DEFAULT_URLS),
		urlsOf(await stored(page)),
	);

	// a default removed stays removed: the list is seeded once
	await page.click('#home');
	await sleep(400);
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		(n) => n === 4,
		5000,
	);
	await page.click('#bookmarksList .bookmark:last-child .bookmarkRemove');
	const reopen = async () => {
		await page.reload();
		await page.waitForFunction(
			() => document.getElementById('logMsg').textContent === 'Ready',
			null,
			{ timeout: 45000 },
		);
		if (
			!(await page.evaluate(() => document.body.classList.contains('browsing')))
		)
			return;
		await page.click('#home');
		await sleep(400);
	};
	await reopen();
	await page.click('#bookmarksTab');
	ok(
		`${mode}: Krunk, removed, does not come back on a reload`,
		urlsOf(await rows(page)) === JSON.stringify(DEFAULT_URLS.slice(0, 3)) &&
			urlsOf(await stored(page)) === JSON.stringify(DEFAULT_URLS.slice(0, 3)),
		urlsOf(await rows(page)),
	);
	for (let i = 0; i < 3; i++) {
		await page.click('#bookmarksList .bookmark:first-child .bookmarkRemove');
		await sleep(100);
	}
	ok(
		`${mode}: with every bookmark removed the sidebar says so`,
		await page.evaluate(
			() =>
				!document
					.getElementById('bookmarksEmpty')
					.classList.contains('hidden') &&
				document.getElementById('bookmarksCount').textContent === '0' &&
				!document.querySelector('#bookmarksList .bookmark') &&
				document.activeElement?.id === 'bookmarksClose',
		),
	);
	await reopen();
	await page.click('#bookmarksTab');
	ok(
		`${mode}: and stays empty across a reload`,
		(await until(
			page,
			() =>
				!document.getElementById('bookmarksEmpty').classList.contains('hidden'),
			Boolean,
			3000,
		)) === true && (await stored(page)).length === 0,
		JSON.stringify(await stored(page)),
	);

	// YouTube has its curated icon, white on its red, whatever picture its
	// bookmark kept (here one from the page, as a data: URL)
	await page.evaluate(
		([key, icon]) =>
			localStorage.setItem(
				key,
				JSON.stringify([
					{ url: 'https://www.youtube.com/', title: 'YouTube', icon },
				]),
			),
		[
			KEY,
			'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
		],
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		(n) => n === 1,
		5000,
	);
	const youtube = await page.evaluate(() => {
		const tile = document.querySelector('#bookmarksList .bookmarkTile');
		return [
			getComputedStyle(tile).backgroundColor,
			tile.querySelector('img').getAttribute('src'),
		];
	});
	ok(
		`${mode}: YouTube shows its white logo on a red tile, over the picture it kept`,
		JSON.stringify(youtube) ===
			JSON.stringify(['rgb(255, 0, 0)', '/pm/icons/youtube.svg']),
		JSON.stringify(youtube),
	);

	// dragging reorders: a mouse after a few pixels, the keyboard with Alt
	const four = [
		A,
		B,
		`${FIXTURE}pages/hist-1.html`,
		`${FIXTURE}pages/hist-2.html`,
	];
	await page.evaluate(
		([key, urls]) =>
			localStorage.setItem(
				key,
				JSON.stringify(
					urls.map((url, i) => ({ url, title: `P${i}`, icon: null })),
				),
			),
		[KEY, four],
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		(n) => n === 4,
		5000,
	);
	await dragRow(page, 0, 2);
	ok(
		`${mode}: a mouse drag moves the first bookmark to third`,
		urlsOf(await stored(page)) ===
			JSON.stringify([four[1], four[2], four[0], four[3]]) &&
			urlsOf(await rows(page)) ===
				JSON.stringify([four[1], four[2], four[0], four[3]]) &&
			(await sidebarOpen(page)) &&
			(await page.evaluate(
				() => document.querySelectorAll('.frames .frame').length,
			)) === 0,
		urlsOf(await stored(page)),
	);
	await page.focus('#bookmarksList .bookmark:nth-child(3) .bookmarkOpen');
	await page.keyboard.press('Alt+ArrowUp');
	await page.keyboard.press('Alt+ArrowUp');
	await page.keyboard.press('Alt+ArrowDown');
	ok(
		`${mode}: Alt+Up and Alt+Down move the focused bookmark, which keeps the focus`,
		urlsOf(await stored(page)) ===
			JSON.stringify([four[1], four[0], four[2], four[3]]) &&
			(await page.evaluate(() => document.activeElement?.title)) === four[0],
		urlsOf(await stored(page)),
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	ok(
		`${mode}: the new order outlives a reload`,
		urlsOf(await rows(page)) ===
			JSON.stringify([four[1], four[0], four[2], four[3]]),
		urlsOf(await rows(page)),
	);

	// an icon however the page goes: a host of another origin without CORS,
	await page.keyboard.press('Escape');
	await sleep(300);
	const iconOf = (url) =>
		until(
			page,
			(u) =>
				JSON.parse(localStorage.getItem('stomp-demo:bookmarks') || '[]').find(
					(entry) => entry.url === u,
				)?.icon,
			Boolean,
			20000,
			url,
		);
	await submitLanding(page, CROSS);
	await omniIs(page, CROSS);
	await loaded(page);
	await page.click('#toolStar');
	ok(
		`${mode}: an icon on another origin that sends no CORS headers is kept`,
		/^data:image\/png;base64,/.test((await iconOf(CROSS)) || ''),
	);
	// a bookmark kept without an icon fills itself in once its page is open,
	// though the page has moved on to another URL (a soft navigation)
	await page.evaluate(
		([key, url]) => {
			const list = JSON.parse(localStorage.getItem(key));
			list.unshift({ url, title: 'Soft', icon: null });
			localStorage.setItem(key, JSON.stringify(list));
		},
		[KEY, SOFT],
	);
	await page.click('#home');
	await sleep(400);
	await reopen();
	await submitLanding(page, SOFT);
	await omniIs(page, `${SOFT}?zx=1`);
	ok(
		`${mode}: a kept bookmark with no icon gets its page's, after the page soft-navigated`,
		/^data:image\/png;base64,/.test((await iconOf(SOFT)) || ''),
		await omni(page),
	);
	// starred while its document is still on the way, with no other tab
	// open (no page at all to ask yet): the site's /favicon.ico is asked, by
	// that page, once it has come
	await page.click('#recents');
	await sleep(400);
	await page.click('#closeAll');
	await sleep(600);
	await submitLanding(page, SLOW);
	await until(
		page,
		() => !document.getElementById('toolStar').disabled,
		Boolean,
		5000,
	);
	await page.click('#toolStar');
	const early = (await stored(page)).find((entry) => entry.url === SLOW);
	await page.keyboard.press('Control+Shift+KeyX');
	ok(
		`${mode}: a bookmark made before its page has come asks for the icon once it has`,
		!!early &&
			early.icon === null &&
			(await until(
				page,
				(url) =>
					[...document.querySelectorAll('#requestsList .url')].some(
						(cell) => cell.title === url,
					),
				Boolean,
				20000,
				new URL('/favicon.ico', SLOW).href,
			)) === true,
		JSON.stringify(early),
	);
	await page.keyboard.press('Escape');
	await context.close();

	// a finger drags after a long press; a quick swipe scrolls instead
	const touch = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
	});
	const phone = await touch.newPage();
	phone.on('pageerror', (error) =>
		errors.push(`${mode} touch: ${error.message}`),
	);
	await phone.goto(base);
	await phone.waitForFunction(
		() => document.getElementById('logMsg').textContent === 'Ready',
		null,
		{ timeout: 45000 },
	);
	await phone.tap('#bookmarksTab');
	await until(
		phone,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		(n) => n === 4,
		5000,
	);
	const cdp = await touch.newCDPSession(phone);
	await touchDrag(phone, cdp, 0, 2, 0);
	ok(
		`${mode}: a quick swipe over a row does not move it`,
		urlsOf(await stored(phone)) === JSON.stringify(DEFAULT_URLS),
		urlsOf(await stored(phone)),
	);
	await touchDrag(phone, cdp, 0, 2, 600);
	ok(
		`${mode}: a finger held on a row drags it`,
		urlsOf(await stored(phone)) ===
			JSON.stringify([
				DEFAULT_URLS[1],
				DEFAULT_URLS[2],
				DEFAULT_URLS[0],
				DEFAULT_URLS[3],
			]) &&
			(await phone.evaluate(
				() => document.querySelectorAll('.frames .frame').length,
			)) === 0,
		urlsOf(await stored(phone)),
	);
	await touch.close();
}

/** the middle of row `i` of the sidebar's list */
const rowMiddle = (page, i) =>
	page.evaluate((index) => {
		const r = document
			.querySelectorAll('#bookmarksList .bookmark')
			[index].querySelector('.bookmarkText')
			.getBoundingClientRect();
		return [r.left + r.width / 2, r.top + r.height / 2];
	}, i);

/** drag row `from` with the mouse to just past the middle of row `to` */
async function dragRow(page, from, to) {
	await sleep(400); // the sidebar has slid in
	const [x, y] = await rowMiddle(page, from);
	const [, y2] = await rowMiddle(page, to);
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y + 3, { steps: 2 });
	await page.mouse.move(x, y2 + 10, { steps: 12 });
	await sleep(250);
	await page.mouse.up();
	await sleep(300);
}

/** the same with a finger, holding it `hold` ms before it moves */
async function touchDrag(page, cdp, from, to, hold) {
	await sleep(400); // the sidebar has slid in
	const [x, y] = await rowMiddle(page, from);
	const [, y2] = await rowMiddle(page, to);
	const touch = (type, at) =>
		cdp.send('Input.dispatchTouchEvent', {
			type,
			touchPoints: at ? [{ x, y: at }] : [],
		});
	await touch('touchStart', y);
	await sleep(hold);
	for (let i = 1; i <= 12; i++) {
		await touch('touchMove', y + ((y2 + 10 - y) * i) / 12);
		await sleep(16);
	}
	await sleep(250);
	await touch('touchEnd');
	await sleep(400);
}

await Promise.all([run('same-origin', PROXY), run('isolated', HOST)]);
await done(browser, errors);
