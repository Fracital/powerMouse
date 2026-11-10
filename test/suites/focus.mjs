// A page the user navigates to from the address bar has focus: Chrome
// moves it from the omnibox to the page, whose document.hasFocus() is true
// and which gets the keys typed next. Through the demo the address bar kept
// it, so the proxied page read false (browserleaks' JavaScript page showed
// it) and typing went into the address bar. Measured with the demo's own
// address bars as a user drives them (typed, Enter): the landing page's
// (a new tab) and the toolbar's (the same tab), in both modes, against the
// page loaded natively with page.goto, Playwright's address bar.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/focus.html`;

async function report(frame) {
	for (let i = 0; i < 80; i++) {
		const value = await frame()
			?.evaluate(() => window.__focus ?? null)
			.catch(() => null);
		if (value?.loaded) return value;
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const native = await browser.newPage();
await native.goto(`${PAGE}?n=native`);
const nativeReport = await report(() => native.mainFrame());
await native.keyboard.type('ok');
await sleep(300);
const nativeKeys = await native.evaluate(() => window.__focus.keys);
await native.context().close();
ok(
	'natively: the page has focus and gets the keys typed next',
	nativeReport?.atLoad === true && nativeKeys === 'ok',
	JSON.stringify({ nativeReport, nativeKeys }),
);

const newest = (tab) => () =>
	tab
		.frames()
		.filter((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url()))
		.at(-1);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const tab = await openDemo(browser, base);
	// the landing page's address bar: a new tab
	await tab.click('#mainForm input[name=url]');
	await tab.keyboard.type(`${PAGE}?n=landing`);
	await tab.keyboard.press('Enter');
	const landing = await report(newest(tab));
	await sleep(300);
	await tab.keyboard.type('ok');
	await sleep(300);
	const landingKeys = await newest(tab)()?.evaluate(() => window.__focus.keys);
	ok(
		`${mode}: a page opened from the landing page has focus, as natively`,
		landing?.atLoad === nativeReport?.atLoad && landingKeys === nativeKeys,
		JSON.stringify({ landing, landingKeys }),
	);
	// the toolbar's address bar: the same tab
	await tab.click('#omni input');
	await tab.keyboard.press('Control+A');
	await tab.keyboard.type(`${PAGE}?n=omnibox`);
	await tab.keyboard.press('Enter');
	await sleep(500);
	let omnibox = null;
	for (let i = 0; i < 40 && !omnibox; i++) {
		const value = await report(newest(tab));
		if (value?.n === 'omnibox') omnibox = value;
		else await sleep(250);
	}
	await sleep(300);
	await tab.keyboard.type('ok');
	await sleep(300);
	const omniboxKeys = await newest(tab)()?.evaluate(() => window.__focus.keys);
	ok(
		`${mode}: a page reached from the address bar has focus, as natively`,
		omnibox?.atLoad === nativeReport?.atLoad && omniboxKeys === nativeKeys,
		JSON.stringify({ omnibox, omniboxKeys }),
	);
	await tab.context().close();
}

await done(browser);
