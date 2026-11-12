// A page holds the window of a frame of its own origin; the frame then shows
// another site's document, by each way a frame's document changes. Every
// proxied site is the proxy's one real origin, so the held window used to
// read the new document whole. Natively it is then a cross-origin window.
// Through the proxy a frame that is to show another origin gets a fresh
// browsing context first (src/inject/dom/freshContext.ts): the held window
// reaches nothing of the new document, and the frame's window read again is
// what Chrome gives (SecurityError on reads, the same object as
// contentWindow, a message answered, a location set that brings it back,
// one load event, the referrer it had). A navigation that stays of the
// origin keeps its window, as natively, and a page that sends the event the
// worker's redirect document sends gets nothing. Natively, then through the
// demo in both modes.
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

const target = `${FIXTURE}pages/held-windows.html`;
const SCENARIOS = [
	'the page sets the src',
	'the frame navigates itself',
	'a link in the frame',
	'the held window location set',
	'an about:blank frame held, then a src',
	'an about:blank frame held, then its location set',
	'an about:blank frame held, then window.open aimed at it',
	'an about:blank frame held, then a link aimed at it',
	'an about:blank frame held, then a form aimed at it',
	'a frame of another site navigates itself to this one',
	'a navigation of the same origin',
	'a page that sends the fresh-frame event itself',
	'a redirect to another site',
	"a form's POST in the frame",
	'window.open aimed at the frame',
	'a link of the page with the frame as its target',
];

/** the page's frame (the demo's proxied one, or the page itself) */
async function pageFrame(pages) {
	for (let i = 0; i < 80; i++) {
		for (const frame of pages().flatMap((page) => page.frames()))
			if (
				await frame
					.evaluate(() => typeof window.__run === 'function')
					.catch(() => false)
			)
				return frame;
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const native = {};
for (const name of SCENARIOS) {
	const page = await browser.newPage();
	await page.goto(target);
	native[name] = await page
		.evaluate(([name, tag]) => window.__run(name, tag), [name, 'native'])
		.catch((error) => ({ error: String(error).split('\n')[0] }));
	await page.close();
	ok(`natively: ${name}`, !native[name]?.error, JSON.stringify(native[name]));
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	let serial = 0;
	for (const name of SCENARIOS) {
		await page.click('#home').catch(() => {});
		await submitLanding(page, target);
		const frame = await pageFrame(() => page.context().pages());
		const proxied = frame
			? await frame
					.evaluate(
						([name, tag]) => window.__run(name, tag),
						[name, `${mode}-${++serial}`],
					)
					.catch((error) => ({ error: String(error).split('\n')[0] }))
			: { error: 'no page' };
		const a = JSON.stringify(native[name]);
		const b = JSON.stringify(proxied);
		ok(
			`${mode}: ${name}: the held window reaches nothing of the new document, and the frame reads as natively`,
			a === b,
			`\n      native  ${a}\n      proxied ${b}`,
		);
	}
	// the host's own frame (the demo tab the page is in) is never swapped:
	// the page leaving for another site keeps the tab's window, as a tab's
	// navigation keeps the tab
	await page.click('#home').catch(() => {});
	await submitLanding(page, target);
	const frame = await pageFrame(() => page.context().pages());
	const kept = await page.evaluate(() => {
		const element = document.querySelector('.frame:not(.hidden)');
		window.__heldTab = { element, win: element?.contentWindow };
		return !!element;
	});
	await frame?.evaluate(() => window.__run('leave for another site', 'leave'));
	await sleep(3000);
	const same = await page.evaluate(() => {
		const { element, win } = window.__heldTab;
		return element.isConnected && element.contentWindow === win;
	});
	ok(
		`${mode}: the host's frame keeps its window when its page goes to another site`,
		kept && same,
		JSON.stringify({ kept, same }),
	);
	await page.context().close();
}
await done(browser);
