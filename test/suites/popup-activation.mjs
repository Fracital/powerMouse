// Chrome's popup blocker, as a user's Chrome has it (Playwright turns it
// off): a popup opens only with a transient activation, and opening one
// consumes it. A target=_blank link a script clicks as the page loads opens
// nothing, nor does window.open() then (it answers null); a click of the
// user's opens one popup, whether the page's handler calls window.open()
// twice, clicks two target=_blank links, opens one and returns false from a
// link's inline handler, or opens one and then clicks a link. Proxied, the
// demo opens the host's tabs for the page's popups (onOpen): each of these
// opened one, or none, as natively, and the page reads its activation
// consumed as natively. The page loaded natively at the top of a tab, and
// proxied in both modes.
//
// A click's popups are waited for, not read a fixed time after it, and each
// click is sent once the mouse reaches the page's frame: the demo shows each
// tab it opens, so the page's frame is shown again before each click, and
// for a moment after a cross-origin frame (isolated mode) is shown again
// Chrome sends a click there to the host's <iframe> element, never to the
// page (measured on Chrome 157: none of 10 clicks sent as the frame was
// shown reached the page, 6 to 8 of 10 sent 16 ms later, all from 50 ms).
// On a loaded runner Playwright's click came within that moment: in about
// one CI run in eight one isolated step opened nothing, and when it was the
// inline link, its handler had not run either (2026-11-19).
import {
	done,
	evaluateIsolated,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/popup-activation.html`;
const browser = await launch([], { popupBlocker: true });
/** what an opened URL is named by in the page (its query) */
const named = (url) => {
	try {
		return new URL(url).search.slice(1);
	} catch (error) {
		return String(url);
	}
};
/** the user's clicks, each on a button (or link) of the page */
const STEPS = ['twice', 'click', 'clicks', 'inline', 'openThenClick'];
/** the log entries of the steps that open nothing, as `[name, ...values]` */
const BLOCKED = ['load-open', 'timer-open', 'twice'];
/** what opens natively: nothing as the page loads, one for each click */
const EXPECTED = {
	load: [],
	steps: {
		twice: ['twice-1'],
		click: ['user-click'],
		clicks: ['first-click'],
		inline: ['inline-open'],
		openThenClick: ['open-first'],
	},
	after: [],
};
/**
 * How long a click's popups are waited for (a tab the proxy opens takes the
 * relay's round trips, and a loaded runner's more), and how long what
 * opens is then watched for one more
 */
const OPEN_MAX_MS = 15000;
const SETTLE_MS = 1000;

/**
 * Resolves once the page in `page` said its loading steps are done. Read
 * off the console: an evaluation in the page gives it an activation, and
 * one before then would let its steps open what they open with one
 */
const loaded = (page) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, 45000);
		const listener = (message) => {
			if (message.text() !== 'POPUP ACTIVATION LOADED') return;
			page.off('console', listener);
			clearTimeout(timer);
			resolve();
		};
		page.on('console', listener);
	});

/**
 * Resolves once the mouse, moved to the middle of `selector` in `frame`,
 * reached the frame's document (true), or false after OPEN_MAX_MS. A
 * pointermove gives no activation, the browser's or the inject's; the
 * listener is the test's own world's (an evaluation in the page's would
 * give it one)
 */
async function pointerReaches(page, frame, selector) {
	const box = await frame.locator(selector).boundingBox();
	if (!box) return false;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await evaluateIsolated(frame, () => {
		window.__pointerIn = false;
		const note = () => (window.__pointerIn = true);
		const options = { capture: true, once: true };
		document.addEventListener('pointermove', note, options);
	});
	const deadline = Date.now() + OPEN_MAX_MS;
	for (let i = 0; Date.now() < deadline; i++) {
		// a move to where the mouse already is sends no event
		await page.mouse.move(x + (i % 2), y);
		if (await evaluateIsolated(frame, () => window.__pointerIn)) return true;
		await sleep(50);
	}
	return false;
}

/**
 * What opened as the page loaded, for each of the user's clicks and after
 * the last, and the page's log (`opened()` takes what opened since the last
 * call). A click's popups are waited for, as many as open natively, then
 * watched SETTLE_MS more: one more than natively, or one that opens late
 * (in the next step's list, or `after`), still fails the comparison
 */
async function run(frame, opened, between = async () => {}) {
	const take = async (want) => {
		const names = [];
		const deadline = Date.now() + OPEN_MAX_MS;
		while (names.length < want && Date.now() < deadline) {
			await sleep(100);
			names.push(...(await opened()));
		}
		await sleep(SETTLE_MS);
		names.push(...(await opened()));
		return names.sort();
	};
	const result = { load: await take(0), steps: {} };
	for (const step of STEPS) {
		await between(step);
		await frame.click(`#${step}`);
		result.steps[step] = await take(EXPECTED.steps[step].length);
	}
	result.after = await take(0);
	result.log = await frame.evaluate(() => window.__log);
	return result;
}

