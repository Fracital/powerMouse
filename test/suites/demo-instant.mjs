// Opening a site in the demo shows its tab on the very next frame, every way
// a site opens: the home box (Enter), a quick-link tile, a bookmark in the
// home sidebar, a link in the tab manager's dock, a second site from home,
// and a page the fragment names (a reload, the link opened in a new tab).
//  - the first frame painted after the press is the browser view with the
//    tab's frame shown: no frame of the home screen, the tab manager or the
//    bookmarks sidebar in between;
//  - nothing moves on the way: no CSS animation and no transition but a
//    colour's (the sidebar sliding out, the scrim fading, a card growing to
//    full screen were all over the opening page);
//  - a page the fragment names is in the browser view from the document's
//    first frame on, the home screen never drawn, and its tab comes once the
//    controller is up.
// Each frame is read in a requestAnimationFrame callback, which runs after
// the press's task and before that frame's paint: the checks are on frame
// order, never on milliseconds, so a loaded machine only makes them slower.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	sleep,
	waitForServer,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/bookmark-a.html`;
const OTHER = `${FIXTURE}pages/bookmark-b.html`;

const browser = await launch();
const errors = [];

/**
 * In the page before the demo's scripts: every frame's view, from the
 * first one, and whether a press has happened before it (`after`)
 */
function recorder() {
	if (window !== top) return;
	const log = (window.__frames = []);
	window.__pressed = false;
	for (const type of ['click', 'submit'])
		addEventListener(
			type,
			() => {
				if (window.__armed) window.__pressed = true;
			},
			true,
		);
	const visible = (element) => {
		if (!element) return false;
		const style = getComputedStyle(element);
		return (
			style.display !== 'none' &&
			style.visibility !== 'hidden' &&
			element.getClientRects().length > 0
		);
	};
	// a colour's transition is a control's own feedback (hover, disabled);
	// anything else moves or fades something on the screen
	const colour =
		/^(color|background-color|border-(top|right|bottom|left)-color|box-shadow|outline-color|fill|stroke)$/;
	const name = (element) =>
		!element
			? '?'
			: element.id
				? `#${element.id}`
				: `${element.localName}.${[...element.classList].join('.')}`;
	const tick = () => {
		if (document.body && log.length < 2000) {
			const frame = document.querySelector('#frames .frame:not(.hidden)');
			log.push({
				after: window.__pressed,
				home: visible(document.getElementById('landing')),
				browser: visible(document.getElementById('browser')),
				tab: visible(frame),
				recents: document.body.classList.contains('recents'),
				sidebar: visible(document.getElementById('bookmarks')),
				moving: document
					.getAnimations()
					.filter(
						(a) =>
							a.playState === 'running' &&
							!(a.transitionProperty && colour.test(a.transitionProperty)),
					)
					.map(
						(a) =>
							`${a.transitionProperty || a.animationName}@${name(a.effect?.target)}`,
					),
			});
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

const describe = (f) =>
	`${f.home ? 'home' : ''}${f.browser ? (f.tab ? 'tab' : 'browser, no tab') : ''}${f.recents ? '+recents' : ''}${f.sidebar ? '+sidebar' : ''}${f.moving.length ? ` moving ${[...new Set(f.moving)].join(' ')}` : ''}`;

/** the frames from the press on, once `count` of them were drawn */
async function framesAfter(page, count = 20) {
	await page.waitForFunction(
		(count) => window.__frames.filter((f) => f.after).length >= count,
		count,
		{ timeout: 60000 },
	);
	return page.evaluate(() => window.__frames.filter((f) => f.after));
}

/** a press opens the tab on the next frame, with nothing moving on the way */
function checkOpened(name, frames) {
	const first = frames[0];
	ok(
		`${name}: the first frame after the press is the browser view with the tab`,
		first.browser &&
			first.tab &&
			!first.home &&
			!first.recents &&
			!first.sidebar,
		describe(first),
	);
	const other = frames.find(
		(f) => f.home || !f.browser || !f.tab || f.recents || f.sidebar,
	);
	ok(
		`${name}: no later frame shows anything but the tab`,
		!other,
		other && `frame ${frames.indexOf(other)}: ${describe(other)}`,
	);
	const moving = frames.find((f) => f.moving.length);
	ok(
		`${name}: nothing animates over it`,
		!moving,
		moving && `frame ${frames.indexOf(moving)}: ${describe(moving)}`,
	);
}

/** wait until nothing animates (an open sidebar or switcher has settled) */
const settled = (page) =>
	page.waitForFunction(
		() =>
			!document.getAnimations().some((a) => a.playState === 'running') &&
			window.__frames.length > 2,
		null,
		{ timeout: 30000 },
	);

/**
 * A quick link opens a real site: the suite's proxy has no business there,
 * so the frame the press makes is sent to the fixture page instead. The
 * press's own path (navigate, the view, the tab) is untouched.
 */
const toFixture = (page) =>
	page.evaluate((target) => {
		const controller = window.controller;
		const createFrame = controller.createFrame.bind(controller);
		controller.createFrame = (element) => {
			const frame = createFrame(element);
			const go = frame.go.bind(frame);
			frame.go = () => go(target);
			return frame;
		};
	}, PAGE);

const arm = (page) =>
	page.evaluate(() => {
		window.__armed = true;
	});

/** the demo in a context of its own (a second tab of it shares its storage) */
async function demo() {
	await waitForServer(HOST);
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	await context.addInitScript(recorder);
	const page = await context.newPage();
	page.errors = [];
	page.on('pageerror', (error) => page.errors.push(error.message));
	await page.goto(HOST);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	await settled(page);
	return page;
}

/** keep the page's errors, then close its context */
async function close(page) {
	errors.push(...page.errors);
	await page.context().close();
}

// the home box: typed, then Enter
{
	const page = await demo();
	await page.focus('#mainForm input');
	await page.keyboard.insertText(PAGE);
	await arm(page);
	await page.keyboard.press('Enter');
	checkOpened('home box', await framesAfter(page));

	// a second site from home, while the first tab is open
	await page.click('#home');
	await settled(page);
	await page.evaluate(() => {
		window.__frames.length = 0;
		window.__pressed = false;
	});
	await page.focus('#mainForm input');
	await page.keyboard.insertText(OTHER);
	await page.keyboard.press('Enter');
	checkOpened('a second site from home', await framesAfter(page));

	// the fragment names the tab's page: a reload opens it with no frame of
	// home, from the document's first frame
	await page.waitForFunction(() => location.hash.length > 1, null, {
		timeout: 30000,
	});
	const deepLink = page.url();
	for (const [name, open] of [
		['a reload', async () => (await page.reload(), page)],
		[
			'the link in a new tab',
			async () => {
				const tab = await page.context().newPage();
				tab.on('pageerror', (error) => errors.push(error.message));
				await tab.goto(deepLink);
				return tab;
			},
		],
	]) {
		const shown = await open();
		await shown.waitForFunction(
			() => window.__frames?.some((f) => f.tab),
			null,
			{ timeout: 60000 },
		);
		await sleep(300); // and some frames after the tab came
		const frames = await shown.evaluate(() => window.__frames);
		const home = frames.find((f) => f.home || !f.browser);
		ok(
			`${name} at the tab's fragment: no frame shows home`,
			frames.length > 0 && !home,
			home
				? `frame ${frames.indexOf(home)} of ${frames.length}: ${describe(home)}`
				: `${frames.length} frames`,
		);
		const firstTab = frames.findIndex((f) => f.tab);
		ok(
			`${name}: the tab comes and stays`,
			firstTab !== -1 && frames.slice(firstTab).every((f) => f.tab),
			`first tab frame ${firstTab} of ${frames.length}`,
		);
		const moving = frames.find((f) => f.moving.length);
		ok(
			`${name}: nothing animates`,
			!moving,
			moving && `frame ${frames.indexOf(moving)}: ${describe(moving)}`,
		);
		ok(
			`${name}: the tab is on the page`,
			(await shown.inputValue('#omni input').catch(() => '')) === OTHER,
			await shown.inputValue('#omni input').catch(() => ''),
		);
	}
	await close(page);
}

// a quick-link tile on the home screen
{
	const page = await demo();
	await toFixture(page);
	await arm(page);
	await page.click('#button-container > .btn-fancy');
	checkOpened('a quick-link tile', await framesAfter(page));
	await close(page);
}

// a bookmark in the home page's sidebar (it slid in; it does not slide out
// over the page)
{
	const page = await demo();
	await toFixture(page);
	await page.click('#bookmarksTab');
	await page.waitForSelector('#bookmarksList .bookmarkOpen');
	await settled(page);
	await arm(page);
	await page.click('#bookmarksList .bookmarkOpen');
	checkOpened('a bookmark', await framesAfter(page));
	// and the sidebar still slides when it opens and closes by itself
	await page.click('#toolSaved');
	const sliding = await page.evaluate(() =>
		document
			.getElementById('bookmarks')
			.getAnimations()
			.some((a) => a.transitionProperty === 'transform'),
	);
	ok('the sidebar still slides in', sliding);
	await settled(page);
	await page.click('#bookmarksClose');
	const closing = await page.evaluate(() =>
		document
			.getElementById('bookmarks')
			.getAnimations()
			.some((a) => a.transitionProperty === 'transform'),
	);
	ok('and slides out when closed', closing);
	await close(page);
}

// a link in the tab manager's dock, the manager entered from home
{
	const page = await demo();
	await toFixture(page);
	await page.click('#recents');
	await settled(page);
	await arm(page);
	await page.click('#dock > .dockButton');
	checkOpened("a link in the tab manager's dock", await framesAfter(page));
	await close(page);
}

await done(browser, errors);
