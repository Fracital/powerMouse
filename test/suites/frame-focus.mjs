// A proxied page's frames may focus without user activation as natively
// (test/pages/frame-focus.html, in a frame of frame-focus-top.html once
// the activation that brought the page there has expired): Chrome 158 turns
// focus-without-user-activation off in every frame under a sandbox unless
// the frame's own allow names it, and every proxied document is under the
// controller's, so each frame the page makes or parses is given a real
// allow that names it, decided as natively from the page's allow and
// sandbox, which the page never sees (src/inject/dom/focusAllow.ts). Frames
// the parser and the script make, of another site and of this one, with
// and without an allow of the page's (`'none'`, `'self'`, an origin, an
// unrecognized one, none at all), under a sandbox of the page's, srcdoc and
// about:blank ones, a nested one, and one whose allow the page changes once
// it loaded: each document's policy and what its focus() does, what the
// page reads of the attribute (getAttribute, the property, the attributes,
// markup, selectors, a clone, mutation records), and the console's
// warnings of the allow, compared with the page loaded natively, in both
// modes. Before Chrome 158 the feature does not exist: the same comparison
// holds, with no real allow given.
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

const target = `${FIXTURE}pages/frame-focus-top.html`;
const browser = await launch();
const major = Number(browser.version().split('.')[0]);

/**
 * The frame's window.__focus and __reads once it has them. Read only once
 * the frames have reported: Playwright's evaluate is a user gesture, and a
 * frame it activates may focus whatever its policy says (through the proxy
 * every document is of one real origin, which an activation reaches)
 */
async function find(page) {
	await sleep(16000);
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		for (const frame of page.frames().reverse()) {
			if (
				(await frame.evaluate(() => document.title).catch(() => '')) !==
				'FRAME FOCUS'
			)
				continue;
			const value = await frame
				.evaluate(
					() =>
						window.__focus && { focus: window.__focus, reads: window.__reads },
				)
				.catch(() => null);
			if (value) return value;
		}
	}
	return null;
}
/** the warnings of allow attributes the page's documents logged */
const warnings = (page) => {
	const seen = new Set();
	page.on('console', (message) => {
		if (/Unrecognized (feature|origin)|allow attribute/i.test(message.text()))
			seen.add(message.text());
	});
	return seen;
};

const nativePage = await browser.newPage();
const nativeWarnings = warnings(nativePage);
await nativePage.goto(target);
const native = await find(nativePage);
await nativePage.close();
const sorted = (focus) =>
	Object.fromEntries(
		Object.entries(focus ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
	);
// the frames whose focus() the page's script calls: about:blank ones
const BLANK = new Set(['parsedBlank', 'madeBlank', 'madeBlankNone']);
ok(
	'natively, every frame reports',
	!!native,
	JSON.stringify(native).slice(0, 300),
);
if (major >= 158) {
	// the comparison means something: natively some frames have the feature
	// and focus, and some have it off and do not. (An about:blank frame's
	// focus() is its parent's script's, which has it. A frame of another
	// site that has the feature may still be refused natively, now and
	// then, which no policy decides: one in another process takes the focus
	// from the page's only some of the time, measured on 158.)
	const states = Object.values(native?.focus ?? {});
	ok(
		`natively on Chrome ${major}, frames with the feature focus, and frames without it do not`,
		states.some((s) => s.allowed && s.focused) &&
			states.some((s) => !s.allowed && !s.focused) &&
			states.every((s) => s.allowed || !s.focused || BLANK.has(s.name)),
		JSON.stringify(sorted(native?.focus)),
	);
	ok(
		'natively, an unrecognized origin in an allow warns',
		[...nativeWarnings].some((text) => text.includes("'garbage'")),
		JSON.stringify([...nativeWarnings]),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	// (a browser of its own: a page an earlier one focused is not this one's)
	const modeBrowser = await launch();
	const page = await openDemo(modeBrowser, base);
	const seen = warnings(page);
	await submitLanding(page, target);
	const proxied = await find(page);
	// each frame's policy exactly; its focus() where natively the policy
	// decided it (a frame natively refused though it had the feature is not
	// compared, above)
	const policy = (focus) =>
		Object.fromEntries(
			Object.entries(sorted(focus)).map(([name, report]) => [
				name,
				report.allowed,
			]),
		);
	ok(
		`${mode}: each frame's policy is as natively`,
		JSON.stringify(policy(proxied?.focus)) ===
			JSON.stringify(policy(native?.focus)),
		JSON.stringify({
			native: policy(native?.focus),
			proxied: policy(proxied?.focus),
		}).slice(0, 3000),
	);
	if (major >= 158) {
		const differs = Object.values(native?.focus ?? {}).filter(
			(report) =>
				(!report.allowed || report.focused) &&
				proxied?.focus?.[report.name]?.focused !== report.focused,
		);
		ok(
			`${mode}: focus() without user activation does in each frame what it does natively`,
			!!proxied && !differs.length,
			JSON.stringify(
				differs.map((report) => [report, proxied?.focus?.[report.name]]),
			).slice(0, 3000),
		);
	}
	for (const key of Object.keys(native?.reads ?? {}))
		ok(
			`${mode}: the page reads ${key} as natively`,
			JSON.stringify(proxied?.reads?.[key]) ===
				JSON.stringify(native.reads[key]),
			JSON.stringify({
				native: native.reads[key],
				proxied: proxied?.reads?.[key],
			}).slice(0, 3000),
		);
	ok(
		`${mode}: the console warns of the page's allow attributes as natively`,
		JSON.stringify([...seen].sort()) ===
			JSON.stringify([...nativeWarnings].sort()),
		JSON.stringify({ native: [...nativeWarnings], proxied: [...seen] }),
	);
	await page.close();
	await modeBrowser.close();
}
await done(browser);
