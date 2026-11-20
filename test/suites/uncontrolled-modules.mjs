// Module scripts in documents no service worker controls, in Chrome,
// WebKit and Firefox (test/engines.mjs): an about:blank frame a page writes
// into, an about:blank it navigates the child of another origin's frame to
// (the page's in Chrome and Firefox; WebKit keeps it the frame's, which the
// page cannot reach), an about:blank popup it opens, and an about:blank
// frame whose markup it writes with document.write
// (test/pages/uncontrolled-modules.html). In each, inline and external
// module scripts with static imports (relative, path-absolute, absolute, a
// directory up, a cycle, a JSON module, an import map's bare specifier, a
// missing one), dynamic imports from a module and from a classic script,
// and what `import.meta.url` reads. Natively the document's loads are the
// network's; through the proxy no service worker serves them (WebKit hands
// the frame its parent's worker, which serves none of its routes), so the
// inject loads the graph itself. Every case must read as natively, in both
// modes.
import { proxiedGo, withFirefox, withWebKit } from '../engines.mjs';
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

const OTHER = FIXTURE.replace('127.0.0.1', 'localhost').replace(/\/$/, '');
const URL_OF = `${FIXTURE}pages/uncontrolled-modules.html?other=${encodeURIComponent(OTHER)}`;
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];
const REPORT = 'window.__umReport';

// Differences known and left, by engine, mode and part, with why. One that
// now reads as natively fails too: take it off.
const FIREFOX_CYCLE =
	'a cycle is closed by an import map the inject adds once the copies are made, and Firefox takes no import map once a module of the document has loaded (Chrome and WebKit do); a blob: URL cannot name a module before it is made';
const KNOWN = Object.fromEntries(
	['same-origin', 'isolated'].flatMap((mode) =>
		[
			'written: cycle',
			'navigated: cycle',
			'popup: cycle',
			'markup: markupCycle',
		].map((part) => [`Firefox ${mode}: ${part}`, FIREFOX_CYCLE]),
	),
);

/** a report's parts, by name: each document's cases */
const parts = (report) => {
	const named = new Map();
	for (const [kind, results] of Object.entries(report ?? {}))
		if (results && typeof results === 'object')
			for (const [name, value] of Object.entries(results))
				named.set(`${kind}: ${name}`, value);
		else named.set(kind, results);
	return named;
};

function compare(engine, mode, want, got) {
	const wanted = parts(want);
	const gotten = parts(got);
	for (const part of new Set([...wanted.keys(), ...gotten.keys()])) {
		const a = JSON.stringify(wanted.get(part));
		const b = JSON.stringify(gotten.get(part));
		const detail = `native ${a}, proxied ${b}`;
		const label = `${engine} ${mode}: ${part}`;
		const known = KNOWN[`${engine} ${mode}: ${part}`];
		if (known && a !== b)
			ok(`${label} differs, a known difference: ${known}`, true, detail);
		else if (known)
			ok(
				`${label} reads as natively: take it off the known list`,
				false,
				detail,
			);
		else ok(`${label} reads as natively`, a === b, detail);
	}
}

// ---- Chrome ----

const browser = await launch();

async function chromeReport(page) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(REPORT).catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(URL_OF);
const want = await chromeReport(nativePage);
await nativePage.context().close();
ok('Chrome natively, the page reported', want !== null, JSON.stringify(want));
for (const [mode, base] of MODES) {
	const page = await openDemo(browser, base);
	await submitLanding(page, URL_OF);
	const got = await chromeReport(page);
	compare('Chrome', mode, want, got);
	await page.context().close();
}

// ---- WebKit and Firefox ----

async function compareEngine(engine, open) {
	const session = await open();
	let native;
	try {
		await session.go(URL_OF);
		native = await session.report();
	} finally {
		await session.close();
	}
	ok(
		`${engine} natively, the page reported`,
		native && typeof native === 'object',
		JSON.stringify(native),
	);
	for (const [mode, base] of MODES) {
		const proxied = await open();
		let got;
		try {
			await proxiedGo(proxied, base, URL_OF);
			got = await proxied.report();
		} finally {
			await proxied.close();
		}
		compare(engine, mode, native, got);
	}
}

await withWebKit('uncontrolled-modules', REPORT, (open) =>
	compareEngine('WebKit', open),
);
await withFirefox('uncontrolled-modules', REPORT, (open) =>
	compareEngine('Firefox', open),
);

await done(browser);
