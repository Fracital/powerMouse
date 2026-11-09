// A page that reaches into an about:blank frame before it loads hands the
// frame a client of its own bundle, which hooks the frame's realm. Its link
// rel and as hooks once went on the creator's prototypes instead (a free
// HTMLLinkElement), so the frame's client, which no worker controls, took
// over every link the creator then wrote by property: Google Docs' module
// preloads in its own, controlled document became blob: copies its scripts
// never used (each module fetched twice, the editor ready seconds late),
// and a stylesheet the frame's own document got that way was never routed.
// The page loads natively and through both demo modes: the preload is the
// load its script uses (the site serves the script once, as natively), the
// creator's link keeps its route, and the frame's stylesheet applies
// without reaching the site past the proxy.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/blank-creator.html`;
const ROUTE = /\/stomp\/[\w-]+\/html\//;

/** how often the site has served the script so far */
const served = async () =>
	(await (await fetch(`${FIXTURE}hits`)).json())['blank-creator.js']
		?.requests ?? 0;

/** the page's report, from whichever frame has it, once it is done */
async function report(page) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__blankCreator)
				.catch(() => null);
			if (value?.done) return { frame, value };
		}
	}
	return { frame: null, value: null };
}

const browser = await launch();
const before = await served();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const { value: native } = await report(nativePage);
await nativePage.close();
const nativeServed = (await served()) - before;
ok(
	'natively, the preload loads, its script runs once from it, the frame is styled',
	native?.preload === 'load' &&
		native?.script === 'load' &&
		native?.ran === 1 &&
		native?.sheet === 'load' &&
		native?.color === 'rgb(1, 2, 3)' &&
		nativeServed === 1,
	JSON.stringify({ native, nativeServed }),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	const start = await served();
	await submitLanding(page, target);
	const { frame, value: proxied } = await report(page);
	await sleep(500);
	const count = (await served()) - start;
	ok(
		`${mode}: the creator's preload and script fire and the script runs once`,
		proxied?.preload === native?.preload &&
			proxied?.script === native?.script &&
			proxied?.ran === native?.ran,
		JSON.stringify({ native, proxied }),
	);
	ok(
		`${mode}: the script is fetched once, the preload's load reused, as natively`,
		count === nativeServed,
		`native ${nativeServed}, proxied ${count}`,
	);
	// the element as the browser has it: the creator's document is controlled,
	// so its link holds a route, never a blob: copy
	const real =
		frame && ROUTE.test(frame.url())
			? await frame.locator('#preload').getAttribute('href')
			: null;
	ok(
		`${mode}: the creator's preload holds a route, not a copy`,
		typeof real === 'string' && !real.startsWith('blob:'),
		String(real),
	);
	ok(
		`${mode}: a stylesheet the frame's document gets by property applies`,
		proxied?.sheet === native?.sheet && proxied?.color === native?.color,
		JSON.stringify({
			native: [native?.sheet, native?.color],
			proxied: [proxied?.sheet, proxied?.color],
		}),
	);
	const fixtureHost = new URL(FIXTURE).host;
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost);
	ok(
		`${mode}: nothing either document loads reaches the site past the proxy`,
		raw.length === 0,
		JSON.stringify(raw.map((entry) => [entry.url, entry.type])),
	);
	await page.close();
}
await done(browser);
