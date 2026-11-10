// Chrome's third-party storage partitioning, against Chrome. One site (the
// fixture on localhost) is opened top-level, then as a frame in another
// site's page (the fixture on 127.0.0.1), then top-level again; each time it
// writes to and reads every store (test/pages/sop-part.html): localStorage,
// sessionStorage, cookies with and without Partitioned (CHIPS, set by script
// and by a response, and the Cookie header a request carries), IndexedDB,
// Cache Storage, the origin private file system, Web Locks,
// BroadcastChannel, SharedWorker and service worker registrations, and what
// its dedicated, blob: and shared workers see of them. Natively the frame's
// stores are keyed by the top-level site too, so it shares none of them with
// the top-level page of its own site (unpartitioned cookies aside: Chrome
// sends third-party cookies by default). Each report is compared with the
// same sequence loaded natively, in both modes.
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

const A = new URL(FIXTURE).origin;
const B = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
/** the three steps, their names under the run's own tag */
const steps = (t) => [
	['top/before', `${B}/pages/sop-part.html?role=top&t=${t}`],
	[
		'frame/before',
		`${A}/pages/sop-part-a.html?b=${encodeURIComponent(B)}&t=${t}`,
	],
	['top/after', `${B}/pages/sop-part.html?role=top&phase=after&t=${t}`],
];

// Cases known to differ from Chrome, by why (docs/same-origin-policy.md). A
// case on the list that now reads as natively fails too: take it off.
const KNOWN_BY_REASON = {};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

/** the report of `key` (role/phase) from whichever frame of `page` has it */
async function report(page, key) {
	for (let i = 0; i < 120; i++) {
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__part)
				.catch(() => null);
			if (value?.done && `${value.role}/${value.phase}` === key) return value;
		}
		await sleep(250);
	}
	return null;
}

// Playwright turns Chrome's storage partitioning off; a later
// --disable-features replaces its list, so Chrome partitions as it ships
const browser = await launch(['--disable-features=PaintHolding']);

const nativeContext = await browser.newContext();
const native = {};
for (const [key, url] of steps('native')) {
	const page = await nativeContext.newPage();
	await page.goto(url);
	native[key] = await report(page, key);
}
await nativeContext.close();
ok(
	'natively, every step reported',
	steps('native').every(([key]) => native[key] && !native[key].error),
	JSON.stringify(native),
);
// what the comparison relies on, so a change in the browser shows here first
ok(
	'natively, the frame shares no localStorage with its top-level site',
	JSON.stringify(native['frame/before']?.seen?.localStorage) === '["p-frame"]',
	JSON.stringify(native['frame/before']?.seen),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	// with emulated service workers, for the registrations
	const page = await openDemo(browser, `${base}?sw`);
	const proxied = {};
	for (const [key, url] of steps(mode.replace('-', ''))) {
		await page.click('#home').catch(() => {});
		await submitLanding(page, url);
		proxied[key] = await report(page, key);
	}
	for (const [key] of steps(mode)) {
		const want = native[key] ?? {};
		const got = proxied[key] ?? {};
		for (const field of ['heard', 'workerCount', 'error'])
			check(mode, `${key}: ${field}`, want[field], got[field]);
		for (const kind of ['dedicated', 'blob', 'shared'])
			check(
				mode,
				`${key}: ${kind} worker`,
				want.workers?.[kind],
				got.workers?.[kind],
			);
		for (const store of Object.keys(want.seen ?? {}))
			check(mode, `${key}: ${store}`, want.seen[store], got.seen?.[store]);
	}
	await page.context().close();
}

function check(mode, name, want, got) {
	const a = JSON.stringify(want ?? null);
	const b = JSON.stringify(got ?? null);
	const detail = `\n      native  ${a}\n      proxied ${b}`;
	if (KNOWN.has(name))
		ok(
			`${mode}: ${name} differs as known (${KNOWN.get(name)})`,
			a !== b,
			`now as natively: take it off the list${detail}`,
		);
	else ok(`${mode}: ${name} as natively`, a === b, detail);
}

await done(browser);
