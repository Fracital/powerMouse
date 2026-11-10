// Hooks that pick an element by its name must not take another kind of
// element for an HTML one: an SVG element made with the name TEMPLATE or
// STYLE (createElementNS keeps the case, and so does an XML document's
// parser) is neither, and HTMLTemplateElement's or HTMLStyleElement's
// accessors throw "Illegal invocation" on it; an XHTML document's template is
// named in lowercase and keeps its children in its content. The pages
// (foreign-names.html and .xhtml, script foreign-names.js) insert, fill and
// serialise such elements; what each returns and what throws is compared
// with the pages loaded natively. Both modes.
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

const browser = await launch();

/** the page's report, from whichever frame holds it */
async function report(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames()) {
			const value = await frame
				?.evaluate(() => window.__foreign)
				.catch(() => null);
			if (value?.done) return value;
		}
		await sleep(250);
	}
	return null;
}

const show = (value) => JSON.stringify(value ?? null);

for (const file of ['foreign-names.html', 'foreign-names.xhtml']) {
	const nativePage = await browser.newPage();
	await nativePage.goto(`${FIXTURE}pages/${file}`);
	const native = await report(() => [nativePage.mainFrame()]);
	await nativePage.close();
	ok(
		`${file} natively: nothing throws`,
		native && Object.keys(native.errors).length === 0,
		show(native),
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		await submitLanding(page, `${FIXTURE}pages/${file}`);
		const state = await report(() => page.frames());
		ok(
			`${mode}: ${file} throws nothing where it does not natively`,
			show(state?.errors) === show(native?.errors),
			`native ${show(native?.errors)}; proxied ${show(state?.errors)}`,
		);
		for (const name of Object.keys(native?.results ?? {}))
			ok(
				`${mode}: ${file} ${name} as natively`,
				show(state?.results?.[name]) === show(native.results[name]),
				`native ${show(native.results[name])}; proxied ${show(state?.results?.[name])}`,
			);
		await page.close();
	}
}
await done(browser);
