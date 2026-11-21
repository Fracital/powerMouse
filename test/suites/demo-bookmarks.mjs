// The demo's bookmarks: the ten it starts with (the maker's four, the
// quick links, the Chrome Web Store and N SVG), each once (a removed one
// stays removed, a list seeded with the first four before the quick links
// joined gets those once, and one seeded before N SVG joined gets it once,
// at the end); the page's description where it gives one,
// under the title; the home page's star tab in its own band between the
// status line and the commits, hanging off the card's left edge; the
// sidebar it opens (empty state, rows, open, remove, Escape); the address
// bar's star and every tab card's, in step with each other, the sidebar and
// another window of the demo; the real URL stored, never the route, with
// the title and the page's icon; the list kept across a reload; and no
// links beside the title but Download (offline.html) and GitHub's, the
// bookmarks having taken the others over; Estro's default, now estrogen,
// renamed in a profile seeded before; the home page's commit times kept
// current as time passes; and its commits live from a fake GitHub (a demo
// server of its own polls it, one request per interval whatever the number
// of pages, backing off on a refusal, and pushes a new commit to every open
// page with no reload). Both controller modes at once, each in a context of
// its own.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	{
		title: 'estrogen',
		url: 'https://estro.help/',
		icon: '/pm/icons/estrogen.png',
		description:
			'Estrogen transforms your JavaScript to be more fun for internet crawlers. Running @sysce/estrogen in WASM.',
	},
	{
		title: 'Krunk',
		url: 'https://krunk.io/',
		icon: '/pm/icons/krunker.png',
		description:
			'Play Krunker Box Office: the Krunker FPS rebuilt as a native engine. Free fast-paced multiplayer in your browser or as a desktop client. No download required.',
	},
	// the quick links, at the URLs their tiles open
	{
		title: 'Reddit',
		url: 'https://www.reddit.com/',
		icon: '/pm/icons/reddit.png',
	},
	{
		title: 'Google',
		url: 'https://www.google.com/',
		icon: '/pm/icons/google.png',
	},
	{
		title: 'YouTube',
		url: 'https://www.youtube.com/',
		icon: '/pm/icons/youtube.svg',
		description:
			'Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.',
	},
	{
		title: 'Discord',
		url: 'https://discord.com/login',
		icon: '/pm/icons/discord.png',
		description:
			'Discord is great for playing games and chilling with friends, or even building a worldwide community. Customize your own space to talk, play, and hang out.',
	},
	{
		title: 'Chrome Web Store',
		url: 'https://chromewebstore.google.com/',
		icon: '/pm/icons/chromewebstore.png',
		description:
			'Add new features to your browser and personalize your browsing experience.',
	},
	// vibeOS's Nsvg, with the Tango svg icon vibeOS gives it; its page
	// declares no description
	{
		title: 'N SVG',
		url: 'https://cojmar.github.io/nsvg/',
		icon: '/pm/icons/nsvg.png',
	},
];
const N = DEFAULTS.length;
const ESTRO = 'https://estro.help/';
// Estro's default as a profile seeded before it became estrogen keeps it
const OLD_ESTRO = {
	url: ESTRO,
	title: 'Estro',
	description: 'Estro: three coding models, one key.',
	icon: '/pm/icons/estro.svg',
	color: '#9a5ae7',
};
const NSVG = 'https://cojmar.github.io/nsvg/';
// the defaults a list seeded before the quick links joined has
const FIRST_FOUR = DEFAULTS.slice(0, 4);
const SEEDED_KEY = 'stomp-demo:bookmarks-seeded';
const A_DESCRIPTION = 'The first page to bookmark.';
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
			// the page's description, where the bookmark has one
			...(row.querySelector('.bookmarkDescription') && {
				description: row.querySelector('.bookmarkDescription').textContent,
			}),
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
		`${mode}: no links beside the title but Download and GitHub's`,
		JSON.stringify(
			await page.$$eval('.head a', (links) => links.map((a) => a.href)),
		) ===
			JSON.stringify([
				`${new URL(base).origin}/`,
				`${new URL(base).origin}/offline.html`,
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
		`${mode}: the first visit starts with Fracital, vibeOS, estrogen, Krunk and the quick links Reddit, Google, YouTube and Discord, then the Chrome Web Store and N SVG, each with its bundled icon and the description its page gave`,
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
			(await page.textContent('#bookmarksCount')) === String(N) &&
			urlsOf(await stored(page)) === JSON.stringify(DEFAULT_URLS),
		JSON.stringify(await rows(page)),
	);
	// Krunker's icon is a whole tile and covers its; vibeOS's 32 px Tango
	// computer, estrogen's 64 px syringe and N SVG's 32 px Tango svg page show
	// at 22 px, as every other icon does, estrogen's on black and N SVG's on
	// Tango's dark green
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
					background: getComputedStyle(tile).backgroundColor,
				};
			},
		),
	);
	ok(
		`${mode}: Krunk's icon fills its 34 px tile, vibeOS's 32 px one shows at 22 px`,
		JSON.stringify(tiles.map((t) => t.tile)) ===
			JSON.stringify(DEFAULTS.map(() => [34, 34])) &&
			JSON.stringify(tiles[3].image) === '[0,0,34,34]' &&
			JSON.stringify(tiles[1].image.slice(2)) === '[22,22]' &&
			JSON.stringify(tiles[1].natural) === '[32,32]',
		JSON.stringify(tiles),
	);
	ok(
		`${mode}: estrogen's 64 px icon, estro.help's own, shows at 22 px in the middle of a black tile`,
		JSON.stringify(tiles[2].image) === '[6,6,22,22]' &&
			JSON.stringify(tiles[2].natural) === '[64,64]' &&
			tiles[2].background === 'rgb(0, 0, 0)',
		JSON.stringify(tiles[2]),
	);
	ok(
		`${mode}: N SVG's 32 px icon, the one vibeOS gives Nsvg, shows at 22 px in the middle of a #4e9a06 tile`,
		JSON.stringify(tiles[N - 1].image) === '[6,6,22,22]' &&
			JSON.stringify(tiles[N - 1].natural) === '[32,32]' &&
			tiles[N - 1].background === 'rgb(78, 154, 6)',
		JSON.stringify(tiles[N - 1]),
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
	// the description A's page gives, on one line, asked of the page when
	// the star was pressed
	ok(
		`${mode}: A keeps the description its page gives, on one line`,
		(await until(
			page,
			(a) =>
				JSON.parse(localStorage.getItem('stomp-demo:bookmarks') || '[]').find(
					(entry) => entry.url === a,
				)?.description,
			Boolean,
			15000,
			A,
		)) === A_DESCRIPTION,
		JSON.stringify((await stored(page))[0]),
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
			(n) => n === N + 2,
			5000,
		)) ===
			N + 2,
	);

	// the sidebar: rows, remove, and the stars follow
	await page.click('#home');
	await sleep(400);
	await page.click('#bookmarksTab');
	await until(
		page,
		() => document.querySelectorAll('#bookmarksList .bookmark').length,
		(n) => n === N + 2,
		5000,
	);
	const shown = await rows(page);
	ok(
		`${mode}: the sidebar lists both with title, real URL and icon (B's the globe) and A's description (B gives none), the defaults with theirs`,
		JSON.stringify(shown) ===
			JSON.stringify([
				{ title: 'Bookmark B', url: B, icon: '/pm/icons/globe.png' },
				{
					title: 'Bookmark A',
					url: A,
					icon: 'data:image/png;base64,',
					description: A_DESCRIPTION,
				},
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
			(n) => n === N + 1,
			5000,
		)) ===
			N + 1,
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
		(n) => n === N,
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
		`${mode}: N SVG, removed, does not come back on a reload`,
		urlsOf(await rows(page)) === JSON.stringify(DEFAULT_URLS.slice(0, -1)) &&
			urlsOf(await stored(page)) === JSON.stringify(DEFAULT_URLS.slice(0, -1)),
		urlsOf(await rows(page)),
	);
	for (let i = 0; i < N - 1; i++) {
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

	// a list seeded before the quick links joined the defaults (its marker
	// '1'), the user's own bookmark first and Krunk removed: the quick links
	// come once, after the list, and Krunk stays away
	await page.evaluate(
		([key, seededKey, list]) => {
			localStorage.setItem(key, JSON.stringify(list));
			localStorage.setItem(seededKey, '1');
		},
		[
			KEY,
			SEEDED_KEY,
			[
				{ url: A, title: 'Bookmark A', icon: null },
				...FIRST_FOUR.slice(0, 3).map(({ title, url, icon }) => ({
					title,
					url,
					icon,
				})),
			],
		],
	);
	await page.keyboard.press('Escape');
	await reopen();
	const migrated = [A, ...DEFAULT_URLS.slice(0, 3), ...DEFAULT_URLS.slice(4)];
	await page.click('#bookmarksTab');
	ok(
		`${mode}: a list seeded with the first four gets the quick links, the Web Store and N SVG once, after it, and a removed default stays away`,
		urlsOf(
			await until(
				page,
				() =>
					[...document.querySelectorAll('#bookmarksList .bookmark')].map(
						(row) => ({ url: row.dataset.url }),
					),
				(v) => v?.length > 1,
				5000,
			),
		) === JSON.stringify(migrated) &&
			urlsOf(await stored(page)) === JSON.stringify(migrated) &&
			JSON.stringify(
				await page.evaluate(
					(seededKey) => JSON.parse(localStorage.getItem(seededKey)),
					SEEDED_KEY,
				),
			) === JSON.stringify(DEFAULT_URLS),
		urlsOf(await stored(page)),
	);
	ok(
		`${mode}: the defaults seeded before descriptions get theirs, shown under the title in a muted line`,
		JSON.stringify(
			(await rows(page))
				.filter((row) => row.description)
				.map((row) => [row.url, row.description]),
		) ===
			JSON.stringify(
				DEFAULTS.filter((entry) => entry.description)
					.filter((entry) => migrated.includes(entry.url))
					.map((entry) => [entry.url, entry.description]),
			) &&
			(await page.evaluate(() => {
				const row = document.querySelector(
					'#bookmarksList .bookmark:nth-child(4)',
				); // estrogen
				const title = row
					.querySelector('.bookmarkTitle')
					.getBoundingClientRect();
				const line = row.querySelector('.bookmarkDescription');
				const box = line.getBoundingClientRect();
				const url = row.querySelector('.bookmarkUrl').getBoundingClientRect();
				return (
					box.top >= title.bottom &&
					url.top >= box.bottom &&
					line.title === line.textContent &&
					getComputedStyle(line).color === 'rgb(154, 154, 154)' &&
					getComputedStyle(line).whiteSpace === 'nowrap'
				);
			})),
		JSON.stringify(await rows(page)),
	);
	// a quick link removed stays removed too
	await page.click(
		'#bookmarksList .bookmark[data-url="https://www.reddit.com/"] .bookmarkRemove',
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	const withoutReddit = migrated.filter(
		(url) => url !== 'https://www.reddit.com/',
	);
	ok(
		`${mode}: Reddit, removed, does not come back on a reload`,
		urlsOf(
			await until(
				page,
				() =>
					[...document.querySelectorAll('#bookmarksList .bookmark')].map(
						(row) => ({ url: row.dataset.url }),
					),
				(v) => v?.length > 1,
				5000,
			),
		) === JSON.stringify(withoutReddit) &&
			urlsOf(await stored(page)) === JSON.stringify(withoutReddit),
		urlsOf(await stored(page)),
	);

	// a profile seeded before N SVG joined (its marker every default but
	// N SVG), the user's own bookmark first and Reddit removed: N SVG comes
	// once, at the end, with its icon and colour, and stays away once removed
	const seededBefore = DEFAULTS.filter(
		(entry) => entry.url !== NSVG && entry.url !== 'https://www.reddit.com/',
	);
	await page.evaluate(
		([key, seededKey, list, marker]) => {
			localStorage.setItem(key, JSON.stringify(list));
			localStorage.setItem(seededKey, JSON.stringify(marker));
		},
		[
			KEY,
			SEEDED_KEY,
			[{ url: A, title: 'Bookmark A', icon: null }, ...seededBefore],
			DEFAULT_URLS.filter((url) => url !== NSVG),
		],
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	const withNsvg = [A, ...seededBefore.map((entry) => entry.url), NSVG];
	ok(
		`${mode}: a profile seeded before N SVG joined gets it once, at the end, with its icon and tile colour`,
		urlsOf(
			await until(
				page,
				() =>
					[...document.querySelectorAll('#bookmarksList .bookmark')].map(
						(row) => ({ url: row.dataset.url }),
					),
				(v) => v?.length > 1,
				5000,
			),
		) === JSON.stringify(withNsvg) &&
			urlsOf(await stored(page)) === JSON.stringify(withNsvg) &&
			JSON.stringify((await rows(page)).at(-1)) ===
				JSON.stringify(DEFAULTS.at(-1)) &&
			(await page.evaluate(
				() =>
					getComputedStyle(
						document.querySelector(
							'#bookmarksList .bookmark:last-child .bookmarkTile',
						),
					).backgroundColor,
			)) === 'rgb(78, 154, 6)' &&
			JSON.stringify(
				await page.evaluate(
					(seededKey) => JSON.parse(localStorage.getItem(seededKey)),
					SEEDED_KEY,
				),
			) === JSON.stringify(DEFAULT_URLS),
		urlsOf(await stored(page)),
	);
	await page.click(
		`#bookmarksList .bookmark[data-url="${NSVG}"] .bookmarkRemove`,
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	await sleep(500);
	ok(
		`${mode}: N SVG, removed from that profile, does not come back on a reload`,
		urlsOf(
			await until(
				page,
				() =>
					[...document.querySelectorAll('#bookmarksList .bookmark')].map(
						(row) => ({ url: row.dataset.url }),
					),
				(v) => v?.length > 1,
				5000,
			),
		) === JSON.stringify(withNsvg.slice(0, -1)) &&
			urlsOf(await stored(page)) === JSON.stringify(withNsvg.slice(0, -1)),
		urlsOf(await stored(page)),
	);

	// a profile seeded while Estro was a default: its untouched entry takes
	// estrogen's title, description, icon and colour, where it stood
	await page.evaluate(
		([key, list]) => localStorage.setItem(key, JSON.stringify(list)),
		[KEY, [{ url: A, title: 'Bookmark A', icon: null }, OLD_ESTRO]],
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	const estrogen = DEFAULTS.find((entry) => entry.url === ESTRO);
	const renamed = await until(
		page,
		() =>
			[...document.querySelectorAll('#bookmarksList .bookmark')].map((row) => ({
				title: row.querySelector('.bookmarkTitle').textContent,
				url: row.querySelector('.bookmarkUrl').textContent,
				icon: row.querySelector('img.bookmarkIcon').getAttribute('src'),
				description: row.querySelector('.bookmarkDescription')?.textContent,
				background: getComputedStyle(row.querySelector('.bookmarkTile'))
					.backgroundColor,
			})),
		(v) => v?.length > 1,
		5000,
	);
	ok(
		`${mode}: a profile's untouched Estro bookmark becomes estrogen, with its description, icon and black tile, in its place`,
		urlsOf(renamed) === JSON.stringify([A, ESTRO]) &&
			JSON.stringify(renamed[1]) ===
				JSON.stringify({
					title: estrogen.title,
					url: ESTRO,
					icon: estrogen.icon,
					description: estrogen.description,
					background: 'rgb(0, 0, 0)',
				}),
		JSON.stringify(renamed),
	);
	// a bookmark the user made of the page keeps the page's title and icon
	// (only fields still at Estro's old values change)
	const ownIcon = 'data:image/png;base64,iVBORw0KGgo=';
	await page.evaluate(
		([key, list]) => localStorage.setItem(key, JSON.stringify(list)),
		[
			KEY,
			[
				{
					url: ESTRO,
					title: 'estrogen obfuscator',
					icon: ownIcon,
					color: OLD_ESTRO.color,
				},
			],
		],
	);
	await page.keyboard.press('Escape');
	await reopen();
	await page.click('#bookmarksTab');
	const own = await until(
		page,
		() =>
			[...document.querySelectorAll('#bookmarksList .bookmark')].map((row) => ({
				title: row.querySelector('.bookmarkTitle').textContent,
				icon: row.querySelector('img.bookmarkIcon').getAttribute('src'),
				background: getComputedStyle(row.querySelector('.bookmarkTile'))
					.backgroundColor,
			})),
		(v) => v?.length === 1,
		5000,
	);
	ok(
		`${mode}: a bookmark of estro.help the user made keeps its own title and icon, and only an old field (Estro's tile colour) takes the new value`,
		JSON.stringify(own) ===
			JSON.stringify([
				{
					title: 'estrogen obfuscator',
					icon: ownIcon,
					background: 'rgb(0, 0, 0)',
				},
			]),
		JSON.stringify(own),
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
		(n) => n === N,
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
				...DEFAULT_URLS.slice(3),
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

// The home page's commit times stay current with no reload. A stand-in
// clock in the demo's own window (not Playwright's: its clock runs every
// frame's timers, and the controller's frame never lets a run end) moves
// the time, so nothing waits for real minutes: __setClock jumps to a time
// and __advanceClock moves it on, each firing the timers then due. Two
// commits, at 59 min 50 s and 30 s before the time set: the first says
// "1 hour ago" when the hour comes, the second "1 minute ago" when its
// minute does; a hidden page changes nothing, and showing it brings the
// labels up to date at once.
async function commitTimes(base) {
	await waitForServer(base);
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	await context.addInitScript(() => {
		if (window.top !== window) return;
		const RealDate = Date;
		const realSet = setTimeout;
		const realClear = clearTimeout;
		let offset = 0;
		const now = () => RealDate.now() + offset;
		window.Date = class extends RealDate {
			constructor(...args) {
				if (args.length) super(...args);
				else super(now());
			}
			static now() {
				return now();
			}
		};
		const pending = new Map();
		window.setTimeout = (fn, delay, ...args) => {
			const id = realSet(() => {
				pending.delete(id);
				if (typeof fn === 'function') fn(...args);
			}, delay);
			pending.set(id, { due: now() + (Number(delay) || 0), fn, args });
			return id;
		};
		window.clearTimeout = (id) => {
			pending.delete(id);
			realClear(id);
		};
		const fireDue = () => {
			for (;;) {
				const due = [...pending]
					.filter(([, timer]) => timer.due <= now())
					.sort((a, b) => a[1].due - b[1].due)[0];
				if (!due) return;
				const [id, timer] = due;
				pending.delete(id);
				realClear(id);
				if (typeof timer.fn === 'function') timer.fn(...timer.args);
			}
		};
		window.__setClock = (time) => {
			offset = time - RealDate.now();
			fireDue();
		};
		window.__advanceClock = (ms) => {
			offset += ms;
			fireDue();
		};
	});
	const page = await context.newPage();
	page.on('pageerror', (error) =>
		errors.push(`commit times: ${error.message}`),
	);
	const time = Date.parse('2026-11-20T12:00:00Z');
	const at = (ms) => new Date(time - ms).toISOString();
	const dates = [at(59 * 60000 + 50000), at(30000)];
	const REPO = 'https://example.com/repo';
	await page.route('**/api/commits', (route) =>
		route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				repo: 'example/repo',
				url: REPO,
				commits: dates.map((date, i) => ({
					sha: `000000${i}`,
					url: `${REPO}/commit/000000${i}`,
					message: `Commit ${i}`,
					author: 'Someone',
					avatar: null,
					date,
				})),
			}),
		}),
	);
	await page.goto(base);
	await page.waitForFunction(
		() => document.getElementById('logMsg').textContent === 'Ready',
		null,
		{ timeout: 45000 },
	);
	await page.waitForFunction(
		() => document.querySelectorAll('#commitList time').length === 2,
		null,
		{ timeout: 10000 },
	);
	const show = (hidden) =>
		page.evaluate((hidden) => {
			Object.defineProperty(document, 'hidden', {
				configurable: true,
				get: () => hidden,
			});
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => (hidden ? 'hidden' : 'visible'),
			});
			document.dispatchEvent(new Event('visibilitychange'));
		}, hidden);
	const times = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('#commitList time')].map((time) => ({
				text: time.textContent,
				datetime: time.getAttribute('datetime'),
				title: time.title,
			})),
		);
	const labels = async () => (await times()).map((time) => time.text);
	const advance = (ms) => page.evaluate((ms) => window.__advanceClock(ms), ms);
	// the clock set while the page is hidden, then shown: the labels are
	// brought up to that time at once
	await show(true);
	await page.evaluate((time) => window.__setClock(time), time);
	await show(false);
	const first = await times();
	ok(
		'commit times: each row has a <time datetime> of its ISO date, the absolute time as its tooltip, and the relative label, brought up to date when the page shows',
		JSON.stringify(first.map((time) => time.datetime)) ===
			JSON.stringify(dates) &&
			first.every((time) => time.title) &&
			JSON.stringify(first.map((time) => time.text)) ===
				JSON.stringify(['59 minutes ago', 'just now']),
		JSON.stringify(first),
	);
	await advance(9000);
	const before = await labels();
	await advance(1500);
	const hour = await labels();
	ok(
		'commit times: when the hour comes, the first row says 1 hour ago, and not before',
		JSON.stringify(before) === JSON.stringify(['59 minutes ago', 'just now']) &&
			JSON.stringify(hour) === JSON.stringify(['1 hour ago', 'just now']),
		JSON.stringify({ before, hour }),
	);
	await advance(20000);
	const minute = await labels();
	ok(
		'commit times: when its minute comes, the second row says 1 minute ago',
		JSON.stringify(minute) === JSON.stringify(['1 hour ago', '1 minute ago']),
		JSON.stringify(minute),
	);
	// hidden: no timer runs, the labels stay as they were
	await show(true);
	await advance(61000);
	const hidden = await labels();
	await show(false);
	const shown = await labels();
	ok(
		'commit times: a hidden page leaves them be, and showing it updates them at once',
		JSON.stringify(hidden) === JSON.stringify(minute) &&
			JSON.stringify(shown) === JSON.stringify(['1 hour ago', '2 minutes ago']),
		JSON.stringify({ hidden, shown }),
	);
	await context.close();
}

