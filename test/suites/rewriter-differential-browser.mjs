// The rewriter's differential oracle in the browser: the curated corpus of
// test/differential/corpus.mjs run natively and through the proxy, in both
// demo modes, by the page test/pages/differential.html. Each case runs in a
// fresh frame of that page, with the browser's real `location`, `top` and
// `parent`, and leaves its trace (what it did to the objects it made, what
// it logged, how it ended); the proxied trace must be the native one. This
// is the node suite's oracle (rewriter-differential) with the whole inject
// around it, where a window is a window: what the node suite's world can
// only model (which window is the top, what Reflect and Object answer) is
// the real thing here.
//
// A case that navigates a window is left out (the page itself would go), as
// is every case the node suite names as known to differ.
// DIFFERENTIAL_STRIDE=<n> runs every n-th of the crossed cases (3 when not
// given: the hand-written ones always run). DIFFERENTIAL_CASES=<name>,...
// runs those cases alone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const root = fileURLToPath(new URL('../../', import.meta.url));
const { cases, KNOWN, WRITES } = await import(
	`${root}test/differential/corpus.mjs`
);
const world = readFileSync(`${root}test/differential/world.js`, 'utf8');
const target = `${FIXTURE}pages/differential.html`;
const stride = Number(process.env.DIFFERENTIAL_STRIDE ?? 3);

// a write of a location, by any spelling the corpus has, or a call that
// navigates: the test page would leave
const NAVIGATES =
	/location\s*(?:[-+*/%&|^?<>]*=(?!=)|\+\+|--)|(?:\+\+|--)\s*[\w.[\]"]*location|\[K[LT]\]\s*(?:[-+*/%&|^?<>]*=(?!=)|\+\+|--)|"location"\]\s*[-+*/%&|^?]*=(?!=)|\.assign\(|\.replace\(|\.reload\(|\bset\(window|\[k\]\s*=\s*"s|\bthis\[KX\]|window\.name|\bopen\(/;
// (the crossed writes whose target is a window's member write locations in
// every position a write can stand in: only the page's own objects are kept)
const OWN = WRITES.flatMap((target, index) =>
	/^(plain|m)\b/.test(target) ? [index] : [],
);
// What differs in the browser alone, each with why. Like the node suite's
// KNOWN, such a case runs and must still differ, so the list stays true.
// The cases run in frames on their initial about:blank, which the parent's
// bundle injects, and the hooks such a frame gets (its `Function`, `eval`,
// `fetch`...) are functions of the parent's realm (src/inject/modules/
// Function.ts, src/inject/dom/modules/IFrame.ts injectChild).
const PARENT_REALM =
	"a frame on its initial about:blank holds hooks of its parent's realm: its `Function`, `eval`, `fetch` are no instances of its own Object";
const BROWSER_KNOWN = {
	'source#14': PARENT_REALM,
	'read#34.2': PARENT_REALM,
	'read#34.17': PARENT_REALM,
	'source#17':
		"`f.caller` of a function eval'd code calls: the eval the page called is the inject's stand-in, a strict function, so the caller is null",
};
let crossed = 0;
const only = process.env.DIFFERENTIAL_CASES?.split(',');
const chosen = cases().filter((entry) => {
	if (only) return only.includes(entry.name);
	if (entry.name in KNOWN) return false;
	const write = /^write#\d+\.(\d+)$/.exec(entry.name);
	if (write && !OWN.includes(Number(write[1]))) return false;
	if (!write && !/^read#/.test(entry.name) && NAVIGATES.test(entry.code))
		return false;
	if (write || /^read#/.test(entry.name)) return crossed++ % stride === 0;
	return true;
});
const codes = chosen.map((entry) => entry.code);

/** the page's traces of the cases, from a frame of it */
async function traces(find) {
	for (let i = 0; i < 120; i++) {
		const frame = await find();
		const ready = await frame
			?.evaluate(() => typeof window.__differential === 'function')
			.catch(() => false);
		if (ready)
			return frame.evaluate(
				([text, list]) => window.__differential(text, list),
				[world, codes],
			);
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await traces(async () => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively, the page ran every case',
	native?.length === codes.length && (!!only || codes.length > 300),
	`${native?.length} of ${codes.length}`,
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await traces(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	ok(
		`${mode}: the page ran every case`,
		proxied?.length === codes.length,
		`${proxied?.length} of ${codes.length}`,
	);
	const differ = [];
	const stale = [];
	chosen.forEach((entry, index) => {
		const same = proxied?.[index] === native?.[index];
		if (entry.name in BROWSER_KNOWN) {
			if (!same) return;
			// (only a case the whole run holds can go stale)
			if (!only) stale.push(entry.name);
		}
		if (same) return;
		const a = String(native?.[index]).split('\n');
		const b = String(proxied?.[index]).split('\n');
		let at = 0;
		while (at < a.length && at < b.length && a[at] === b[at]) at++;
		differ.push(
			`${entry.name}: line ${at + 1}: native ${JSON.stringify(a[at] ?? '(end)')} proxied ${JSON.stringify(b[at] ?? '(end)')}\n  ${JSON.stringify(entry.code.slice(entry.code.lastIndexOf('\n') + 1))}`,
		);
	});
	ok(
		`${mode}: every case leaves the trace it leaves natively`,
		differ.length === 0,
		`${differ.length} differ\n${differ.slice(0, 12).join('\n')}`,
	);
	ok(
		`${mode}: every case named as known to differ in the browser still differs`,
		stale.length === 0,
		stale.join(', '),
	);
	await page.close();
}

await browser.close();
await done();
