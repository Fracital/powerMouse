// The demo's themes (pm/theme.js, docs/themes.md):
//  - Default is the demo's look as it was before themes: every element's
//    colours and backgrounds on the home page, in the browser view and in
//    the Shields panel are the fixture's (test/fixtures/demo-themes-default.json;
//    UPDATE_EXPECTED=1 writes it from the run);
//  - every --pm- token main.css defines or uses is one PMTheme.TOKENS names,
//    and the other way round;
//  - Dark is Default in every view (every element's colours and
//    backgrounds, the color-scheme too) but for the browser's bar (.chrome,
//    and its copy on a tab card), which is solid black with no picture;
//  - Light and Dark put their values on the page, and Follow system takes
//    Light or Dark from prefers-color-scheme, also when the system's
//    changes while the page is open;
//  - the choice made in the menu's Settings is kept: a reload is in it from
//    the first frame (no frame of another theme first), and another window
//    of the demo follows it;
//  - PMTheme.fromChrome maps Chrome theme manifests as Chromium does: given
//    colours as given, missing ones derived (Chrome's own default colours
//    for an empty theme, tints, alpha over white), the scheme by the frame,
//    pictures per scale as an image-set();
//  - an installed theme is chosen at once, comes back after a reload with
//    its pictures, is listed in the picker with Remove, and Remove forgets
//    it (and its stored pictures) with a 'remove' event; the same version
//    installed again leaves the choice alone;
//  - focus rings, in Default and Dark: a click on a toolbar button, the
//    omnibox, a menu item or a dialog's button draws no ring (no native
//    one either), nor does the tab's frame; Tab through the bar, in the
//    settings dialog and into the menu draws the 2px ring in the theme's
//    colour for the surface; in forced colours the browser's ring is back.
/* global PMTheme -- the demo page's, in the functions evaluated there */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	sleep,
	waitForServer,
} from '../lib.mjs';

const EXPECTED = fileURLToPath(
	new URL('../fixtures/demo-themes-default.json', import.meta.url),
);
const UPDATE = process.env.UPDATE_EXPECTED === '1';
const PAGE = `${FIXTURE}pages/bookmark-a.html`;
const LIGHT_PAGE = 'rgb(228, 230, 225)'; // main.css, Light's --pm-page
const DEFAULT_PAGE = 'rgb(0, 0, 0)';
const DARK_PAGE = DEFAULT_PAGE; // Dark keeps Default's homepage
// a 1x1 PNG, for a theme's pictures
const PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

await waitForServer(HOST);
const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, arg, timeout = 20000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(100);
	}
	return value;
}

const settle = (page, ms = 450) =>
	page
		.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve)),
				),
		)
		.then(() => sleep(ms));

async function ready(page) {
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
}

/**
 * A context of its own (its own localStorage and IndexedDB), with what the
 * top document looked like at its first frame and when its body came: the
 * theme attributes, --pm-page and the body's background
 */
async function context(colorScheme = 'light') {
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		colorScheme,
	});
	await ctx.addInitScript(() => {
		if (window !== top) return;
		const seen = (window.__themeSeen = []);
		const record = (when, root = document.documentElement) =>
			seen.push({
				when,
				theme: root?.getAttribute('data-pm-theme') ?? null,
				choice: root?.dataset.pmChoice ?? null,
				page: root
					? getComputedStyle(root).getPropertyValue('--pm-page').trim()
					: '',
				body: document.body
					? getComputedStyle(document.body).backgroundColor
					: null,
			});
		const watch = new MutationObserver(() => {
			if (!document.body) return;
			record('body');
			watch.disconnect();
		});
		watch.observe(document, { childList: true, subtree: true });
		requestAnimationFrame(() => record('frame'));
	});
	return ctx;
}

async function open(ctx, url = HOST) {
	const page = await ctx.newPage();
	page.errors = [];
	page.on('pageerror', (error) => {
		page.errors.push(error.message);
		errors.push(error.message);
	});
	await page.goto(url);
	await ready(page);
	return page;
}

const seen = (page) => page.evaluate(() => window.__themeSeen);
/** once the colours have got where they go (main.css's universal transition) */
const calm = (page) =>
	page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter((animation) => animation instanceof CSSTransition)
				.map((animation) => animation.finished.catch(() => {})),
		),
	);
const state = async (page) => {
	await calm(page);
	return page.evaluate(() => ({
		theme: document.documentElement.getAttribute('data-pm-theme'),
		choice: document.documentElement.dataset.pmChoice,
		body: getComputedStyle(document.body).backgroundColor,
		scheme: getComputedStyle(document.documentElement).colorScheme,
		stored: localStorage.getItem('stomp-demo:theme'),
	}));
};
const homeAppearance = () => {
	const styles = (selector) => {
		const css = getComputedStyle(document.querySelector(selector));
		return [
			css.backgroundColor,
			css.backgroundImage,
			css.color,
			css.borderColor,
		];
	};
	return [styles('body'), styles('.head'), styles('.listing')];
};
const barAppearance = () => {
	const bar = getComputedStyle(document.querySelector('.chrome'));
	const nav = getComputedStyle(document.querySelector('.navbar'));
	const navIcon = getComputedStyle(document.querySelector('.navbtn'));
	const card = document.createElement('div');
	card.className = 'cardChrome';
	document.body.append(card);
	const cardStyle = getComputedStyle(card);
	const top = getComputedStyle(document.querySelector('.bookmarksTop'));
	const view = {
		navbar: [nav.backgroundColor, nav.backgroundImage, navIcon.color],
		bookmarks: [top.backgroundColor, top.backgroundImage, top.color],
		bar: bar.backgroundColor,
		image: bar.backgroundImage,
		card: cardStyle.backgroundColor,
		cardImage: cardStyle.backgroundImage,
		nav: nav.backgroundColor,
		navIcon: navIcon.color,
	};
	card.remove();
	return view;
};

