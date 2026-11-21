// The switch to vibeOS (pm/main.js "vibeOS", the vendor/vibeOS submodule
// built into dist/vibeos/ by scripts/vibeos.mjs), which this suite skips
// when the build has no vibeOS:
//  - a fresh page asks for nothing of vibeOS until the switch is used: no
//    module, stylesheet or file under its directory;
//  - no address names vibeOS: its directory is a neutral one (config.js),
//    and so is the address of a game's frame (its window's page);
//  - its font is its own (Open Sans from its directory), loaded before the
//    desktop shows, and nothing is asked of another site;
//  - the tab manager's vibeOS button turns every tab into a window of
//    vibeOS's browser at once: no card animates back to full screen, each
//    window holds the tab's own frame element, the card shown in the middle
//    is the focused window's tab;
//  - nothing reloads, either way: the page's JS state, a typed input, its
//    scroll, its running timer and a nested frame's timer go on as they were,
//    and the fixture sees no second request for either document; the tab is
//    dialed (its frame's address names no site);
//  - a tab vibeOS's browser opens is a tab of the demo's, and a dialed
//    navigation in a window swaps its next document's frame into the window;
//  - the menu of vibeOS's browser is the demo's own menu, the same items;
//  - back in the demo's view the frames are the demo's tabs again, the
//    focused window's tab on screen, and a second switch fetches nothing;
//  - a minimized window is unseen and out of reach but laid out: its tab's
//    frame keeps its scroll, its focused input and selection, and comes back
//    the same;
//  - without moveBefore (Firefox) the frames stay where they are and are
//    laid over their windows, their documents just as alive;
//  - the emulator is not served: vibeOS fetches v86 through the proxy
//    (vibeHost.fetch) from its pinned sources, runs nothing whose SHA-256
//    is not the pinned one, and boots from Cache Storage with no request at
//    all once it has the files; with the network (no SKIP_NETWORK) a fresh
//    page fetches them through the proxy, never from the page itself.
/* global tabs, activateTab, vibeHost -- pm/main.js's, read in the demo's page */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!existsSync(`${root}dist/vibeos/embed.js`)) {
	console.log(
		'SKIP demo-vibeos (no dist/vibeos/: vendor/vibeOS is not checked out or not built)',
	);
	process.exit(0);
}

const STATE = `${FIXTURE}pages/vibeos-state.html`;
const OTHER = `${FIXTURE}pages/bookmark-a.html`;
const NEXT = `${FIXTURE}pages/bookmark-b.html`;

// the server's directory for vibeOS and its names for vibeOS's pages
const { vibeos: VIBE } = JSON.parse(
	/STOMP_CONFIG = (.*);\s*$/s.exec(
		await (await fetch(`${HOST}config.js`)).text(),
	)[1],
);
const NEUTRAL = /^[0-9a-f]{8}\/$/;

const browser = await launch();
const errors = [];

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

const hits = async () => {
	const all = await (await fetch(`${FIXTURE}hits`)).json();
	return [
		all['vibeos-state.html']?.requests ?? 0,
		all['vibeos-state-inner.html']?.requests ?? 0,
	];
};

/** the document of the frame element tagged `tag` (an expando of the host's realm) */
async function tagged(page, tag) {
	const handle = await page.evaluateHandle(
		(name) =>
			[...document.querySelectorAll('iframe')].find(
				(f) => f.__vibeTest === name,
			) ?? null,
		tag,
	);
	return handle.asElement()?.contentFrame() ?? null;
}

/** what the state page holds now */
async function stateOf(page) {
	const frame = await tagged(page, 'state');
	if (!frame) return null;
	const top = await frame.evaluate(() => ({
		loads: window.loads,
		mark: window.__mark ?? null,
		count: window.count,
		typed: document.getElementById('typed').value,
		y: Math.round(scrollY),
	}));
	const nested = frame.childFrames()[0];
	const inner = nested
		? await nested.evaluate(() => ({
				ticks: window.ticks,
				mark: window.__mark ?? null,
			}))
		: null;
	return { ...top, inner };
}