const nativePage = await browser.newPage();
let popups = [];
nativePage.on('popup', (popup) => popups.push(popup));
const nativeLoaded = loaded(nativePage);
await nativePage.goto(PAGE);
await nativeLoaded;
const native = await run(nativePage.mainFrame(), async () => {
	const taken = popups;
	popups = [];
	const names = [];
	for (const popup of taken) {
		await popup.waitForLoadState('domcontentloaded').catch(() => {});
		names.push(named(popup.url()));
		await popup.close().catch(() => {});
	}
	return names;
});
await nativePage.close();
/** what the comparisons read of a run's result */
const opens = ({ load, steps, after }) =>
	JSON.stringify({ load, steps, after });
ok(
	'natively: nothing opened as the page loaded, and one popup for each click',
	opens(native) === JSON.stringify(EXPECTED),
	JSON.stringify(native),
);
const blocked = (log) =>
	JSON.stringify(log?.filter(([name]) => BLOCKED.includes(name)));
ok(
	'natively: window.open() with no activation answered null, and the activation was consumed',
	blocked(native.log) ===
		JSON.stringify([
			['load-open', true, false],
			['timer-open', true, false],
			['twice', false, true],
		]),
	JSON.stringify(native.log),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const windows = [];
	page.on('popup', (popup) => windows.push(popup.url()));
	await page.evaluate(() => {
		window.__opens = [];
		window.controller.addEventListener('open', (event) =>
			window.__opens.push(event.detail.url),
		);
	});
	const pageLoaded = loaded(page);
	await submitLanding(page, PAGE);
	await pageLoaded;
	// the page's (the demo shows a tab for each it opened)
	let frame = null;
	for (const candidate of page
		.frames()
		.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
		if (await candidate.$('#twice').catch(() => null)) frame = candidate;
	if (!frame) {
		ok(`${mode}: the page loaded`, false);
		await page.close();
		continue;
	}
	const element = await frame.frameElement();
	/** for each click, whether the mouse reached the page's frame before it */
	const reached = {};
	let taken = 0;
	const proxied = await run(
		frame,
		async () => {
			const opens = await page.evaluate(() => window.__opens);
			const names = opens.slice(taken).map(named);
			taken = opens.length;
			return names;
		},
		// the demo shows each tab it opened: the page's tab is shown again
		// for the user's next click, once the host's page has drawn that and
		// the mouse has reached it. The browser sends a click to the frame of
		// another process it last saw drawn at that point (isolated mode): on
		// a busy machine one sent at once reached the tab just hidden
		async (step) => {
			await element.evaluate(async (own) => {
				for (const other of document.querySelectorAll('.frame'))
					other.classList.toggle('hidden', other !== own);
				for (let i = 0; i < 2; i++)
					await new Promise((resolve) => requestAnimationFrame(resolve));
			});
			reached[step] = await pointerReaches(page, frame, `#${step}`);
		},
	);
	ok(
		`${mode}: nothing opened as the page loaded, and one tab for each click, as natively`,
		opens(proxied) === opens(native),
		JSON.stringify({ native, proxied, reached }),
	);
	ok(
		`${mode}: window.open() with no activation answered null, and the activation was consumed, as natively`,
		blocked(proxied.log) === blocked(native.log),
		JSON.stringify(proxied.log),
	);
	ok(
		`${mode}: the browser opened no window`,
		windows.length === 0,
		JSON.stringify(windows),
	);
	await page.close();
}
await done(browser);
