// Frames a page makes keep their names and, when the browser keeps the
// initial about:blank's Window for the document of a frame's src (the page
// read contentWindow at once), their own URL and their own messages: a
// child's window.name is the name the page gave it, its sibling is found by
// name in the parent's frames, its location is its own document's, and the
// parent's message event names that child as the source. Every proxied
// frame's name read as empty, so a sibling looked up by name was missing
// (reCAPTCHA's `parent.frames[name].postMessage` read undefined); and a
// client the parent injected into the initial about:blank stayed on the
// kept Window and ran the new document from the parent's realm, which gave
// the document the parent's URL and its messages the parent as their source
// (reCAPTCHA's widget timed out). Both modes, against the page loaded
// natively.
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
const PAGE = `${FIXTURE}pages/frame-reuse.html`;

async function measure(getFrame) {
	for (let i = 0; i < 60; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__reuse?.done ? window.__reuse : null))
			.catch(() => null);
		if (report) {
			report.messages.sort((a, b) => a.from.localeCompare(b.from));
			return report;
		}
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: both children report their name, URL and sibling, and are named as the source',
	native?.messages.length === 2 &&
		native.messages.every((m) => m.sibling === 'found' && m.source >= 0) &&
		native.byName.first &&
		native.byName.second,
	JSON.stringify(native),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	// the outer page: its frames are its children
	const proxied = await measure(() =>
		page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			.find((f) => f.parentFrame() === frameOf(page)?.parentFrame()),
	);
	for (const [name, pick] of [
		[
			"each child's name and URL",
			(r) => r?.messages.map((m) => [m.from, m.url]),
		],
		[
			'each child finds its sibling by name',
			(r) => r?.messages.map((m) => [m.from, m.sibling]),
		],
		[
			"the parent's message names the sending child as its source",
			(r) => r?.messages.map((m) => [m.from, m.source]),
		],
		['the parent finds each child by name', (r) => r?.byName],
	])
		ok(
			`${mode}: ${name}, as natively`,
			JSON.stringify(pick(proxied)) === JSON.stringify(pick(native)),
			`native ${JSON.stringify(pick(native))} proxied ${JSON.stringify(pick(proxied))}`,
		);
	await page.close();
}

await done(browser);
