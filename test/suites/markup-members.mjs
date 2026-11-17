// Chrome 157's markup insertion members (appendHTML(Unsafe), prependHTML,
// beforeHTML, afterHTML, replaceWithHTML, on Element, ShadowRoot and
// CharacterData) and setHTMLUnsafe's runScripts do proxied what they do
// natively. The members were taken off the page's prototypes (they reached
// the browser's parser with no hook in the way), so a page read them as
// absent, and runScripts was dropped, so a script a page inserted with it
// never ran. test/pages/markup-members.html reads each member's shape, the
// nodes it inserts and where, the URLs as the page reads them, the scripts
// that ran and their text, and the errors of bad receivers, arguments,
// options and parents; compared with the page loaded natively, in both
// modes; and under the page's Trusted Types
// (test/pages/markup-members-tt.html), the default policy asked of each
// Unsafe one with its sink's name. On a Chrome without the members both
// read them as absent.
//
// The stream* forms stay off the prototypes (src/inject/dom/modules/DOMHooks.ts
// MARKUP_INSERTION says why): what the page measures of them natively is
// expected proxied as a Chrome without them reads, each absent and none in
// a prototype's list (`expected`).
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

const PAGES = [
	['', `${FIXTURE}pages/markup-members.html`],
	['trusted types: ', `${FIXTURE}pages/markup-members-tt.html`],
];
const browser = await launch();

const STREAM = /^stream[A-Za-z]*HTML/;
/** what the page should read proxied, from what it read natively: the stream forms absent */
function expected(native) {
	const out = {};
	for (const [key, value] of Object.entries(native)) {
		const [, iface, name] = /^(\w+)\.(\w+)/.exec(key) ?? [];
		if (name && STREAM.test(name)) {
			out[`${iface}.${name}`] = 'absent';
			continue;
		}
		// (the scripts that ran: none of a stream's)
		if (key === 'ran') {
			out[key] = value
				.split(' | ')
				.filter((ran) => !/(^|\.)stream[A-Za-z]*HTML|^stream /.test(ran))
				.join(' | ');
			continue;
		}
		out[key] = / members$/.test(key)
			? value
					.split(',')
					.filter((member) => !STREAM.test(member))
					.join(',')
			: value;
	}
	return out;
}

async function measure(frames) {
	for (let i = 0; i < 160; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(() => window.__members ?? null)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

for (const [label, page] of PAGES) {
	const nativePage = await browser.newPage();
	const nativeErrors = [];
	nativePage.on('pageerror', (error) => nativeErrors.push(error.message));
	await nativePage.goto(page);
	const native = await measure(() => [nativePage.mainFrame()]);
	await nativePage.close();
	ok(
		`${label}natively: the page ran every case`,
		native && !native.error && nativeErrors.length === 0,
		JSON.stringify({ error: native?.error, nativeErrors }),
	);

	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const tab = await openDemo(browser, base);
		await submitLanding(tab, page);
		const proxied = await measure(() =>
			tab.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
		);
		ok(
			`${label}${mode}: the page ran every case`,
			proxied && !proxied.error,
			proxied?.error,
		);
		const want = expected(native ?? {});
		const names = Object.keys(want);
		const differ = names.filter((name) => proxied?.[name] !== want[name]);
		for (const name of differ)
			ok(
				`${label}${mode}: ${name} as natively`,
				false,
				`expected ${JSON.stringify(want[name])} proxied ${JSON.stringify(proxied?.[name])}`,
			);
		ok(
			`${label}${mode}: all ${names.length} cases as natively`,
			names.length > 0 && differ.length === 0,
			`${differ.length} differ`,
		);
		ok(
			`${label}${mode}: no page error`,
			tab.errors.length === 0,
			JSON.stringify(tab.errors),
		);
		await tab.close();
	}
}
await done(browser);
