// Browsing context names, natively and through the proxy in both demo
// modes: within a tab, window.open('', name) finds the page's frames and
// its cross-site child's (another site's window stays out of reach), and
// that child finds its own frame but not its sibling of another site; a
// second tab of another site, which the first never
// opened, finds none of the first tab's frames by name and gets a new
// window, as natively (every proxied tab is a frame of one host page, so
// the browser would otherwise find them all). Navigations aimed by name, a
// child's and another tab's, reach what they reach natively.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	SLOT_PORTS,
	submitLanding,
} from '../lib.mjs';

// Checks that fail on purpose, each with its reason: one that passes again
// fails (the entry is stale and goes)
const KNOWN_OPEN = {
	// the document's named properties come before anything definable
	// (Context.ts exposeNames, window-references documentName)
	'the first tab: document named kidb':
		"another site's raw window through the document's named iframe",
};

const browser = await launch();
const cross = FIXTURE.replace('127.0.0.1', 'localhost');

/** the cases the page `which` reported, from whichever frame reports them */
async function read(page, which) {
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		for (const frame of page.frames().reverse()) {
			const value = await frame.evaluate(() => window.__pi).catch(() => null);
			if (value?.done && value.page === which) return value.cases;
		}
	}
	return null;
}

const context = await browser.newContext();
const first = await context.newPage();
await first.goto(`${FIXTURE}pages/names-a.html`);
const nativeA = await read(first, 'a');
const second = await context.newPage();
await second.goto(`${cross}pages/names-c.html`);
const nativeC = await read(second, 'c');
await sleep(2000);
/** where the first tab's named frames are once the other tab aimed at them (as its page reads them) */
const aimed = async (page) => {
	for (const frame of page.frames()) {
		const named = await frame
			.evaluate(() => window.__named?.() ?? null)
			.catch(() => null);
		if (named) return named;
	}
	return null;
};
const nativeAimed = await aimed(first);
await context.close();
ok(
	'natively, both tabs reported',
	nativeA && nativeC,
	JSON.stringify({ nativeA, nativeC }),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/names-a.html`);
	const a = await read(page, 'a');
	await page.click('#home');
	await submitLanding(page, `${cross}pages/names-c.html`);
	const c = await read(page, 'c');
	await sleep(2000);
	const proxiedAimed = await aimed(page);
	ok(
		`${mode}: another tab's navigations by name reach none of the first tab's frames, as natively`,
		JSON.stringify(proxiedAimed) === JSON.stringify(nativeAimed),
		JSON.stringify({ native: nativeAimed, proxied: proxiedAimed }),
	);
	for (const [label, native, proxied] of [
		['the first tab', nativeA, a],
		['another tab', nativeC, c],
	])
		for (const [name, want] of Object.entries(native ?? {})) {
			const same = JSON.stringify(proxied?.[name]) === JSON.stringify(want);
			// under a site pool (docs/site-pool.md) the other site's window is
			// of another origin, restricted by the browser itself: it reads as
			// natively
			const open = SLOT_PORTS.length
				? undefined
				: KNOWN_OPEN[`${label}: ${name}`];
			ok(
				`${mode}: ${label}: ${name} as natively${open ? ` (known open: ${open})` : ''}`,
				open ? !same : same,
				JSON.stringify({ native: want, proxied: proxied?.[name] ?? null }),
			);
		}
	await page.context().close();
}
await done(browser);
