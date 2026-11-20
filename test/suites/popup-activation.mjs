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
import {
	done,
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
 * What opened as the page loaded and for each of the user's clicks
 * (`opened()` takes what opened since the last call), and the page's log
 */
async function run(frame, opened, between = async () => {}) {
	await sleep(1000);
	const result = { load: (await opened()).sort(), steps: {} };
	for (const step of STEPS) {
		await between();
		await frame.click(`#${step}`);
		await sleep(1000);
		result.steps[step] = (await opened()).sort();
	}
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
const expected = {
	load: [],
	steps: {
		twice: ['twice-1'],
		click: ['user-click'],
		clicks: ['first-click'],
		inline: ['inline-open'],
		openThenClick: ['open-first'],
	},
};
ok(
	'natively: nothing opened as the page loaded, and one popup for each click',
	JSON.stringify({ load: native.load, steps: native.steps }) ===
		JSON.stringify(expected),
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
		// for the user's next click, once the host's page has drawn that.
		// The browser sends a click to the frame of another process it last
		// saw drawn at that point (isolated mode): on a busy machine one
		// sent at once reached the tab just hidden, and the page never had it
		() =>
			element.evaluate(async (own) => {
				for (const other of document.querySelectorAll('.frame'))
					other.classList.toggle('hidden', other !== own);
				for (let i = 0; i < 2; i++)
					await new Promise((resolve) => requestAnimationFrame(resolve));
			}),
	);
	ok(
		`${mode}: nothing opened as the page loaded, and one tab for each click, as natively`,
		JSON.stringify({ load: proxied.load, steps: proxied.steps }) ===
			JSON.stringify({ load: native.load, steps: native.steps }),
		JSON.stringify({ native, proxied }),
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
