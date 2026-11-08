// Custom elements and markup strings (custom-elements.html): a defined
// element in a template's markup is inert until the page stamps it, as
// Polymer and YouTube do once they have taken the "[[...]]" bindings off
// its attributes. The page's log of every constructor and attribute
// callback, and what each template ends up holding, are compared with the
// page loaded natively, in both demo modes. Before, the hooks made a
// template's elements in the page's document, so each one was constructed
// with the binding still on it (YouTube's watch-next renderer threw
// "E.some is not a function" reading it), and a shadow root's markup was
// constructed twice.
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

const target = `${FIXTURE}pages/custom-elements.html`;
const read = () => (window.__ce?.done ? window.__ce.cases : null);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await nativePage.evaluate(read);
await nativePage.close();
ok(
	'natively, a template stamps only the bound elements',
	native?.['template innerHTML']?.log.every(
		(entry) => !entry.startsWith('threw'),
	) === true,
	JSON.stringify(native?.['template innerHTML']),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	// a slow runner can take more than ten seconds to show the frame
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		proxied = await frame?.evaluate(read).catch(() => null);
	}
	ok(`${mode}: the page finishes through the proxy`, !!proxied);
	for (const name of Object.keys(native ?? {})) {
		const a = JSON.stringify(native[name]);
		const b = JSON.stringify(proxied?.[name]);
		ok(
			`${mode}: ${name} constructs and reads as natively`,
			a === b,
			a === b ? a.slice(0, 160) : `native ${a} proxied ${b}`,
		);
	}
	await page.close();
}
await done(browser);
