// Credentialless frames (`<iframe credentialless>`), against Chrome. Chrome
// loads such a frame's documents in an ephemeral partition of their own:
// keyed by the top-level document (every credentialless frame under one
// top-level document shares it, and it is gone with that document), sharing
// nothing with the site's first-party stores or its third-party partition
// under the same top-level site. Its requests carry none of the site's
// cookies, the cookies its responses and scripts set live in that partition
// only, the HTTP cache keeps its loads apart, its own frames inherit it, and
// `window.credentialless` reads true in it. One site (the fixture on
// localhost, B) writes to every store top-level (test/pages/sop-part.html),
// then is framed credentialless by another site's page (A, the fixture on
// 127.0.0.1) twice in one document, by a new A document, by its own site,
// and under a plain frame of a credentialless one, then reads top-level
// again. Each report is compared with the same sequence loaded natively, in
// both modes.
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
/** the page in `role` on B, under the run's tag `t` (`c`: A's cached resource) */
const part = (role, t, phase = 'before') =>
	`${B}/pages/sop-part.html?role=${role}&phase=${phase}&t=${t}&c=${encodeURIComponent(A)}&popup=1`;
/** a page of `site` framing each of `sources` in turn, credentialless when `cl` */
const framing = (site, sources, cl = true) =>
	`${site}/pages/sop-part-a.html?${cl ? 'cl=1&' : ''}${sources
		.map((src) => `src=${encodeURIComponent(src)}`)
		.join('&')}`;
/** the steps: each a report key and the URL opened top-level */
const steps = (t) => [
	['top/before', part('top', t)],
	// two credentialless frames of B in one document of A: the second sees
	// what the first wrote, and neither sees B's own
	['frame/before', framing(A, [part('frame', t), part('second', t)])],
	['second/before', null],
	// a new document of A: the partition the frames above wrote is gone
	['frame/after', framing(A, [part('frame', t, 'after')])],
	// B framed credentialless by its own site
	['self/before', framing(B, [part('self', t)])],
	// a plain frame of B in a credentialless frame of A: it inherits it
	['nested/before', framing(A, [framing(A, [part('nested', t)], false)])],
	['top/after', part('top', t, 'after')],
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

/** what the framing page at `url` read of its frames' property */
async function attributes(page, url) {
	for (const frame of page.frames()) {
		const value = await frame
			.evaluate(
				(url) => (window.__framing === url ? window.__attribute : null),
				url,
			)
			.catch(() => null);
		if (value) return value;
	}
	return null;
}

// Playwright turns Chrome's storage partitioning off; a later
// --disable-features replaces its list, so Chrome partitions as it ships
const browser = await launch(['--disable-features=PaintHolding']);

async function run(open, t) {
	const reports = {};
	const attributeReads = {};
	for (const [key, url] of steps(t)) {
		if (url !== null) {
			const page = await open(url);
			reports[key] = await report(page, key);
			attributeReads[key] = await attributes(page, url);
		} else reports[key] = await report(await open(null), key);
	}
	return { reports, attributeReads };
}

// The run's tags are this suite's own: sop-partitions loads the same pages,
// and what the fixture counts (its /sop/log, one store for every suite of a
// runner) and the sites' cookies (whatever the port) are kept by tag
const tagOf = (mode) => `cl${mode.replace('-', '')}`;

let nativePage = null;
const nativeContext = await browser.newContext();
const native = await run(async (url) => {
	if (url === null) return nativePage;
	// (the pages before stay open, as the proxied ones do in their tab)
	nativePage = await nativeContext.newPage();
	await nativePage.goto(url);
	return nativePage;
}, tagOf('native'));
await nativeContext.close();
console.log('native', JSON.stringify(native));
ok(
	'natively, every step reported',
	steps('native').every(
		([key]) => native.reports[key] && !native.reports[key].error,
	),
	JSON.stringify(native.reports),
);
// what the comparison relies on, so a change in the browser shows here first
ok(
	'natively, a credentialless frame is sent none of the site cookies',
	JSON.stringify(native.reports['frame/before']?.seen?.sent) ===
		'["p_frame","p_frame_chips","p_frame_http_chips"]',
	JSON.stringify(native.reports['frame/before']?.seen),
);
ok(
	'natively, the second frame shares the partition of the first',
	JSON.stringify(native.reports['second/before']?.seen?.localStorage) ===
		'["p-frame","p-second"]',
	JSON.stringify(native.reports['second/before']?.seen),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	const proxied = await run(async (url) => {
		if (url !== null) {
			await page.click('#home').catch(() => {});
			await submitLanding(page, url);
		}
		return page;
	}, tagOf(mode));
	console.log(mode, JSON.stringify(proxied));
	for (const [key] of steps(mode)) {
		const want = native.reports[key] ?? {};
		const got = proxied.reports[key] ?? {};
		for (const field of [
			'credentialless',
			'popup',
			'heard',
			'workerCount',
			'error',
		])
			check(mode, `${key}: ${field}`, want[field], got[field]);
		check(
			mode,
			`${key}: iframe.credentialless`,
			native.attributeReads[key],
			proxied.attributeReads[key],
		);
		// (not an image's: the renderer's memory cache answers it, which
		// Chrome keeps per process, not per partition: memory-cache-share)
		for (const kind of ['fetch', 'validated', 'preflight'])
			check(
				mode,
				`${key}: ${kind} cache`,
				want.cacheLoads?.[kind],
				got.cacheLoads?.[kind],
			);
		for (const kind of ['dedicated', 'blob', 'shared'])
			check(
				mode,
				`${key}: ${kind} worker`,
				want.workers?.[kind],
				got.workers?.[kind],
			);
		for (const kind of ['blob', 'javascript'])
			check(
				mode,
				`${key}: ${kind} document`,
				want.inline?.[kind],
				got.inline?.[kind],
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

await browser.close();
await done();