/** the browser view on the fixture page, its menu button up */
async function browse(page) {
	await page.evaluate((url) => {
		const form = document.getElementById('mainForm');
		form.url.value = url;
		form.requestSubmit();
	}, PAGE);
	await page.waitForFunction(
		() =>
			!document.getElementById('browser').classList.contains('hidden') &&
			!document.getElementById('toolShields').hidden,
		null,
		{ timeout: 30000 },
	);
	await sleep(1500);
	await page.evaluate(() => document.activeElement?.blur());
}

// ---- Default: as it was ---------------------------------------------------

/** every shown element's colours and backgrounds, by its path */
const dump = (page) =>
	page.evaluate(() => {
		const props = [
			'color',
			'background-color',
			'background-image',
			'background-position',
			'background-repeat',
			'background-size',
			'border-top-color',
			'border-right-color',
			'border-bottom-color',
			'border-left-color',
			'box-shadow',
			'outline-color',
			'text-shadow',
			'fill',
			'stroke',
			'accent-color',
			'caret-color',
			'opacity',
			'filter',
			'color-scheme',
		];
		const path = (el) => {
			const parts = [];
			for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
				let name = e.localName;
				if (e.id) name += `#${e.id}`;
				else {
					const cls = [...e.classList].sort().join('.');
					if (cls) name += `.${cls}`;
					const same = e.parentElement
						? [...e.parentElement.children].filter(
								(c) => c.localName === e.localName,
							)
						: [];
					if (same.length > 1) name += `:${same.indexOf(e)}`;
				}
				parts.unshift(name);
				if (e.id) break;
			}
			return parts.join('>');
		};
		const out = {};
		for (const el of [
			document.documentElement,
			...document.querySelectorAll('*'),
		]) {
			if (el.closest('head') || el.localName === 'script') continue;
			// the landing's recent commits come from GitHub through
			// /api/commits: none offline (CI), so neither they nor the note
			// that says why are part of the fixture
			if (el.closest('#commitList, #commitsNote')) continue;
			const cs = getComputedStyle(el);
			if (cs.display === 'none') continue;
			const row = {};
			for (const p of props)
				row[p] = cs.getPropertyValue(p).replaceAll(location.origin, '');
			for (const pseudo of ['::before', '::after', '::placeholder']) {
				const ps = getComputedStyle(el, pseudo);
				if (pseudo !== '::placeholder' && ps.content === 'none') continue;
				for (const p of ['color', 'background-color', 'background-image'])
					row[`${pseudo}${p}`] = ps.getPropertyValue(p);
			}
			let key = path(el);
			while (key in out) key += '+';
			out[key] = row;
		}
		return out;
	});

