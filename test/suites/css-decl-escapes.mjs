// A URL a page writes into any declaration block loads through the proxy:
// a style rule's own declarations, the declarations after a nested rule
// (CSSNestedDeclarations), an @function's (CSSFunctionDeclarations) and an
// element's inline style in each namespace (HTML, SVG, MathML), by a named
// property, its dashed name, setProperty and cssText, and a URL in the text
// of a rule put in with insertRule (test/pages/adv-css-decls.html). Each case
// points an element at the fixture's /sop/r under a key of its own. The page
// runs natively first: a case that loads there must load proxied too, never
// as a request that reached the fixture past the proxy (the declarations
// after a nested rule and a MathML element's style took a named property's
// URL unrouted), and read back as natively. Both modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	recordRequests,
	sleep,
} from '../lib.mjs';

const page = (run) => `${FIXTURE}pages/adv-css-decls.html?p=${run}`;
const fixtureHost = new URL(FIXTURE).host;
/** the case keys of `run` among these URLs */
const keysOf = (urls, run) =>
	new Set(
		urls
			.map((url) => new RegExp(`[?&]k=${run}-([\\w-]+)`).exec(url)?.[1])
			.filter(Boolean),
	);
/** the keys of `run` that reached the fixture by any way (its /sop/log) */
async function reached(run, keys) {
	const got = new Set();
	for (const key of keys) {
		const log = await (await fetch(`${FIXTURE}sop/log?k=${run}-${key}`)).json();
		if (log.length) got.add(key);
	}
	return got;
}

const browser = await launch();
// natively
const native = await (async () => {
	const context = await browser.newContext();
	const recorder = await recordRequests(context);
	const tab = await context.newPage();
	await tab.goto(page('native'));
	await tab.waitForFunction(() => window.__cssDeclsDone);
	await sleep(1500);
	const written = await tab.evaluate(() => window.__cssDecls);
	const loaded = keysOf(
		recorder.log.map((entry) => entry.url),
		'native',
	);
	await context.close();
	return { written, loaded };
})();
ok(
	'natively, the cases load (the named properties of each kind of block)',
	['rule-named', 'nested-named', 'math-named', 'svg-named', 'div-named'].every(
		(key) => native.loaded.has(key),
	),
	[...native.loaded].sort().join(' '),
);

for (const mode of ['same-origin', 'isolated']) {
	const run = mode === 'isolated' ? 'iso' : 'so';
	const context = await browser.newContext();
	const recorder = await recordRequests(context);
	const tab = await context.newPage();
	await tab.goto(mode === 'isolated' ? HOST : PROXY);
	await tab.waitForFunction(
		() => window.controller && window.controller.isReady,
		null,
		{ timeout: 45000 },
	);
	await tab.evaluate(async (url) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		await window.controller.createFrame(element).go(url);
	}, page(run));
	let frame;
	for (let i = 0; i < 120 && !frame; i++) {
		await sleep(250);
		frame = tab
			.frames()
			.find((f) => f.url().includes('/html/') && f !== tab.mainFrame());
	}
	await frame?.waitForFunction(() => window.__cssDeclsDone, null, {
		timeout: 30000,
	});
	await sleep(2500);
	const written = (await frame?.evaluate(() => window.__cssDecls)) ?? {};
	const raw = keysOf(
		recorder
			.raw()
			.filter((entry) => new URL(entry.url).host === fixtureHost)
			.map((entry) => entry.url),
		run,
	);
	ok(
		`${mode}: no URL written into a declaration block reached the site past the proxy`,
		raw.size === 0,
		[...raw].sort().join(' '),
	);
	const got = await reached(run, native.loaded);
	const missing = [...native.loaded].filter((key) => !got.has(key));
	ok(
		`${mode}: every case that loads natively loads through the proxy`,
		missing.length === 0,
		`missing ${missing.join(' ')}`,
	);
	const differ = Object.keys(native.written).filter(
		(key) =>
			JSON.stringify(written[key]).replaceAll(`k=${run}-`, 'k=-') !==
			JSON.stringify(native.written[key]).replaceAll('k=native-', 'k=-'),
	);
	ok(
		`${mode}: each block reads back what the page wrote, as natively`,
		differ.length === 0,
		differ
			.map(
				(key) =>
					`${key}: ${JSON.stringify(written[key])} natively ${JSON.stringify(native.written[key])}`,
			)
			.join('; ')
			.slice(0, 600),
	);
	await context.close();
}
await done(browser);