async function checkState(page, label, before, hitsBefore) {
	const first = await stateOf(page).catch((error) => ({
		error: error.message,
	}));
	await sleep(300);
	const second = await stateOf(page).catch((error) => ({
		error: error.message,
	}));
	ok(
		`${label}: the page's script state, typed input and scroll are kept`,
		first?.mark === 'alive' &&
			first.loads === 1 &&
			first.typed === 'typed before' &&
			first.y === 1234,
		JSON.stringify(first),
	);
	ok(
		`${label}: its timer and its nested frame's timer kept running`,
		second?.count > first?.count &&
			first.count >= before.count &&
			second.inner?.ticks > first.inner?.ticks &&
			first.inner?.mark === 'nested alive',
		`${JSON.stringify(first)} -> ${JSON.stringify(second)}`,
	);
	const now = await hits();
	ok(
		`${label}: neither document was requested again`,
		now[0] === hitsBefore[0] && now[1] === hitsBefore[1],
		`${hitsBefore} -> ${now}`,
	);
}

/** the state tab's window minimized and restored (from the panel's entry) */
async function checkMinimized(page, label, before, hitsBefore) {
	const frame = await tagged(page, 'state');
	await page.evaluate(() => {
		const state = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'state',
		);
		// its window: around it, or (laid over it) the one on top
		const win =
			state.closest('.vo-window') ??
			document.querySelector('#vibeos-root .vo-window.vo-active');
		win.dispatchEvent(new PointerEvent('pointerdown'));
		window.__vibeWindow = win;
	});
	await frame.evaluate(() => {
		const input = document.getElementById('typed');
		// where it is: the page stays scrolled
		input.focus({ preventScroll: true });
		input.setSelectionRange(0, 5);
	});
	const inFrame = () =>
		frame.evaluate(() => ({
			y: Math.round(scrollY),
			focused: document.activeElement?.id ?? null,
			selection: [
				document.getElementById('typed').selectionStart,
				document.getElementById('typed').selectionEnd,
			],
		}));
	const seen = () => {
		const win = window.__vibeWindow;
		const state = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'state',
		);
		const box = state.getBoundingClientRect();
		return {
			minimized: win.hidden,
			display: getComputedStyle(win).display,
			visibility: getComputedStyle(state).visibility,
			inert: win.inert || state.inert,
			seen: state.checkVisibility({ visibilityProperty: true }),
			laidOut: box.width > 0 && box.height > 0,
			hit:
				document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				) === state,
		};
	};
	await page.evaluate(() =>
		window.__vibeWindow.querySelector('.vo-window-minimize').click(),
	);
	const hidden = await until(
		page,
		seen,
		(v) => v?.minimized && v.visibility === 'hidden' && !v.hit,
		5000,
	);
	const whileHidden = await inFrame();
	ok(
		`${label}: a minimized window is laid out but unseen, inert and not hit`,
		hidden?.minimized &&
			hidden.display !== 'none' &&
			hidden.visibility === 'hidden' &&
			hidden.inert &&
			!hidden.seen &&
			hidden.laidOut &&
			!hidden.hit,
		JSON.stringify(hidden),
	);
	ok(
		`${label}: its frame keeps its scroll, focused input and selection meanwhile`,
		whileHidden.y === 1234 &&
			whileHidden.focused === 'typed' &&
			whileHidden.selection.join() === '0,5',
		JSON.stringify(whileHidden),
	);
	await page.evaluate(() =>
		document.querySelector('#vibeos-root .vo-task-entry').click(),
	);
	const shown = await until(
		page,
		seen,
		(v) => v && !v.minimized && v.hit,
		5000,
	);
	const afterwards = await inFrame();
	ok(
		`${label}: restored, the window is seen and in reach, its frame as it was`,
		shown &&
			!shown.minimized &&
			!shown.inert &&
			shown.seen &&
			shown.hit &&
			afterwards.y === 1234 &&
			afterwards.focused === 'typed' &&
			afterwards.selection.join() === '0,5',
		`${JSON.stringify(shown)} ${JSON.stringify(afterwards)}`,
	);
	await checkState(page, `${label}, restored`, before, hitsBefore);
}

const menuIds = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#pmMenu > [role="menuitem"]')]
			.filter((item) => !item.hidden)
			.map((item) => item.id),
	);