const short = (value) =>
	value.length <= 80
		? value
		: `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;

/**
 * A view's dump as the fixture keeps it: a digest of all of it, the values
 * most of its elements have, and each distinct row (by the first element
 * that has it) as its differences from those
 */
function summary(rows) {
	const all = Object.entries(rows).map(([path, row]) => [
		path,
		Object.fromEntries(
			Object.entries(row)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([prop, value]) => [prop, short(value)]),
		),
	]);
	const digest = createHash('sha256').update(JSON.stringify(all)).digest('hex');
	const props = [...new Set(all.flatMap(([, row]) => Object.keys(row)))].sort();
	const common = {};
	for (const prop of props) {
		const counts = new Map();
		for (const [, row] of all)
			counts.set(row[prop] ?? null, (counts.get(row[prop] ?? null) ?? 0) + 1);
		common[prop] = [...counts].sort((a, b) => b[1] - a[1])[0][0];
	}
	const distinct = {};
	const known = new Set();
	for (const [path, row] of all) {
		const diff = {};
		for (const prop of props)
			if ((row[prop] ?? null) !== common[prop]) diff[prop] = row[prop] ?? null;
		const key = JSON.stringify(diff);
		if (known.has(key)) continue;
		known.add(key);
		distinct[path] = diff;
	}
	return { digest, common, rows: distinct };
}

/** what differs between the fixture's view and the run's, for the failure */
function differences(want, got) {
	if (want.digest === got.digest) return [];
	const out = [];
	const value = (view, path, prop) => {
		const row = view.rows[path];
		return row && prop in row ? row[prop] : view.common[prop];
	};
	for (const path of Object.keys(want.rows)) {
		if (!(path in got.rows) && !got.paths.has(path)) {
			out.push(`${path} is gone`);
			continue;
		}
		const row = got.full[path];
		for (const prop of Object.keys(want.common)) {
			const was = value(want, path, prop);
			const is = row[prop] ?? null;
			if (was !== is) out.push(`${path} ${prop}: ${was} -> ${is}`);
		}
	}
	if (!out.length)
		out.push("an element came or went, or took another element's style");
	return out;
}

/** the home page, the browser view and the Shields panel, each dumped */
async function viewsOf(page) {
	const views = {};
	await page.evaluate(() => document.activeElement?.blur());
	await settle(page);
	await calm(page);
	views.landing = await dump(page);
	await browse(page);
	await settle(page);
	await calm(page);
	views.browser = await dump(page);
	await page.click('#toolShields');
	await settle(page);
	await calm(page);
	views.shields = await dump(page);
	await page.keyboard.press('Escape');
	return views;
}

let defaultViews;
{
	const ctx = await context();
	const page = await open(ctx);
	const views = await viewsOf(page);
	defaultViews = views;
	await ctx.close();

	const measured = Object.fromEntries(
		Object.entries(views).map(([name, rows]) => [name, summary(rows)]),
	);
	if (UPDATE || !existsSync(EXPECTED)) {
		writeFileSync(
			EXPECTED,
			`${JSON.stringify({ views: measured }, null, '\t')}\n`,
		);
		console.log(`wrote ${EXPECTED}`);
	}
	const expected = JSON.parse(readFileSync(EXPECTED, 'utf8')).views;
	for (const [name, rows] of Object.entries(views)) {
		const got = measured[name];
		got.paths = new Set(Object.keys(rows));
		got.full = Object.fromEntries(
			Object.entries(rows).map(([path, row]) => [
				path,
				Object.fromEntries(
					Object.entries(row).map(([prop, value]) => [prop, short(value)]),
				),
			]),
		);
		const diff = differences(expected[name], got);
		ok(
			`Default: the ${name} view's colours are the fixture's`,
			diff.length === 0,
			diff.slice(0, 8).join('; '),
		);
	}
}

// ---- Dark: Default with a solid black browser bar --------------------------

{
	const ctx = await context();
	const setup = await ctx.newPage();
	await setup.goto(HOST);
	await setup.evaluate(() => localStorage.setItem('stomp-demo:theme', 'dark'));
	await setup.close();
	const page = await open(ctx);
	const views = await viewsOf(page);
	await ctx.close();
	// the bar (.chrome) loses its picture; nothing else of any view differs
	const bar = (path) => /(^|>)div\.chrome(:\d+)?$/.test(path);
	for (const [name, rows] of Object.entries(views)) {
		const want = defaultViews[name];
		const out = [];
		for (const path of new Set([...Object.keys(want), ...Object.keys(rows)])) {
			if (!(path in rows)) out.push(`${path} is gone`);
			else if (!(path in want)) out.push(`${path} is new`);
			else
				for (const prop of Object.keys(want[path])) {
					const was = want[path][prop];
					const is = rows[path][prop];
					if (bar(path) && prop === 'background-image') {
						if (is !== 'none') out.push(`${path} ${prop}: ${short(is)}`);
					} else if (was !== is)
						out.push(`${path} ${prop}: ${short(was)} -> ${short(is)}`);
				}
		}
		const bars = Object.keys(rows).filter(bar);
		ok(
			`Dark: the ${name} view is Default's but for the bar's picture`,
			out.length === 0 && (name === 'landing' || bars.length === 1),
			JSON.stringify({ bars, out: out.slice(0, 12) }),
		);
	}
}

// ---- the tokens --------------------------------------------------------

const ctx = await context();
const page = await open(ctx);
{
	const tokens = await page.evaluate(async () => {
		const css = (await (await fetch('/pm/main.css')).text()).replace(
			/\/\*[^]*?\*\//g,
			'',
		);
		const defined = [...css.matchAll(/(--pm-[\w-]+)\s*:/g)].map((m) => m[1]);
		const used = [...css.matchAll(/var\((--pm-[\w-]+)/g)].map((m) => m[1]);
		return {
			defined: [...new Set(defined)].map((name) => name.slice(5)).sort(),
			used: [...new Set(used)].map((name) => name.slice(5)).sort(),
			api: [...PMTheme.TOKENS].sort(),
		};
	});
	const missing = tokens.defined.filter((t) => !tokens.api.includes(t));
	const extra = tokens.api.filter((t) => !tokens.defined.includes(t));
	const undefinedUse = tokens.used.filter((t) => !tokens.defined.includes(t));
	ok(
		'PMTheme.TOKENS names every token main.css defines, and no other',
		!missing.length && !extra.length && tokens.api.length > 100,
		JSON.stringify({ missing, extra, count: tokens.api.length }),
	);
	ok(
		'main.css uses no token it does not define',
		!undefinedUse.length,
		JSON.stringify(undefinedUse),
	);
	const unset = await page.evaluate((names) => {
		const css = getComputedStyle(document.documentElement);
		const out = {};
		for (const scheme of [null, 'light', 'dark', 'systemya-light']) {
			if (scheme)
				document.documentElement.setAttribute('data-pm-theme', scheme);
			else document.documentElement.removeAttribute('data-pm-theme');
			out[scheme ?? 'default'] = names.filter(
				(name) => !css.getPropertyValue(`--pm-${name}`).trim(),
			);
		}
		document.documentElement.removeAttribute('data-pm-theme');
		return out;
	}, tokens.api);
	ok(
		'Every built-in theme gives every token a value',
		Object.values(unset).every((names) => !names.length),
		JSON.stringify(unset),
	);
}

// ---- Light, Dark, the picker, the reload ---------------------------------

{
	let now = await state(page);
	ok(
		'a new profile is in Default',
		now.theme === null &&
			now.choice === 'default' &&
			now.body === DEFAULT_PAGE &&
			now.stored === null,
		JSON.stringify(now),
	);
	const originalHome = await page.evaluate(homeAppearance);
	const list = await page.evaluate(() =>
		PMTheme.list().map(({ id, name, source }) => [id, name, source]),
	);
	ok(
		'the built-in themes include SystemYA Light',
		JSON.stringify(list) ===
			JSON.stringify([
				['default', 'Default', 'builtin'],
				['light', 'Light', 'builtin'],
				['dark', 'Dark', 'builtin'],
				['systemya-light', 'SystemYA Light', 'builtin'],
				['system', 'Follow system', 'builtin'],
			]),
		JSON.stringify(list),
	);

	await browse(page);
	const defaultBar = await page.evaluate(barAppearance);
	await page.click('#toolMenu');
	await settle(page, 100);
	await page.click('#menuSettings');
	await page.waitForSelector('#spThemes .spThemePick');
	const picks = await page.$$eval('#spThemes .spThemePick', (els) =>
		els.map((el) => [
			el.dataset.theme,
			el.getAttribute('role'),
			el.getAttribute('aria-checked'),
		]),
	);
	ok(
		'Settings lists the themes as a radio group, Default checked',
		JSON.stringify(picks) ===
			JSON.stringify([
				['default', 'radio', 'true'],
				['light', 'radio', 'false'],
				['dark', 'radio', 'false'],
				['systemya-light', 'radio', 'false'],
				['system', 'radio', 'false'],
			]),
		JSON.stringify(picks),
	);
	const events = await page.evaluateHandle(() => {
		const list = [];
		PMTheme.addEventListener('change', (event) =>
			list.push([event.detail.reason, event.detail.id]),
		);
		return list;
	});

	await page.click('.spThemePick[data-theme="light"]');
	now = await state(page);
	ok(
		'choosing Light puts it on the page and keeps it',
		now.theme === 'light' &&
			now.choice === 'light' &&
			now.body === LIGHT_PAGE &&
			now.scheme === 'light' &&
			now.stored === 'light',
		JSON.stringify(now),
	);
	const toolbar = await page.evaluate(() => ({
		bar: getComputedStyle(document.querySelector('.chrome')).backgroundColor,
		field: getComputedStyle(document.querySelector('#omni input'))
			.backgroundColor,
		checked: document.querySelector('.spThemePick[aria-checked="true"]')
			?.dataset.theme,
	}));
	ok(
		"Light's toolbar and address box are its own, and the picker shows it",
		toolbar.bar === 'rgb(246, 246, 244)' &&
			toolbar.field === 'rgb(255, 255, 255)' &&
			toolbar.checked === 'light',
		JSON.stringify(toolbar),
	);

	// the arrows move the choice, as in a radio group
	await page.focus('.spThemePick[data-theme="light"]');
	await page.keyboard.press('ArrowDown');
	now = await state(page);
	const focused = await page.evaluate(
		() => document.activeElement?.dataset.theme,
	);
	ok(
		"ArrowDown in the picker chooses Dark, in Default's color-scheme",
		now.theme === 'dark' &&
			now.body === DARK_PAGE &&
			now.scheme === 'normal' &&
			now.stored === 'dark' &&
			focused === 'dark',
		JSON.stringify({ now, focused }),
	);
	const darkHome = await page.evaluate(homeAppearance);
	const darkBar = await page.evaluate(barAppearance);
	const darkPageScheme = await page.evaluate(() => PMTheme.pageScheme());
	ok(
		"Dark keeps Default's homepage and navigation bar, its browser bar solid black",
		JSON.stringify(darkHome) === JSON.stringify(originalHome) &&
			darkPageScheme === 'dark' &&
			darkBar.bar === 'rgb(0, 0, 0)' &&
			darkBar.card === darkBar.bar &&
			darkBar.image === 'none' &&
			darkBar.cardImage === 'none' &&
			JSON.stringify(darkBar.navbar) === JSON.stringify(defaultBar.navbar) &&
			JSON.stringify(darkBar.bookmarks) ===
				JSON.stringify(defaultBar.bookmarks),
		JSON.stringify({ darkHome, darkBar, defaultBar, originalHome }),
	);
	const fired = await events.jsonValue();
	ok(
		"each choice fires 'change'",
		JSON.stringify(fired) ===
			JSON.stringify([
				['apply', 'light'],
				['apply', 'dark'],
			]),
		JSON.stringify(fired),
	);
	await page.click('.spThemePick[data-theme="systemya-light"]');
	now = await state(page);
	const systemyaHome = await page.evaluate(homeAppearance);
	const systemyaBar = await page.evaluate(barAppearance);
	const systemyaPageScheme = await page.evaluate(() => PMTheme.pageScheme());
	ok(
		'SystemYA Light keeps the original homepage and paints the bars white',
		now.theme === 'systemya-light' &&
			now.choice === 'systemya-light' &&
			now.stored === 'systemya-light' &&
			now.scheme === 'light' &&
			systemyaPageScheme === 'light' &&
			JSON.stringify(systemyaHome) === JSON.stringify(originalHome) &&
			systemyaBar.bar === 'rgb(255, 255, 255)' &&
			systemyaBar.card === systemyaBar.bar &&
			systemyaBar.nav === systemyaBar.bar &&
			systemyaBar.image === 'none' &&
			systemyaBar.cardImage === 'none' &&
			systemyaBar.navIcon === 'rgb(48, 48, 48)',
		JSON.stringify({ now, systemyaHome, systemyaBar, originalHome }),
	);
	await page.reload();
	await ready(page);
	const systemyaFrames = await seen(page);
	ok(
		'SystemYA Light is applied from the first frame of a reload',
		systemyaFrames.length >= 2 &&
			systemyaFrames.every(
				(f) =>
					f.theme === 'systemya-light' &&
					f.choice === 'systemya-light' &&
					f.page === '#000' &&
					(f.body === null || f.body === DEFAULT_PAGE),
			),
		JSON.stringify(systemyaFrames),
	);

	// another window of the demo follows
	const other = await open(ctx);
	await page.evaluate(() => PMTheme.apply('light'));
	const followed = await until(
		other,
		() => document.documentElement.getAttribute('data-pm-theme'),
		(v) => v === 'light',
	);
	ok('another window follows the choice', followed === 'light', followed);
	await other.close();
	await page.evaluate(() => PMTheme.apply('dark'));

	// the reload: Dark from the first frame
	await page.reload();
	await ready(page);
	const frames = await seen(page);
	now = await state(page);
	ok(
		'after a reload the page is in Dark',
		now.theme === 'dark' && now.body === DARK_PAGE,
		JSON.stringify(now),
	);
	ok(
		'and was from its first frame, and when its body came',
		frames.length >= 2 &&
			frames.every(
				(f) =>
					f.theme === 'dark' &&
					f.choice === 'dark' &&
					f.page === '#000' &&
					(f.body === null || f.body === DARK_PAGE),
			),
		JSON.stringify(frames),
	);
}

// ---- Follow system --------------------------------------------------------

{
	const dark = await context('dark');
	const setup = await dark.newPage();
	await setup.goto(HOST);
	await setup.evaluate(() =>
		localStorage.setItem('stomp-demo:theme', 'system'),
	);
	await setup.close();
	const page = await open(dark);
	let frames = await seen(page);
	let now = await state(page);
	ok(
		'Follow system on a dark system is Dark, from the first frame',
		now.theme === 'dark' &&
			now.choice === 'system' &&
			now.body === DARK_PAGE &&
			frames.every((f) => f.theme === 'dark'),
		JSON.stringify({ now, frames }),
	);
	const changes = await page.evaluateHandle(() => {
		const list = [];
		PMTheme.addEventListener('change', (event) =>
			list.push([event.detail.reason, event.detail.theme.scheme]),
		);
		return list;
	});
	await page.emulateMedia({ colorScheme: 'light' });
	now = await until(
		page,
		() => document.documentElement.getAttribute('data-pm-theme'),
		(v) => v === 'light',
	);
	await calm(page);
	const body = await page.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);
	const current = await page.evaluate(() => {
		const { id, scheme } = PMTheme.current();
		return { id, scheme };
	});
	ok(
		'and turns Light when the system does, the choice still Follow system',
		now === 'light' &&
			body === LIGHT_PAGE &&
			current.id === 'system' &&
			current.scheme === 'light',
		JSON.stringify({ now, body, current }),
	);
	ok(
		"with a 'change' event",
		JSON.stringify(await changes.jsonValue()) ===
			JSON.stringify([['system', 'light']]),
		JSON.stringify(await changes.jsonValue()),
	);
	await page.reload();
	await ready(page);
	frames = await seen(page);
	ok(
		'a reload on a light system is Light from the first frame',
		frames.length >= 2 && frames.every((f) => f.theme === 'light'),
		JSON.stringify(frames),
	);
	await dark.close();
}

// ---- fromChrome -----------------------------------------------------------

{
	const mapped = await page.evaluate((png) => {
		const pick = (theme, names) =>
			Object.fromEntries(names.map((name) => [name, theme.tokens[name]]));
		const rgb = (c) => (c ? `${c[0]}, ${c[1]}, ${c[2]}` : c);
		const resolved = (theme) =>
			Object.fromEntries(
				Object.entries(theme.chrome).map(([key, value]) => [
					key,
					Array.isArray(value) ? rgb(value) : value,
				]),
			);
		// a theme naming every colour
		const full = PMTheme.fromChrome(
			{
				colors: {
					frame: [33, 40, 48],
					frame_inactive: [50, 50, 50],
					toolbar: [56, 64, 74],
					toolbar_text: [230, 230, 230],
					toolbar_button_icon: [200, 200, 200],
					tab_text: [255, 255, 255],
					tab_background_text: [180, 180, 180],
					bookmark_text: [220, 220, 220],
					ntp_background: [20, 24, 28],
					ntp_text: [240, 240, 240],
					ntp_link: [138, 180, 248],
					ntp_header: [200, 170, 90],
					omnibox_background: [30, 30, 30],
					omnibox_text: [255, 255, 255],
					button_background: [255, 255, 255, 0.5],
				},
				properties: {
					ntp_background_alignment: 'bottom',
					ntp_background_repeat: 'repeat-x',
				},
				images: {
					theme_frame: png,
					theme_frame_overlay: png,
					theme_ntp_background: { '100_percent': png, '200_percent': png },
					theme_ntp_attribution: { '100_percent': png },
					theme_button_background: png,
					theme_toolbar: { '300_px': png },
				},
			},
			{
				id: 'chrome-theme:abcdefghijklmnopabcdefghijklmnop',
				extensionId: 'abcdefghijklmnopabcdefghijklmnop',
				name: 'Night',
				version: '1.2',
			},
		);
		// an empty theme: Chrome's own colours
		const empty = PMTheme.fromChrome({}, { id: 'empty' });
		// tints, a colour with alpha, ntp_section, the attribution alone
		const tinted = PMTheme.fromChrome(
			{
				colors: { ntp_background: [255, 0, 0, 0.5], ntp_section: [10, 20, 30] },
				tints: {
					frame: [-1, -1, 0.3],
					background_tab: [-1, -1, 0.75],
					buttons: [0.6, 1, -1],
				},
				images: { theme_ntp_attribution: png },
			},
			{ id: 'tinted', name: 'Tinted' },
		);
		return {
			full: {
				id: full.id,
				name: full.name,
				source: full.source,
				extensionId: full.extensionId,
				version: full.version,
				scheme: full.scheme,
				images: Object.fromEntries(
					Object.entries(full.images).map(([k, v]) => [
						k,
						typeof v === 'string' ? 'url' : Object.keys(v).join(','),
					]),
				),
				tokens: pick(full, [
					'frame',
					'frame-inactive',
					'frame-text',
					'toolbar',
					'toolbar-text',
					'toolbar-fg-rgb',
					'toolbar-button',
					'navbar-icon',
					'tab-text',
					'bookmark-text',
					'ntp',
					'page',
					'ntp-text',
					'ntp-position',
					'ntp-repeat',
					'link',
					'accent',
					'field-active',
					'field-text',
				]),
				chrome: resolved(full),
			},
			empty: { scheme: empty.scheme, chrome: resolved(empty) },
			tinted: {
				scheme: tinted.scheme,
				chrome: resolved(tinted),
				accent: tinted.tokens.accent,
			},
		};
	}, PNG);
	const { full, empty, tinted } = mapped;
	ok(
		'fromChrome names the theme and keeps the pictures it maps',
		full.id === 'chrome-theme:abcdefghijklmnopabcdefghijklmnop' &&
			full.name === 'Night' &&
			full.source === 'webstore' &&
			full.extensionId === 'abcdefghijklmnopabcdefghijklmnop' &&
			full.version === '1.2' &&
			JSON.stringify(full.images) ===
				JSON.stringify({
					theme_frame: 'url',
					theme_frame_overlay: 'url',
					theme_ntp_background: '100_percent,200_percent',
					theme_ntp_attribution: 'url',
				}),
		JSON.stringify(full),
	);
	const wantTokens = {
		frame: 'rgb(33, 40, 48)',
		'frame-inactive': 'rgb(50, 50, 50)',
		'frame-text': 'rgb(180, 180, 180)',
		toolbar: 'rgb(56, 64, 74)',
		'toolbar-text': 'rgb(230, 230, 230)',
		'toolbar-fg-rgb': '230, 230, 230',
		// button_background is the caption buttons', which the page has none of
		'toolbar-button': 'transparent',
		'navbar-icon': 'rgb(200, 200, 200)',
		'tab-text': 'rgb(255, 255, 255)',
		'bookmark-text': 'rgb(220, 220, 220)',
		ntp: 'rgb(20, 24, 28)',
		page: 'rgb(20, 24, 28)',
		'ntp-text': 'rgb(240, 240, 240)',
		'ntp-position': 'center bottom',
		'ntp-repeat': 'repeat-x',
		link: 'rgb(138, 180, 248)',
		accent: 'rgb(200, 170, 90)',
		'field-active': 'rgb(30, 30, 30)',
		'field-text': 'rgb(255, 255, 255)',
	};
	ok(
		"fromChrome gives a theme's colours to their tokens, the scheme dark by its frame",
		full.scheme === 'dark' &&
			JSON.stringify(full.tokens) === JSON.stringify(wantTokens),
		JSON.stringify({ scheme: full.scheme, tokens: full.tokens }),
	);
	ok(
		'button_background is read, though nothing here paints it',
		full.chrome.button_background === '255, 255, 255',
		full.chrome.button_background,
	);
	// Chrome's default colours (ThemeProperties' defaults, the light mixers)
	const wantEmpty = {
		frame: '222, 225, 230', // #DEE1E6
		frame_inactive: '231, 234, 237', // #E7EAED
		toolbar: '255, 255, 255',
		toolbar_text: '60, 64, 67', // Grey 800
		toolbar_button_icon: '95, 99, 104', // Grey 700
		tab_text: '60, 64, 67',
		background_tab: '222, 225, 230',
		tab_background_text: '60, 64, 67',
		bookmark_text: '60, 64, 67',
		ntp_background: '255, 255, 255',
		ntp_text: '0, 0, 0',
		ntp_link: '25, 103, 210', // Blue 700
		ntp_header: '150, 150, 150',
		ntp_logo_alternate: false,
	};
	const emptyGot = Object.fromEntries(
		Object.keys(wantEmpty).map((key) => [key, empty.chrome[key]]),
	);
	ok(
		"an empty theme resolves to Chrome's own colours, and is light",
		empty.scheme === 'light' &&
			JSON.stringify(emptyGot) === JSON.stringify(wantEmpty),
		JSON.stringify({ scheme: empty.scheme, got: emptyGot }),
	);
	const icon = tinted.chrome.toolbar_button_icon.split(', ').map(Number);
	ok(
		'tints shift the frame, the background tab and the buttons as HSLShift does',
		tinted.chrome.frame === '133, 135, 138' &&
			tinted.chrome.frame_inactive === '231, 234, 237' &&
			tinted.chrome.background_tab === '194, 195, 197' &&
			// Grey 700 with hue 0.6 and full saturation: (0, 79.6, 199)
			Math.abs(icon[0] - 0) <= 1 &&
			Math.abs(icon[1] - 80) <= 1 &&
			Math.abs(icon[2] - 199) <= 1,
		JSON.stringify(tinted.chrome),
	);
	ok(
		'a colour with alpha is painted over white, its text the contrasting grey',
		tinted.chrome.ntp_background === '255, 127, 127' &&
			tinted.chrome.ntp_text === '32, 33, 36' &&
			tinted.chrome.ntp_logo_alternate === true &&
			// (the tinted frame, 133, 135, 138, is light by IsDark)
			tinted.scheme === 'light',
		JSON.stringify(tinted),
	);
	ok(
		'ntp_section stands in for ntp_header',
		tinted.chrome.ntp_header === '10, 20, 30' &&
			tinted.accent === 'rgb(10, 20, 30)',
		JSON.stringify(tinted),
	);
}

// ---- installing, the reload, Remove -----------------------------------------

{
	await page.evaluate(() => PMTheme.apply('default'));
	const sample = (version) =>
		page.evaluate(
			async ({ png, version }) => {
				const blob = await (await fetch(png)).blob();
				const theme = PMTheme.fromChrome(
					{
						colors: {
							frame: [71, 105, 91],
							toolbar: [207, 221, 192],
							ntp_text: [230, 255, 204],
							ntp_link: [36, 70, 0],
						},
						images: {
							theme_frame: URL.createObjectURL(blob),
							theme_frame_overlay: blob,
							theme_ntp_background: {
								'100_percent': URL.createObjectURL(blob),
								'200_percent': blob,
							},
							theme_ntp_attribution: png,
						},
						properties: { ntp_background_alignment: 'bottom' },
					},
					{
						id: 'chrome-theme:forestforestforestforestforestfore',
						extensionId: 'forestforestforestforestforestfore',
						name: 'Forest',
						version,
					},
				);
				const events = (window.__themeEvents = []);
				for (const type of ['change', 'remove'])
					PMTheme.addEventListener(type, (event) =>
						events.push([type, event.detail.reason ?? null, event.detail.id]),
					);
				const result = await PMTheme.install(theme);
				return { id: result.id, events };
			},
			{ png: PNG, version },
		);
	const installed = await sample('1.0');
	const ID = 'chrome-theme:forestforestforestforestforestfore';
	let now = await state(page);
	ok(
		'install() keeps the theme and switches to it',
		installed.id === ID &&
			now.choice === ID &&
			now.theme === 'dark' &&
			now.stored === ID &&
			JSON.stringify(installed.events) ===
				JSON.stringify([['change', 'install', ID]]),
		JSON.stringify({ installed, now }),
	);
	const painted = async () =>
		until(
			page,
			() => {
				const root = document.documentElement;
				const css = getComputedStyle(root);
				return {
					custom: root.hasAttribute('data-pm-custom'),
					ntpImage: root.hasAttribute('data-pm-ntp-image'),
					attribution: root.hasAttribute('data-pm-attribution'),
					frame: css.getPropertyValue('--pm-frame').trim(),
					frameImage: css.getPropertyValue('--pm-frame-image').trim(),
					overlay: css.getPropertyValue('--pm-frame-overlay').trim(),
					ntp: css.getPropertyValue('--pm-ntp-image').trim(),
					head: getComputedStyle(document.querySelector('.head'))
						.backgroundImage,
					listing: getComputedStyle(document.querySelector('.listing'))
						.backgroundPosition,
				};
			},
			(v) => v?.attribution,
		);
	now = await painted();
	ok(
		"the theme's colours and pictures are on the page",
		now?.custom &&
			now.ntpImage &&
			now.attribution &&
			now.frame === 'rgb(71, 105, 91)' &&
			/^url\("blob:/.test(now.frameImage) &&
			/^url\("blob:/.test(now.overlay) &&
			/^image-set\(url\("blob:[^)]*"\) 1x, url\("blob:[^)]*"\) 2x\)$/.test(
				now.ntp,
			) &&
			(now.head.match(/blob:/g) ?? []).length === 2 &&
			now.listing === '50% 100%',
		JSON.stringify(now),
	);

	// the same version again (the Web Store side hands it over on each load)
	await page.evaluate(() => PMTheme.apply('dark'));
	await sample('1.0');
	now = await state(page);
	ok(
		'the same version installed again leaves the choice alone',
		now.choice === 'dark' && now.stored === 'dark',
		JSON.stringify(now),
	);
	await page.evaluate((id) => PMTheme.apply(id), ID);

	await page.reload();
	await ready(page);
	const frames = await seen(page);
	now = await painted();
	ok(
		'after a reload the theme is back with its pictures, read from IndexedDB',
		frames.every((f) => f.choice === ID && f.theme === 'dark') &&
			now?.custom &&
			now.attribution &&
			/^url\("blob:/.test(now.frameImage) &&
			/^image-set\(/.test(now.ntp),
		JSON.stringify({ frames, now }),
	);

	await browse(page);
	await page.click('#toolMenu');
	await settle(page, 100);
	await page.click('#menuSettings');
	await page.waitForSelector('#spThemes .spThemePick');
	const rows = await page.$$eval('#spThemes .spTheme', (els) =>
		els.map((el) => ({
			id: el.querySelector('.spThemePick').dataset.theme,
			checked: el.querySelector('.spThemePick').getAttribute('aria-checked'),
			remove: el.querySelector('.spThemeRemove')?.textContent ?? null,
		})),
	);
	ok(
		'the picker lists it, chosen, with Remove; the built-in ones have none',
		rows.length === 6 &&
			rows[5].id === ID &&
			rows[5].checked === 'true' &&
			rows[5].remove === 'Remove' &&
			rows.slice(0, 5).every((row) => row.remove === null),
		JSON.stringify(rows),
	);
	await page.evaluate(() => {
		window.__themeEvents = [];
		for (const type of ['change', 'remove'])
			PMTheme.addEventListener(type, (event) =>
				window.__themeEvents.push([
					type,
					event.detail.reason ?? null,
					event.detail.id,
					event.detail.extensionId ?? null,
				]),
			);
	});
	await page.click('.spThemeRemove');
	const after = await until(
		page,
		async () => {
			const keys = await new Promise((resolve) => {
				const request = indexedDB.open('stomp-demo-themes');
				request.onsuccess = () => {
					const keys = request.result
						.transaction('images')
						.objectStore('images')
						.getAllKeys();
					keys.onsuccess = () => resolve(keys.result);
				};
			});
			return {
				events: window.__themeEvents,
				keys,
				list: PMTheme.list().map((theme) => theme.id),
				picks: [...document.querySelectorAll('#spThemes .spThemePick')].map(
					(el) => el.dataset.theme,
				),
				status: document.getElementById('spStatus')?.textContent,
			};
		},
		(v) => v?.events?.length >= 2,
	);
	now = await state(page);
	ok(
		"Remove forgets the theme and its pictures, back to Default, with a 'remove' event",
		JSON.stringify(after.events) ===
			JSON.stringify([
				['remove', null, ID, 'forestforestforestforestforestfore'],
				['change', 'remove', 'default', null],
			]) &&
			after.keys.length === 0 &&
			!after.list.includes(ID) &&
			after.picks.length === 5 &&
			now.choice === 'default' &&
			now.theme === null &&
			now.body === DEFAULT_PAGE &&
			now.stored === 'default' &&
			after.status === 'Removed Forest.',
		JSON.stringify({ after, now }),
	);
	ok(
		'uninstall is remove',
		await page.evaluate(() => PMTheme.uninstall === PMTheme.remove),
	);
	ok(
		'install() refuses a value that would end its declaration',
		await page.evaluate(async () => {
			try {
				await PMTheme.install({
					id: 'bad',
					name: 'Bad',
					scheme: 'dark',
					tokens: { page: 'red; } body { display: none' },
					images: {},
				});
			} catch {
				return false;
			}
			const kept = getComputedStyle(document.documentElement)
				.getPropertyValue('--pm-page')
				.trim();
			await PMTheme.remove('bad');
			return kept === '#000';
		}),
	);
	ok(
		'a built-in id cannot be installed over',
		await page.evaluate(() =>
			PMTheme.install({
				id: 'light',
				name: 'Not light',
				scheme: 'dark',
				tokens: {},
				images: {},
			}).then(
				() => false,
				(error) => error instanceof TypeError,
			),
		),
	);
}

await ctx.close();

// ---- focus rings ------------------------------------------------------------

/**
 * The focused element's outline once its transition is over (main.css's
 * universal one), and the colour its ring should have: the panels' accent in
 * a popover or the settings dialog, a sheet's own in a site's sheet, else
 * --pm-focus
 */
const ring = async (page) => {
	await calm(page);
	return page.evaluate(() => {
		const element = document.activeElement;
		const style = getComputedStyle(element);
		const token = element.closest('.popover, .shieldsPage, .extInstall')
			? '--pm-panel-accent'
			: element.closest('.permissionPrompt')
				? '--pm-dialog-focus'
				: '--pm-focus';
		const probe = document.createElement('i');
		probe.style.color = `var(${token})`;
		document.body.append(probe);
		const want = getComputedStyle(probe).color;
		probe.remove();
		return {
			element: element.id
				? `#${element.id}`
				: `${element.localName}.${[...element.classList].join('.')}`,
			keyboard: element.matches(':focus-visible'),
			style: style.outlineStyle,
			width: style.outlineWidth,
			color: style.outlineColor,
			want,
		};
	});
};
const themed = (seen) =>
	seen.keyboard &&
	seen.style === 'solid' &&
	seen.width === '2px' &&
	seen.color === seen.want;

