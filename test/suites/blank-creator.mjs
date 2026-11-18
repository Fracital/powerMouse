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
//
// And the markup members in such frames (test/pages/blank-creator-markup.html):
// setHTML, setHTMLUnsafe and getHTML called on an element of a frame on its
// initial about:blank and of one its parent wrote into, which is of another
// realm than the creator's whose bundle hooks it, and the creator's own
// members called on the frame's elements. What the page reads (the markup,
// its URLs, the realm of every node made and of a template's content, the
// scripts that ran, whether an image loaded, what getHTML returns) is as
// natively, no route reaches the page, and what the browser has in the
// frames' elements is routed, never the URL the page wrote.
import {
	done,
	evaluateIsolated,
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
const markupTarget = `${FIXTURE}pages/blank-creator-markup.html`;
/** the markup page's report, once it is done */
async function markupReport(page) {
	let last = null;
	for (let i = 0; i < 360; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__blankMarkup)
				.catch(() => null);
			if (value?.done) return { frame, value };
			if (value) last = value;
		}
	}
	return { frame: null, value: last };
}
/** every URL attribute under the frames' elements, as the browser has them */
const rawURLs = (frame) =>
	evaluateIsolated(frame, () => {
		const out = [];
		const walk = (root, where) => {
			for (const element of root.querySelectorAll('*')) {
				for (const name of ['href', 'src'])
					if (element.hasAttribute(name))
						out.push(
							`${where}${element.closest('[id]')?.id ?? ''} ${name}=${element.getAttribute(name)}`,
						);
				const of = `${where}${element.closest('[id]')?.id ?? ''}>`;
				if (element.shadowRoot) walk(element.shadowRoot, `${of}shadow:`);
				if (element.localName === 'template')
					walk(element.content, `${of}content:`);
			}
		};
		walk(document, '');
		return out;
	});

const markupNative = await browser.newPage();
await markupNative.goto(markupTarget);
const { value: nativeMarkup } = await markupReport(markupNative);
await markupNative.close();
const markupKeys = Object.keys(nativeMarkup ?? {}).filter(
	(key) => key !== 'done',
);
ok(
	'natively, the markup members ran in both frames',
	nativeMarkup?.done === true &&
		!nativeMarkup.error &&
		markupKeys.some((key) => key.startsWith('blank.')) &&
		markupKeys.some((key) => key.startsWith('written.')) &&
		nativeMarkup['blank.setHTMLKept.image'] === 'load' &&
		nativeMarkup['written.setHTMLUnsafe.shadowImage'] === 'load',
	JSON.stringify(nativeMarkup),
);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, markupTarget);
	const { frame, value: proxied } = await markupReport(page);
	const keys = [...new Set([...markupKeys, ...Object.keys(proxied ?? {})])];
	const differ = keys.filter(
		(key) => key !== 'done' && proxied?.[key] !== nativeMarkup?.[key],
	);
	for (const key of differ)
		ok(
			`${mode}: markup in a blank creator's frame, ${key} as natively`,
			false,
			`native ${JSON.stringify(nativeMarkup?.[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	ok(
		`${mode}: markup in a blank creator's frame, all ${markupKeys.length} readings as natively`,
		proxied?.done === true && markupKeys.length > 0 && differ.length === 0,
		`${differ.length} differ`,
	);
	const leaked = Object.entries(proxied ?? {}).filter(
		([, value]) => typeof value === 'string' && value.includes('/stomp/'),
	);
	ok(
		`${mode}: no route reaches the page from a blank creator's frame's markup`,
		leaked.length === 0,
		JSON.stringify(leaked),
	);
	// what the browser has: each URL the members put in is routed (or an
	// image's copy), never the page's as it wrote it
	const raw = [];
	for (const child of frame?.childFrames() ?? [])
		raw.push(...((await rawURLs(child).catch(() => null)) ?? []));
	const unrouted = raw.filter(
		(entry) => !/=(\/stomp\/|blob:|https?:\/\/[^/]+\/stomp\/)/.test(entry),
	);
	ok(
		`${mode}: what the members put in a blank creator's frames is routed`,
		raw.length > 0 && unrouted.length === 0,
		JSON.stringify({ unrouted, count: raw.length }),
	);
	const fixtureHost = new URL(FIXTURE).host;
	const past = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost);
	ok(
		`${mode}: nothing the frames' markup loads reaches the site past the proxy`,
		past.length === 0,
		JSON.stringify(past.map((entry) => [entry.url, entry.type])),
	);
	await page.close();
}
await done(browser);