/** open two tabs, the state page last (the active one), its state set */
async function openTabs(page) {
	await submitLanding(page, OTHER);
	await waitActive(page, () => document.title === 'Bookmark A');
	await page.evaluate(() => {
		document.querySelector('.frame:not(.hidden)').__vibeTest = 'other';
	});
	await page.click('#recents');
	await page.click('#newTab');
	await submitLanding(page, STATE);
	const frame = await waitActive(
		page,
		() =>
			document.title === 'vibeOS state' &&
			window.count > 3 &&
			frames[0]?.ticks > 3,
	);
	await page.evaluate(() => {
		document.querySelector('.frame:not(.hidden)').__vibeTest = 'state';
	});
	await frame.fill('#typed', 'typed before');
	await frame.evaluate(() => {
		window.__mark = 'alive';
		scrollTo(0, 1234);
	});
	await frame.childFrames()[0].evaluate(() => {
		window.__mark = 'nested alive';
	});
	return frame;
}

// ---- with moveBefore ------------------------------------------------------
{
	const vibeRequests = [];
	// fonts, stylesheets and scripts asked of anywhere but the demo and the
	// fixture (the landing's commit list shows GitHub's avatars, the demo's
	// own, whatever vibeOS does)
	const foreign = [];
	// the documents the page loads (a frame's, the address the browser has
	// for it) that name vibeOS or its files
	const named = [];
	const page = await openDemo(browser, HOST, {}, (p) =>
		p.on('request', (request) => {
			const url = new URL(request.url());
			if (url.pathname.startsWith(VIBE.base)) vibeRequests.push(url.href);
			if (
				['font', 'stylesheet', 'script'].includes(request.resourceType()) &&
				/^https?:$/.test(url.protocol) &&
				![new URL(HOST).origin, new URL(FIXTURE).origin].includes(url.origin)
			)
				foreign.push(url.href);
			if (
				request.resourceType() === 'document' &&
				/vibe|appfiles|tetris|index\.html/i.test(url.pathname)
			)
				named.push(url.href);
		}),
	);
	ok(
		"vibeOS's directory and its pages' names are neutral",
		NEUTRAL.test(VIBE.base.slice(1)) &&
			Object.keys(VIBE.pages).length >= 3 &&
			Object.values(VIBE.pages).every((name) => NEUTRAL.test(name)),
		JSON.stringify(VIBE),
	);
	page.on('pageerror', (error) => errors.push(error.message));
	if (process.env.VIBE_DEBUG)
		page.on('console', (m) => console.log('console:', m.type(), m.text()));
	if (process.env.VIBE_DEBUG)
		page.on('pageerror', (e) => console.log('pageerror:', e.stack));
	if (process.env.VIBE_DEBUG)
		page.on('response', (r) => {
			if (r.status() >= 400) console.log('http', r.status(), r.url());
		});
	const shown = await page.evaluate(() => ({
		atomic: typeof Element.prototype.moveBefore === 'function',
		button: !document.getElementById('vibeSwitch').hidden,
		item: !document.getElementById('menuVibe').hidden,
		root: !!document.getElementById('vibeos-root'),
	}));
	ok('the browser has moveBefore', shown.atomic);
	ok(
		'the tab manager has the vibeOS button and the menu its item',
		shown.button && shown.item,
		JSON.stringify(shown),
	);
	await openTabs(page);
	const pmMenu = await (async () => {
		await page.click('#toolMenu');
		const ids = await menuIds(page);
		await page.keyboard.press('Escape');
		return ids;
	})();
	ok(
		'nothing of vibeOS was requested before the switch',
		vibeRequests.length === 0 && !shown.root,
		vibeRequests.join(' '),
	);
	const dialed = await page.evaluate(() =>
		[...document.querySelectorAll('.frame')].map((f) => f.src),
	);
	ok(
		'the tabs are dialed: no frame address names the site',
		dialed.every((src) => !/vibeos-state|bookmark-a/.test(src)),
		dialed.join(' '),
	);
	const hitsBefore = await hits();
	const before = await stateOf(page);

	// the tab manager, its middle card the state tab, then the switch
	await page.click('#recents');
	await until(
		page,
		() => document.body.classList.contains('recents-visible'),
		Boolean,
	);
	const started = Date.now();
	await page.click('#vibeSwitch');
	await until(page, () => document.body.classList.contains('vibeos'), Boolean);
	const firstSwitch = Date.now() - started;
	const placed = await page.evaluate(() => {
		const windows = [...document.querySelectorAll('#vibeos-root .vo-window')];
		const state = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'state',
		);
		const other = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'other',
		);
		const active = document.querySelector('#vibeos-root .vo-window.vo-active');
		return {
			windows: windows.length,
			stateIn: !!state?.closest('.vo-window'),
			otherIn: !!other?.closest('.vo-window'),
			focused: !!active?.contains(state),
			recents: document.body.className,
			cardsLeft: document.querySelectorAll(
				'#recentsLabels .cardLabel.expanding',
			).length,
			rootShown: !document.getElementById('vibeos-root').hidden,
		};
	});
	ok(
		'every tab is a vibeOS window holding its own frame element',
		placed.windows === 2 &&
			placed.stateIn &&
			placed.otherIn &&
			placed.rootShown,
		JSON.stringify(placed),
	);
	ok(
		"the tab manager's middle card is the focused window",
		placed.focused,
		JSON.stringify(placed),
	);
	ok(
		'no card animates back to full screen: the tab manager is gone at once',
		!/\brecents/.test(placed.recents) && placed.cardsLeft === 0,
		placed.recents,
	);
	console.log(`first switch (module load included): ${firstSwitch} ms`);
	await checkState(page, 'into vibeOS', before, hitsBefore);
	const font = await page.evaluate(() => ({
		title: getComputedStyle(
			document.querySelector('#vibeos-root .vo-window.vo-active'),
		).fontFamily,
		loaded: [...document.fonts]
			.filter((face) => face.family.replace(/"/g, '') === 'Open Sans')
			.filter((face) => face.status === 'loaded')
			.map((face) => face.weight),
		shown: document.fonts.check('16px "Open Sans"', 'vibeOS'),
	}));
	const fontFiles = vibeRequests.filter((url) =>
		url.startsWith(`${new URL(HOST).origin}${VIBE.base}fonts/open-sans/`),
	);
	ok(
		"vibeOS's own font is loaded from its directory before the desktop shows",
		/^"?Open Sans"?,/.test(font.title) &&
			['400', '600', '700'].every((weight) => font.loaded.includes(weight)) &&
			font.shown &&
			fontFiles.length >= 3,
		`${JSON.stringify(font)} ${fontFiles.join(' ')}`,
	);
	const moving = await page.evaluate(() => {
		const win = document.querySelector('#vibeos-root .vo-window.vo-active');
		return [win, win.querySelector('.vo-window-title, .vibe-browser-panel')]
			.filter(Boolean)
			.map((node) => getComputedStyle(node).transitionDuration);
	});
	ok(
		"vibeOS's windows take none of the demo's transitions: a drag is followed at once",
		moving.length && moving.every((duration) => duration === '0s'),
		moving.join(' '),
	);
	ok(
		'no font, stylesheet or script was asked of another site',
		foreign.length === 0,
		foreign.join(' '),
	);

	// vibeOS's browser menu is the demo's menu
	await page.click(
		'#vibeos-root .vo-window.vo-active .vibe-browser-menu-toggle',
	);
	const vibeMenu = await page.evaluate(() => ({
		open: !document.getElementById('pmMenu').classList.contains('hidden'),
		own: !!document.querySelector(
			'#vibeos-root .vibe-browser-menu:not([hidden])',
		),
	}));
	const vibeIds = await menuIds(page);
	ok(
		"vibeOS's browser menu is the demo's menu, the same items",
		vibeMenu.open &&
			!vibeMenu.own &&
			JSON.stringify(vibeIds) === JSON.stringify(pmMenu) &&
			vibeIds.includes('menuVibe'),
		`${JSON.stringify(vibeIds)} vs ${JSON.stringify(pmMenu)}`,
	);
	await page.keyboard.press('Escape');

	// a tab vibeOS's browser opens is the demo's
	const framesBefore = await page.evaluate(
		() => document.querySelectorAll('iframe.frame').length,
	);
	await page.click('#vibeos-root .vo-window.vo-active .vibe-browser-new-tab');
	await page.fill(
		'#vibeos-root .vo-window.vo-active .vibe-browser-address',
		OTHER,
	);
	await page.press(
		'#vibeos-root .vo-window.vo-active .vibe-browser-address',
		'Enter',
	);
	const opened = await until(
		page,
		() => {
			const active = document.querySelector(
				'#vibeos-root .vo-window.vo-active',
			);
			const frame = active?.querySelector(
				'.vibe-browser-panel:not([hidden]) iframe.frame',
			);
			try {
				return {
					count: document.querySelectorAll('iframe.frame').length,
					title: frame?.contentDocument?.title ?? null,
				};
			} catch {
				return {
					count: document.querySelectorAll('iframe.frame').length,
					title: null,
				};
			}
		},
		(v) => v?.title === 'Bookmark A',
	);
	ok(
		"a tab vibeOS's browser opens is a tab of the demo's",
		opened?.count === framesBefore + 1 && opened.title === 'Bookmark A',
		JSON.stringify(opened),
	);

	// a dialed navigation in the other tab's window: its next frame is the window's
	await page.evaluate(() => {
		const other = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'other',
		);
		other.closest('.vo-window').dispatchEvent(new PointerEvent('pointerdown'));
	});
	await page.fill(
		'#vibeos-root .vo-window.vo-active .vibe-browser-address',
		NEXT,
	);
	await page.press(
		'#vibeos-root .vo-window.vo-active .vibe-browser-address',
		'Enter',
	);
	const swapped = await until(
		page,
		() => {
			const active = document.querySelector(
				'#vibeos-root .vo-window.vo-active',
			);
			const shown = [...active.querySelectorAll('iframe.frame')].filter(
				(f) => f.style.display !== 'none',
			);
			let title = null;
			try {
				title = shown[0]?.contentDocument?.title ?? null;
			} catch {
				// cross-origin in isolated mode
			}
			return {
				shown: shown.length,
				title,
				loose: [...document.getElementById('frames').children].filter(
					(f) => f.style.display !== 'none',
				).length,
			};
		},
		(v) => v?.title === 'Bookmark B',
	);
	ok(
		"a dialed navigation's next frame is in the window",
		swapped?.title === 'Bookmark B' &&
			swapped.shown === 1 &&
			swapped.loose === 0,
		JSON.stringify(swapped),
	);

	// the state tab's window on top, the state tab its tab on show (the
	// new tab opened in it is), then back to the demo's view
	await page.evaluate(() => {
		const state = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'state',
		);
		state.closest('.vo-window').dispatchEvent(new PointerEvent('pointerdown'));
		const panel = state.closest('.vibe-browser-panel');
		document.querySelector(`[aria-controls="${panel.id}"]`).click();
	});
	await page.click('#vibeos-root .vo-leave');
	const back = await page.evaluate(() => {
		const frames = document.getElementById('frames');
		const state = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'state',
		);
		return {
			vibeos: document.body.classList.contains('vibeos'),
			rootHidden: document.getElementById('vibeos-root').hidden,
			all: [...document.querySelectorAll('iframe.frame')].every(
				(f) => f.parentNode === frames,
			),
			count: frames.querySelectorAll('iframe.frame').length,
			stateShown: !state.classList.contains('hidden'),
			browsing: !document
				.getElementById('browser')
				.classList.contains('hidden'),
		};
	});
	ok(
		"back in the demo's view every frame is a tab of its again, the focused window's on screen",
		!back.vibeos &&
			back.rootHidden &&
			back.all &&
			back.count === 3 &&
			back.stateShown &&
			back.browsing,
		JSON.stringify(back),
	);
	await checkState(page, 'back from vibeOS', before, hitsBefore);
	// in the background (another tab on screen) the tab keeps its scroll,
	// out of sight, out of reach and out of the accessibility tree
	const background = await page.evaluate(() => {
		const state = tabs.find((t) => t.element.__vibeTest === 'state');
		activateTab(tabs.find((t) => t !== state));
		const style = getComputedStyle(state.element);
		const box = state.element.getBoundingClientRect();
		return {
			visibility: style.visibility,
			display: style.display,
			inert: state.element.inert,
			hit:
				document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				) === state.element,
		};
	});
	ok(
		'a background tab is laid out but unseen, inert and not hit',
		background.visibility === 'hidden' &&
			background.display !== 'none' &&
			background.inert &&
			!background.hit,
		JSON.stringify(background),
	);
	await checkState(page, 'a background tab', before, hitsBefore);
	await page.evaluate(() =>
		activateTab(tabs.find((t) => t.element.__vibeTest === 'state')),
	);
	await page.click('#toolMenu');
	const again = await menuIds(page);
	await page.keyboard.press('Escape');
	ok(
		"the demo's own menu has the same items",
		JSON.stringify(again) === JSON.stringify(pmMenu),
		JSON.stringify(again),
	);

	// a second switch, from the menu: nothing fetched, the windows where they were
	const fetched = vibeRequests.length;
	const t0 = Date.now();
	await page.click('#toolMenu');
	await page.click('#menuVibe');
	await until(page, () => document.body.classList.contains('vibeos'), Boolean);
	const secondSwitch = Date.now() - t0;
	const windows = await page.evaluate(
		() => document.querySelectorAll('#vibeos-root .vo-window').length,
	);
	ok(
		'a second switch fetches nothing of vibeOS',
		vibeRequests.slice(fetched).every((url) => !/\/embed\.(js|css)/.test(url)),
		vibeRequests.slice(fetched).join(' '),
	);
	ok(
		'the tabs come back in the windows they were in',
		windows === 2,
		`${windows} windows`,
	);
	console.log(`second switch: ${secondSwitch} ms`);
	await checkState(page, 'into vibeOS again', before, hitsBefore);

	// a game's window: its frame's address is its neutral name, under the
	// neutral directory
	await page.click('#vibeos-root .vo-applications:not(.vo-leave)');
	await page.evaluate(() =>
		[...document.querySelectorAll('#vibeos-root .vo-menu-item')]
			.find((item) => item.textContent.trim() === 'Tetris')
			.click(),
	);
	const game = await until(
		page,
		() => {
			const frame = document.querySelector('#vibeos-root .vo-web-app-frame');
			try {
				return {
					src: frame.src,
					href: frame.contentWindow.location.href,
					title: frame.contentDocument.title,
					canvas: !!frame.contentDocument.getElementById('canvas'),
				};
			} catch {
				return null;
			}
		},
		(v) => v?.canvas,
	);
	const gameAt = `${new URL(HOST).origin}${VIBE.base}${VIBE.pages['/appfiles/tetris/index.html']}`;
	ok(
		"a game's frame has a neutral address: neither vibeOS nor the game's",
		game?.canvas && game.src === gameAt && game.href === gameAt,
		JSON.stringify(game),
	);
	await page.evaluate(() =>
		document
			.querySelector('#vibeos-root .vo-web-app-frame')
			.closest('.vo-window')
			.querySelector('.vo-window-close')
			.click(),
	);
	await checkMinimized(page, 'minimized', before, hitsBefore);
	ok(
		'no document the page loaded has an address that names vibeOS or its files',
		named.length === 0 && vibeRequests.length > 0,
		named.join(' '),
	);
	await page.click('#vibeos-root .vo-leave');
	await page.close();
}

