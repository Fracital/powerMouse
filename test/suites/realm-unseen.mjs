// A proxied top makes the rewriter library's realm (a frame of its own,
// src/inject/dom/rewriterRealm.ts) the first time a rewrite needs it, which
// may be long after the page's scripts ran (DocumentClient #topLibrary): a
// revisit whose scripts the worker wrote often needs none. Whenever it is
// made, the page must not hear of it: the frame's load event (inserting a
// frame fires it before the insertion returns, and a listener that heard it
// could read the frame's window before the library is in it), a mutation
// record, the window's frames, or a call of a method or getter the page
// replaced. test/pages/realm-unseen.html listens for all of that, then
// evaluates code made from a string for the first time; `?case=child` has
// a frame of its own origin do it, so the top makes the library for a
// frame under it. Everything it reports must be what the same page reports
// natively. Both modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const CASES = ['top', 'child'];
const address = (which) => `${FIXTURE}pages/realm-unseen.html?case=${which}`;
const ready = (which) =>
	`document.title === 'REALM UNSEEN DONE' && JSON.parse(window.__unseen).case === '${which}'`;

const browser = await launch();
const natives = {};
for (const which of CASES) {
	const page = await browser.newPage();
	await page.goto(address(which));
	await page.waitForFunction(ready(which));
	natives[which] = JSON.parse(await page.evaluate(() => window.__unseen));
	await page.close();
}
ok(
	'natively, the page evaluates its code and hears only of its own frame',
	natives.top.results.join() === '2,true' &&
		natives.top.heard.length === 0 &&
		natives.child.heard.join() === 'document:IFRAME,root:IFRAME',
	JSON.stringify(natives),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const tab = await openDemo(browser, base);
	for (const [index, which] of CASES.entries()) {
		await (index === 0 ? submitLanding : submitOmni)(tab, address(which));
		const frame = await waitActive(tab, ready(which));
		const proxied = JSON.parse(await frame.evaluate(() => window.__unseen));
		for (const name of Object.keys(natives[which])) {
			const native = JSON.stringify(natives[which][name]);
			const seen = JSON.stringify(proxied[name]);
			ok(
				`${mode}: ${which}: ${name} as natively`,
				seen === native,
				seen === native ? native : `natively ${native}, proxied ${seen}`,
			);
		}
	}
	ok(`${mode}: no uncaught errors`, !tab.errors.length, tab.errors.join(' | '));
	await tab.close();
}
await done(browser);