for (const theme of ['default', 'dark']) {
	const focusContext = await context();
	const page = await open(focusContext);
	await page.evaluate((id) => PMTheme.apply(id), theme);
	await browse(page);

	// a click draws no ring on anything: a toolbar button, the omnibox, the
	// menu's first item (focused by the menu as it opens), a dialog's
	// button, the tab's frame
	const clicked = {};
	await page.click('#toolReload');
	clicked.toolbar = await ring(page);
	await page.click('#omni input');
	clicked.omnibox = await ring(page);
	await page.click('#toolMenu');
	await settle(page, 100);
	clicked.menuItem = await ring(page);
	await page.click('#menuSettings');
	await page.waitForSelector('#spThemes .spThemePick');
	await settle(page, 100);
	await page.click('.spThemePick[aria-checked="true"]');
	clicked.dialogButton = await ring(page);
	ok(
		`${theme}: a click draws no focus ring on a button, the omnibox, a menu item or a dialog's button`,
		Object.values(clicked).every((seen) => seen.style === 'none') &&
			clicked.toolbar.element === '#toolReload' &&
			clicked.menuItem.element === '#menuFullscreen' &&
			clicked.dialogButton.element === 'button.spThemePick',
		JSON.stringify(clicked),
	);
	// the keyboard in the dialog: the panels' accent
	await page.keyboard.press('Shift+Tab');
	const inDialog = await ring(page);
	ok(
		`${theme}: Tab in the settings dialog draws the themed ring`,
		themed(inDialog) && inDialog.want !== '',
		JSON.stringify(inDialog),
	);
	await page.keyboard.press('Escape');
	await settle(page, 100);

	// Tab through the bar from the address box: each button has the ring in
	// --pm-focus; the address box shows its focus with its border only
	await page.click('#omni input');
	const bar = [];
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press('Tab');
		const seen = await ring(page);
		bar.push(seen);
		if (seen.element === '#toolMenu') break;
	}
	await page.click('#omni input');
	await page.keyboard.press('Shift+Tab');
	bar.push(await ring(page));
	ok(
		`${theme}: Tab through the toolbar draws the themed ring on each button`,
		bar.length >= 4 &&
			bar.every(themed) &&
			['#toolShields', '#toolMenu', '#toolSaved'].every((id) =>
				bar.some((seen) => seen.element === id),
			),
		JSON.stringify(bar),
	);
	// the menu from the keyboard: its item in the panels' accent
	await page.focus('#toolMenu');
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Enter');
	await settle(page, 100);
	const item = await ring(page);
	ok(
		`${theme}: the menu opened from the keyboard rings its item in the panels' accent`,
		themed(item) && item.element === '#menuFullscreen',
		JSON.stringify(item),
	);
	await page.keyboard.press('Escape');
	await settle(page, 100);

	// a click in the tab's page: the frame element draws nothing (the page
	// in it draws its own rings)
	const frame = await page.$('#frames .frame:not(.hidden)');
	const box = await frame.boundingBox();
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	const inFrame = await ring(page);
	// and none when Enter in the address box hands the focus to the page (a
	// keyboard focus, which the browser's own ring drew around the page)
	await page.click('#omni input');
	await page.keyboard.press('Enter');
	await until(
		page,
		() => document.activeElement?.localName === 'iframe',
		Boolean,
	);
	const entered = await ring(page);
	ok(
		`${theme}: the tab's frame draws no ring when its page has the focus`,
		[inFrame, entered].every(
			(seen) => seen.element.startsWith('iframe') && seen.style === 'none',
		),
		JSON.stringify({ inFrame, entered }),
	);

	// forced colours: the browser's own ring on the keyboard's focus
	await page.emulateMedia({ forcedColors: 'active' });
	await page.focus('#toolMenu');
	await page.keyboard.press('Shift+Tab');
	const forced = await ring(page);
	await page.emulateMedia({ forcedColors: 'none' });
	ok(
		`${theme}: in forced colours the keyboard's focus has the browser's ring`,
		forced.keyboard && forced.style === 'auto',
		JSON.stringify(forced),
	);

	// a text field's click on the Extensions page: its border, no ring
	await page.evaluate(() => window.openExtensionsPage());
	await page.waitForSelector('#xpSearch');
	await settle(page, 100);
	await page.click('#xpSearch');
	const search = await ring(page);
	ok(
		`${theme}: a click in the Extensions page's search box draws no ring`,
		search.element === '#xpSearch' && search.style === 'none',
		JSON.stringify(search),
	);
	await focusContext.close();
}

ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