// ---- without moveBefore -----------------------------------------------------
{
	const page = await openDemo(browser, HOST, {}, (p) =>
		p.addInitScript(() => {
			delete Element.prototype.moveBefore;
		}),
	);
	page.on('pageerror', (error) => errors.push(error.message));
	await openTabs(page);
	const hitsBefore = await hits();
	const before = await stateOf(page);
	await page.click('#recents');
	await until(
		page,
		() => document.body.classList.contains('recents-visible'),
		Boolean,
	);
	await page.click('#vibeSwitch');
	await until(page, () => document.body.classList.contains('vibeos'), Boolean);
	const laid = await until(
		page,
		() => {
			const state = [...document.querySelectorAll('iframe')].find(
				(f) => f.__vibeTest === 'state',
			);
			const active = document.querySelector(
				'#vibeos-root .vo-window.vo-active',
			);
			const panel = active?.querySelector('.vibe-browser-panel:not([hidden])');
			if (!state || !panel) return null;
			const a = state.getBoundingClientRect();
			const b = panel.getBoundingClientRect();
			const at = document.elementFromPoint(
				b.left + b.width / 2,
				b.top + b.height / 2,
			);
			return {
				inFrames: state.parentNode === document.getElementById('frames'),
				over:
					Math.abs(a.left - b.left) < 2 &&
					Math.abs(a.top - b.top) < 2 &&
					Math.abs(a.width - b.width) < 2 &&
					Math.abs(a.height - b.height) < 2,
				hit: at === state,
			};
		},
		(v) => v?.over && v.hit,
		10000,
	);
	ok(
		'without moveBefore the frame stays put and is laid over its window, on top',
		laid?.inFrames && laid.over && laid.hit,
		JSON.stringify(laid),
	);
	await checkMinimized(
		page,
		'without moveBefore, minimized',
		before,
		hitsBefore,
	);
	await checkState(page, 'without moveBefore, into vibeOS', before, hitsBefore);
	await page.click('#vibeos-root .vo-leave');
	const restored = await page.evaluate(() => {
		const state = [...document.querySelectorAll('iframe')].find(
			(f) => f.__vibeTest === 'state',
		);
		return {
			style: state.getAttribute('style') ?? '',
			shown: !state.classList.contains('hidden'),
		};
	});
	ok(
		'without moveBefore, back: the frame has its own place again',
		restored.shown && !/fixed/.test(restored.style),
		JSON.stringify(restored),
	);
	await checkState(page, 'without moveBefore, back', before, hitsBefore);
	await page.close();
}