// The home page's commits live. A fake of GitHub's commits API, scripted
// by the checks: its list and ETag, a 304 for a request whose If-None-Match
// is the ETag, and a 403 with a reset when told. A demo server of the
// suite's own asks it (STOMP_GITHUB_API) every 1.5 s while watched
// (STOMP_GITHUB_POLL_MS), with a fresh TMPDIR so no kept answer of another
// run is read. The real API is never asked.
const POLL_MS = 1500;
const repoRoot = new URL('../../', import.meta.url).pathname;
const git = (...args) =>
	execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
function fakeGitHub() {
	const requests = [];
	const state = { list: [], etag: null, refuse: null };
	const server = createServer((req, res) => {
		const entry = {
			at: Date.now(),
			etag: req.headers['if-none-match'] ?? null,
			auth: req.headers.authorization ?? null,
			path: req.url,
			status: 0,
		};
		requests.push(entry);
		const answer = (status, headers, body) => {
			entry.status = status;
			res.writeHead(status, headers).end(body);
		};
		if (!req.url.startsWith('/repos/Fracital/powerMouse/commits?'))
			return answer(404, {}, '{}');
		if (state.refuse) {
			const reset = state.refuse;
			state.refuse = null;
			entry.reset = reset;
			return answer(
				403,
				{
					'content-type': 'application/json',
					'x-ratelimit-remaining': '0',
					'x-ratelimit-reset': String(reset),
				},
				'{"message":"API rate limit exceeded"}',
			);
		}
		if (entry.etag === state.etag)
			return answer(304, { etag: state.etag }, undefined);
		answer(
			200,
			{ 'content-type': 'application/json', etag: state.etag },
			JSON.stringify(state.list),
		);
	});
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () =>
			resolve({
				server,
				requests,
				state,
				url: `http://127.0.0.1:${server.address().port}`,
			}),
		),
	);
}
/** a commit as GitHub's API lists it */
const githubCommit = (sha, message, date) => ({
	sha,
	html_url: `https://github.com/Fracital/powerMouse/commit/${sha}`,
	commit: {
		message: `${message}\n\nIts body.`,
		author: { name: 'Pusher', email: 'pusher@example.com', date },
		committer: { name: 'Pusher', email: 'pusher@example.com', date },
	},
	author: null,
});
async function eventually(read, want, timeout) {
	const end = Date.now() + timeout;
	let value = await read();
	while (!want(value) && Date.now() < end) {
		await sleep(100);
		value = await read();
	}
	return value;
}
async function liveCommits() {
	const fake = await fakeGitHub();
	const headSha = git('rev-parse', 'HEAD');
	const head = githubCommit(headSha, git('log', '-1', '--format=%s'), null);
	head.commit.author.date = git('log', '-1', '--format=%aI');
	head.commit.committer.date = git('log', '-1', '--format=%cI');
	// the checkout's own log, as the server reads it: on CI that can be one
	// synthetic commit (a shallow or borrowed history), so the rows expected
	// are what it really holds, and each fake commit is dated after HEAD's
	// commit date, which orders the merged list
	const localShas = git('log', '-30', '--format=%H').split('\n');
	const headCommitted = Date.parse(head.commit.committer.date);
	const pushDate = (ago = 0) =>
		new Date(Math.max(Date.now() - ago, headCommitted + 1000)).toISOString();
	/** the short shas the page should list, GitHub's own commits first */
	const expected = (...pushed) =>
		[...pushed.map((commit) => commit.sha), ...localShas]
			.slice(0, 30)
			.map((sha) => sha.slice(0, 7));
	const first = githubCommit('a1'.repeat(20), 'Pushed first', pushDate(120000));
	fake.state.list = [first, head];
	fake.state.etag = '"a"';
	const temp = mkdtempSync(join(tmpdir(), 'stomp-live-commits-'));
	const server = spawn(
		process.execPath,
		[new URL('../../demo/server.js', import.meta.url).pathname],
		{
			env: {
				...process.env,
				TMPDIR: temp,
				PORT: '0',
				STOMP_GITHUB_API: fake.url,
				STOMP_GITHUB_POLL_MS: String(POLL_MS),
				STOMP_REPO: '',
				GITHUB_TOKEN: '',
				STOMP_WISP_URL: '',
				STOMP_TOR_SOCKS5: '',
				STOMP_TOR_WISP_URL: '',
				STOMP_WISP_WEBTRANSPORT: '0',
				STOMP_SITE_POOL: '0',
				STOMP_SLOT_PORTS: '0',
				STOMP_ADBLOCK: '0',
				STOMP_DEFAULT_THEMES: '0',
				STOMP_SHIELDS_DEFAULTS: '0',
				STOMP_ECH_DNS: 'off',
			},
			stdio: ['ignore', 'pipe', 'inherit'],
		},
	);
	const contexts = [];
	try {
		let log = '';
		const port = await new Promise((resolve) => {
			server.stdout.on('data', (chunk) => {
				log += chunk;
				const match = /http:\/\/localhost:(\d+)/.exec(log);
				if (match) resolve(Number(match[1]));
			});
			server.once('exit', () => resolve(null));
		});
		if (!port) {
			ok('live commits: a demo server against the fake GitHub starts', false);
			return;
		}
		const origin = `http://127.0.0.1:${port}/`;
		await waitForServer(`${origin}api/status`);
		const open = async (route) => {
			const context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
			});
			contexts.push(context);
			const page = await context.newPage();
			const asked = [];
			const streams = { opened: 0, ended: 0 };
			page.on('request', (request) => {
				const path = new URL(request.url()).pathname;
				if (path === '/api/commits') asked.push(Date.now());
				if (path === '/api/commits/stream') streams.opened++;
			});
			page.on('requestfailed', (request) => {
				if (new URL(request.url()).pathname === '/api/commits/stream')
					streams.ended++;
			});
			if (route) await route(page);
			await page.goto(origin);
			await page.waitForFunction(
				() => document.querySelectorAll('#commitList li').length > 0,
				null,
				{ timeout: 30000 },
			);
			return { page, asked, streams };
		};
		const rows = (page) =>
			page.evaluate(() =>
				[...document.querySelectorAll('#commitList li')].map((li) => ({
					sha: li.dataset.sha,
					text: li.querySelector('.commitSha').textContent,
					message: li.querySelector('.commitMsg').textContent,
					pending: li.classList.contains('pending'),
					title: li.querySelector('.commit').title,
					time: li.querySelector('time')?.textContent ?? null,
					datetime: li.querySelector('time')?.dateTime ?? null,
					hidden: li.classList.contains('hidden'),
				})),
			);
		const short = (sha) => sha.slice(0, 7);

		const a = await open();
		const shown = await rows(a.page);
		ok(
			"live commits: GitHub's newest commit is on top, marked pushed but not deployed (a ring, its title), and this checkout's HEAD after it, deployed",
			shown[0]?.sha === short(first.sha) &&
				shown[0].message === 'Pushed first' &&
				shown[0].pending &&
				shown[0].title === 'Pushed, not deployed yet' &&
				shown[1]?.sha === short(headSha) &&
				!shown[1].pending &&
				!shown[1].title &&
				JSON.stringify(shown.map((row) => row.sha)) ===
					JSON.stringify(expected(first)) &&
				shown.slice(1).every((row) => !row.pending) &&
				fake.requests[0]?.status === 200 &&
				fake.requests.every((r) => r.auth === null),
			JSON.stringify({
				shown: shown.slice(0, 3),
				count: shown.length,
				expected: expected(first),
				requests: fake.requests.slice(0, 3),
			}),
		);
		const ring = await a.page.evaluate(() => {
			const style = (li) => getComputedStyle(li, '::after');
			const [pending, deployed] = document.querySelectorAll('#commitList li');
			return {
				pending: [style(pending).backgroundColor, style(pending).width],
				deployed: [style(deployed).backgroundColor, style(deployed).width],
			};
		});
		ok(
			"live commits: the pending row's dot is hollow, the same size as a deployed one's",
			ring.pending[0] !== ring.deployed[0] &&
				ring.pending[1] === ring.deployed[1],
			JSON.stringify(ring),
		);

		// unchanged: a conditional request, answered 304
		const unchanged = await eventually(
			() => fake.requests.find((r) => r.status === 304),
			Boolean,
			15000,
		);
		ok(
			'live commits: the poller asks again with the ETag it was given and gets a 304',
			unchanged?.etag === '"a"',
			JSON.stringify(fake.requests),
		);

		// many pages, and requests of /api/commits: still one request to
		// GitHub per interval
		const b = await open();
		const c = await open();
		await Promise.all(
			[a, b, c].map(({ page }) =>
				page.evaluate(() =>
					Promise.all(
						Array.from({ length: 10 }, () =>
							fetch('/api/commits', { cache: 'no-store' }),
						),
					),
				),
			),
		);
		const from = Date.now();
		const WINDOW = 9000;
		await sleep(WINDOW);
		const during = fake.requests.filter(
			(r) => r.at >= from && r.at < from + WINDOW,
		);
		const gaps = during.slice(1).map((r, i) => r.at - during[i].at);
		ok(
			'live commits: with three pages open and thirty requests of /api/commits, the poller still asks GitHub once per interval',
			during.length >= 2 &&
				during.length <= Math.floor(WINDOW / POLL_MS) + 1 &&
				gaps.every((gap) => gap >= POLL_MS - 100),
			JSON.stringify({ count: during.length, gaps }),
		);

		// a push: every open page shows it at the top, without a reload
		await a.page.evaluate(() => {
			window.__liveMark = 'kept';
			window.__headRow = document.querySelectorAll('#commitList li')[1];
		});
		const second = githubCommit('b2'.repeat(20), 'Pushed second', pushDate());
		const askedBefore = [a, b, c].map(({ asked }) => asked.length);
		fake.state.list = [second, first, head];
		fake.state.etag = '"b"';
		const pushedAt = Date.now();
		const arrived = await Promise.all(
			[a, b, c].map(({ page }) =>
				eventually(
					() => rows(page),
					(list) => list[0]?.sha === short(second.sha),
					20000,
				),
			),
		);
		const tookMs = Date.now() - pushedAt;
		const askedAfter = [a, b, c].map(({ asked }) => asked.length);
		const after = await a.page.evaluate(() => {
			const list = document.getElementById('commitList');
			const shown = [...list.children].filter(
				(li) => !li.classList.contains('hidden'),
			);
			const bottom = list.getBoundingClientRect().bottom;
			return {
				mark: window.__liveMark,
				sameHead: list.children[2] === window.__headRow,
				shas: [...list.children].map((li) => li.dataset.sha),
				overflow: list.scrollHeight - list.clientHeight,
				cut: shown.filter(
					(li) => li.getBoundingClientRect().bottom > bottom + 1,
				).length,
				last: shown.at(-1)?.classList.contains('last'),
				lastCount: list.querySelectorAll('li.last').length,
			};
		});
		ok(
			'live commits: a pushed commit shows at the top of every open page with no reload, the rows already there kept',
			arrived.every((list) => list[0]?.sha === short(second.sha)) &&
				arrived[0][0].message === 'Pushed second' &&
				arrived[0][0].pending &&
				arrived[0][1].sha === short(first.sha) &&
				after.mark === 'kept' &&
				after.sameHead &&
				JSON.stringify(after.shas) ===
					JSON.stringify(expected(second, first)) &&
				JSON.stringify(askedAfter) === JSON.stringify(askedBefore),
			JSON.stringify({
				tookMs,
				top: arrived.map((list) => list[0]),
				after,
				askedBefore,
				askedAfter,
			}),
		);
		ok(
			'live commits: the new row has its <time> (just now) and the list is fitted again (whole rows, the last marked)',
			arrived[0][0].time === 'just now' &&
				arrived[0][0].datetime === second.commit.author.date &&
				after.overflow <= 0 &&
				after.cut === 0 &&
				after.last &&
				after.lastCount === 1,
			JSON.stringify({ row: arrived[0][0], after }),
		);
		const changed = fake.requests.find(
			(r) => r.status === 200 && r.etag === '"a"',
		);
		ok(
			'live commits: the poller heard 200, then 304s, then the new list (asked with the old ETag)',
			!!changed && fake.requests[0].status === 200,
			JSON.stringify(fake.requests.map((r) => [r.status, r.etag])),
		);

		// a refusal: nothing until its reset
		const reset = Math.ceil(Date.now() / 1000) + 5;
		fake.state.refuse = reset;
		const refused = await eventually(
			() => fake.requests.find((r) => r.status === 403),
			Boolean,
			15000,
		);
		const next = await eventually(
			() => fake.requests.find((r) => refused && r.at > refused.at),
			Boolean,
			25000,
		);
		const stillShown = await rows(b.page);
		ok(
			'live commits: after a 403 the poller asks nothing before x-ratelimit-reset, then asks again with its ETag, and the pages keep their list',
			!!refused &&
				!!next &&
				next.at >= reset * 1000 &&
				next.etag === '"b"' &&
				stillShown[0]?.sha === short(second.sha),
			JSON.stringify({
				refusedAt: refused?.at,
				reset: reset * 1000,
				next,
			}),
		);

		// a hidden page holds no stream; shown again it opens one
		const visible = (hidden) =>
			c.page.evaluate((hidden) => {
				Object.defineProperty(document, 'hidden', {
					configurable: true,
					get: () => hidden,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			}, hidden);
		const opened = c.streams.opened;
		await visible(true);
		const closed = await eventually(
			() => ({ ...c.streams }),
			(now) => now.ended > 0,
			5000,
		);
		await visible(false);
		const reopened = await eventually(
			() => ({ ...c.streams }),
			(now) => now.opened > opened,
			5000,
		);
		ok(
			'live commits: a hidden page closes its stream, and showing it opens one again',
			opened >= 1 &&
				closed.ended >= 1 &&
				closed.opened === opened &&
				reopened.opened === opened + 1,
			JSON.stringify({ opened, closed, reopened }),
		);

		// a page whose stream fails asks /api/commits at the poller's pace
		const d = await open((page) =>
			page.route('**/api/commits/stream', (route) => route.abort()),
		);
		const third = githubCommit('c3'.repeat(20), 'Pushed third', pushDate());
		fake.state.list = [third, second, first, head];
		fake.state.etag = '"c"';
		const polled = await eventually(
			() => rows(d.page),
			(list) => list[0]?.sha === short(third.sha),
			20000,
		);
		const streamed = await rows(a.page);
		ok(
			'live commits: a page whose stream fails polls /api/commits and shows the push too',
			polled[0]?.sha === short(third.sha) &&
				d.asked.length >= 2 &&
				streamed[0]?.sha === short(third.sha),
			JSON.stringify({ top: polled[0], asked: d.asked.length }),
		);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
		server.kill();
		fake.server.close();
		rmSync(temp, { recursive: true, force: true });
	}
}

await Promise.all([
	run('same-origin', PROXY),
	run('isolated', HOST),
	commitTimes(HOST),
	liveCommits(),
]);
await done(browser, errors);
