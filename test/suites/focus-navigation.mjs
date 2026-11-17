// What a page knows of focus after each way of getting to it, against the
// same page natively: document.hasFocus(), document.activeElement, `:focus`
// and the focus and blur events it saw, at load and a moment later, and
// whether the keys typed next reach it. Ways: the address bar (to the
// page's site and to another), a link to another site, the host's
// frame.go(), and a frame of another site in the page, which focus moves
// into and back out of before it goes to the page's own site.
// With the site pool every proxied top commits in a process of its own
// (another slot's), and a frame that does keeps the browser's focus while
// its new process never hears of it: the page read hasFocus() false where
// a tab's page reads true (natively a frame of a page has that fate, which
// the last check shows, and the proxied frame matches it). The single-origin
// controller (`?nopool`) is checked beside it.
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/focus-nav.html';
const url = (site, n, extra = '') => `${site}${PAGE}?n=${n}${extra}`;

/** the probe's state once the document `n` loaded in `frame()` */
async function loaded(frame, n) {
	for (let i = 0; i < 120; i++) {
		const value = await frame()
			?.evaluate(() => window.__focus ?? null)
			.catch(() => null);
		if (value?.loaded && value.n === n) return value;
		await sleep(250);
	}
	return null;
}
/** what the document knows of focus now, and the events it saw since the last look */
const now = (frame) =>
	frame()
		?.evaluate(() => ({
			...window.__focus.now(),
			events: window.__focus.events.splice(0),
		}))
		.catch((error) => String(error));
const keys = (frame) => frame()?.evaluate(() => window.__focus.keys);

async function scenarios(tab, top, child, nav) {
	const out = {};
	const arrive = async (name, n) => {
		const state = await loaded(top, n);
		await sleep(300);
		out[name] = {
			atLoad: state?.atLoad,
			events: state?.events,
			later: await now(top),
		};
	};
	await nav.typed(url(A, 'typed'));
	await arrive('typed', 'typed');
	await tab.keyboard.type('ok');
	await sleep(300);
	out.typed.keys = await keys(top);
	await nav.typed(url(B, 'typed-b'));
	await arrive('typed to another site', 'typed-b');
	await nav.typed(
		url(A, 'link', `&to=${encodeURIComponent(url(B, 'linked'))}`),
	);
	await loaded(top, 'link');
	await top().click('#to');
	await arrive('a link to another site', 'linked');
	await tab.keyboard.type('ok');
	await sleep(300);
	out['a link to another site'].keys = await keys(top);
	// the host's frame.go() (natively: the tab navigated again)
	await nav.go(url(A, 'go'));
	await arrive('frame.go() to another site', 'go');
	// a frame of another site in the page
	await nav.typed(
		url(
			A,
			'parent',
			`&child=${encodeURIComponent(url(B, 'child', `&to=${encodeURIComponent(url(A, 'child-a'))}`))}`,
		),
	);
	await loaded(top, 'parent');
	await loaded(child, 'child');
	await sleep(300);
	await now(top);
	await now(child);
	await child().click('#field');
	await sleep(300);
	out['focus into the frame'] = {
		top: await now(top),
		child: await now(child),
	};
	await top().click('#field');
	await sleep(300);
	out['and back to the page'] = {
		top: await now(top),
		child: await now(child),
	};
	await child().click('#to');
	const moved = await loaded(child, 'child-a');
	await sleep(300);
	out['the frame goes to the page site'] = {
		atLoad: moved?.atLoad,
		top: await now(top),
		child: await now(child),
	};
	return out;
}

const browser = await launch();
const native = await browser.newPage();
const nativeTop = () => native.mainFrame();
const nativeResults = await scenarios(
	native,
	nativeTop,
	() => native.frames().find((frame) => frame.parentFrame() === nativeTop()),
	{ typed: (to) => native.goto(to), go: (to) => native.goto(to) },
);
await native.context().close();
ok(
	'natively: a page reached from the address bar or a link has focus and gets the keys',
	nativeResults.typed.atLoad?.hasFocus === true &&
		nativeResults['a link to another site'].atLoad?.hasFocus === true &&
		nativeResults.typed.keys === 'ok',
	JSON.stringify(nativeResults.typed),
);

const ROUTED = /\/stomp\/[\w-]+\/html\//;
for (const [mode, base] of [
	['default', PROXY],
	['single origin', `${PROXY}?nopool`],
]) {
	const tab = await openDemo(browser, base);
	const pool = await tab.evaluate(() => window.controller.siteMode);
	const label = mode === 'default' ? (pool ? 'pool' : 'same-origin') : mode;
	const top = () =>
		tab
			.frames()
			.filter(
				(frame) =>
					ROUTED.test(frame.url()) && !ROUTED.test(frame.parentFrame()?.url()),
			)
			.at(-1);
	const child = () =>
		tab.frames().find((frame) => frame.parentFrame() === top());
	let first = true;
	const nav = {
		async typed(to) {
			if (first) {
				first = false;
				await tab.click('#mainForm input[name=url]');
			} else {
				await tab.click('#omni input');
				await tab.keyboard.press('Control+A');
			}
			await tab.keyboard.type(to);
			await tab.keyboard.press('Enter');
		},
		go: (to) =>
			tab.evaluate((to) => {
				const element = document.querySelector('.frame:not(.hidden)');
				window.controller.frames.find((f) => f.element === element).go(to);
			}, to),
	};
	const results = await scenarios(tab, top, child, nav);
	for (const [way, value] of Object.entries(results)) {
		const expected = nativeResults[way];
		ok(
			`${label}: ${way}: focus as natively`,
			JSON.stringify(value) === JSON.stringify(expected),
			`${JSON.stringify(value)} (natively ${JSON.stringify(expected)})`,
		);
	}
	// a document never takes focus from the host's controls: the host's
	// address bar has it while frame.go() loads another site
	await nav.typed(url(A, 'before-steal'));
	await loaded(top, 'before-steal');
	await tab.click('#omni input');
	await nav.go(url(B, 'steal'));
	const steal = await loaded(top, 'steal');
	await sleep(300);
	const host = await tab.evaluate(() => [
		document.activeElement?.closest('#omni') !== null,
		document.hasFocus(),
	]);
	ok(
		`${label}: a page loaded while the host's controls have focus leaves it there`,
		steal?.atLoad?.hasFocus === false && host[0] && host[1],
		JSON.stringify({ steal, host }),
	);
	await tab.context().close();
}
await done(browser);