// ---- the emulator ------------------------------------------------------------
{
	ok(
		'dist/vibeos/ carries no emulator (v86 and its relay are fetched when used)',
		!existsSync(`${root}dist/vibeos/scripts`),
	);
	// the pinned sources vibeOS names, and the files it pins (the same bytes
	// its own site serves from scripts/v86/)
	const vibe = `${root}vendor/vibeOS/`;
	const source = readFileSync(`${vibe}src/dom/v86files.ts`, 'utf8');
	const base = (name) =>
		new RegExp(`const ${name} = '([^']+)'`).exec(source)[1];
	const v86 = `${vibe}scripts/v86/`;
	const PINNED = [
		[`${base('release')}libv86.js`, `${v86}libv86.js`],
		[`${base('release')}v86.wasm`, `${v86}v86.wasm`],
		[`${base('bios')}seabios.bin`, `${v86}bios/seabios.bin`],
		[`${base('bios')}vgabios.bin`, `${v86}bios/vgabios.bin`],
		[`${base('images')}freedos722.img`, `${v86}images/freedos722.img`],
	];
	const CORE = PINNED[0][0];
	const CACHE = /const cacheName = '([^']+)'/.exec(source)[1];
	const own = [new URL(HOST).origin, new URL(FIXTURE).origin];

	/** a page with vibeOS's fetch recorded (and answered by `answer` when set) */
	async function emulatorPage() {
		const direct = [];
		const page = await openDemo(browser, HOST, {}, (p) =>
			p.on('request', (request) => {
				const url = new URL(request.url());
				if (/^(https?|wss?):$/.test(url.protocol) && !own.includes(url.origin))
					direct.push(url.href);
			}),
		);
		page.on('pageerror', (error) => errors.push(error.message));
		await page.evaluate(() => {
			window.__v86Asked = [];
			const real = vibeHost.fetch;
			vibeHost.fetch = (url, init) => {
				window.__v86Asked.push(url);
				return window.__v86Answer
					? window.__v86Answer(url, init)
					: real(url, init);
			};
		});
		await submitLanding(page, OTHER);
		await waitActive(page, () => document.title === 'Bookmark A');
		await page.click('#toolMenu');
		await page.click('#menuVibe');
		await until(
			page,
			() => document.body.classList.contains('vibeos'),
			Boolean,
		);
		return { page, direct };
	}
	const openEmulator = (page) =>
		page.evaluate(() =>
			[...document.querySelectorAll('#vibeos-root .vo-menu-item')]
				.find((item) => item.textContent.trim() === 'Emulator')
				.click(),
		);
	const status = (page, want, timeout) =>
		until(
			page,
			() =>
				document.querySelector('#vibeos-root .vibe-emulator-status')
					?.textContent ?? '',
			want,
			timeout,
		);
	const cached = (page) =>
		page.evaluate(async (name) => {
			const cache = await caches.open(name);
			return (await cache.keys()).map((request) => request.url).sort();
		}, CACHE);

	// in Cache Storage already, the core tampered with: it is not run, and
	// its source (answering the same) does not get it run either
	const { page, direct } = await emulatorPage();
	await page.evaluate(
		async ({ name, files, core }) => {
			const cache = await caches.open(name);
			for (const [url, data] of files)
				await cache.put(
					url,
					new Response(
						url === core
							? 'window.__tampered = true;'
							: Uint8Array.fromBase64(data),
					),
				);
			window.__v86Answer = async (url) =>
				url === core
					? new Response('window.__tampered = true;')
					: new Response(null, { status: 503 });
		},
		{
			name: CACHE,
			core: CORE,
			files: PINNED.map(([url, file]) => [
				url,
				readFileSync(file).toString('base64'),
			]),
		},
	);
	await openEmulator(page);
	const refused = await status(page, (text) => /^Cannot start/.test(text));
	const after = await page.evaluate(() => ({
		tampered: window.__tampered ?? false,
		asked: window.__v86Asked,
		v86: typeof window.V86,
	}));
	ok(
		'a core whose SHA-256 is not the pinned one is never run',
		/libv86\.js is not the pinned file/.test(refused) &&
			!after.tampered &&
			after.v86 === 'undefined' &&
			after.asked.includes(CORE),
		`${refused} ${JSON.stringify(after)}`,
	);
	ok(
		'the tampered entry is dropped from Cache Storage',
		!(await cached(page)).includes(CORE),
	);
	// the pinned core in the cache: FreeDOS boots with nothing fetched
	await page.evaluate(
		async ({ name, url, data }) => {
			await (
				await caches.open(name)
			).put(url, new Response(Uint8Array.fromBase64(data)));
			window.__v86Asked = [];
			window.__v86Answer = async () => new Response(null, { status: 503 });
		},
		{
			name: CACHE,
			url: CORE,
			data: readFileSync(PINNED[0][1]).toString('base64'),
		},
	);
	await page.evaluate(() =>
		[...document.querySelectorAll('#vibeos-root .vibe-emulator-menu-item')]
			.find((item) => item.textContent.trim() === 'Run')
			.click(),
	);
	const booted = await status(
		page,
		(text) => text === 'Running FreeDOS',
		60000,
	);
	const local = await page.evaluate(() => ({
		asked: window.__v86Asked,
		v86: typeof window.V86,
	}));
	ok(
		'with the pinned files in Cache Storage the emulator boots and fetches nothing',
		booted === 'Running FreeDOS' &&
			local.v86 === 'function' &&
			local.asked.length === 0,
		`${booted} ${JSON.stringify(local)}`,
	);
	ok(
		'the page asked no other site for anything',
		direct.length === 0,
		direct.join(' '),
	);
	await page.close();

	if (process.env.SKIP_NETWORK === '1')
		console.log("SKIP the emulator's first fetch (SKIP_NETWORK=1)");
	else {
		// a fresh page: the files come through the proxy, verified, and stay
		const { page, direct } = await emulatorPage();
		await openEmulator(page);
		const running = await status(
			page,
			(text) => text === 'Running FreeDOS' || /^Cannot/.test(text),
			120000,
		);
		const asked = await page.evaluate(() => window.__v86Asked);
		ok(
			"a fresh page fetches the emulator's pinned files through the proxy and boots",
			running === 'Running FreeDOS' &&
				JSON.stringify([...asked].sort()) ===
					JSON.stringify(PINNED.map(([url]) => url).sort()),
			`${running} ${JSON.stringify(asked)}`,
		);
		ok(
			'it keeps them in Cache Storage',
			JSON.stringify(await cached(page)) ===
				JSON.stringify(PINNED.map(([url]) => url).sort()),
		);
		ok(
			'the page itself asked no other site for anything',
			direct.length === 0,
			direct.join(' '),
		);
		await page.close();
	}
}

await done(browser, errors);
