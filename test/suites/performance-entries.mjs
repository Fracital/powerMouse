// What a page reads of each performance entry type (paints, the largest
// contentful paint, element timing, marks and measures, long tasks, long
// animation frames and their scripts, the first input, event timing, layout
// shifts, visibility) is what it reads natively
// (test/pages/perf-entries-run.js, test/perf.mjs), in both demo modes.
import { done, launch, ok, SLOT_PORTS } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const NATIVE_RUNS = Number(process.env.NATIVE_RUNS) || 3;
const browser = await launch();

/** the page is ready for input: a click on its button, a key in its field */
async function drive(page, frame) {
	await frame.click('#button');
	await frame.click('#input');
	await page.keyboard.press('a');
}

const natives = [];
for (let i = 0; i < NATIVE_RUNS; i++)
	natives.push(
		await nativeRecord(browser, 'entries', { drive, label: `native${i}` }),
	);
ok(
	'natively, the page made every entry each time',
	natives.every((native) => native?.layoutShift && native?.firstInput),
);

const GROUPS = [
	['the timeline starts as natively', /^(start|supported)\./],
	['paints read as natively', /^(paint|paintOrder|paintObserved)\b/],
	['the largest contentful paint reads as natively', /^lcp\b/],
	['element timing reads as natively', /^element\./],
	['marks and measures read as natively', /^(marks|measures|observedMarks)\./],
	['observers answer as natively', /^(observer|dropped|buffered|emptyLists)\b/],
	['long tasks read as natively', /^tasks\./],
	[
		'long animation frames name the scripts natively',
		/^(frames\.|foreignScripts)/,
	],
	[
		'the first input and event timing read as natively',
		/^(firstInput|events|beforeInput|afterInput)\./,
	],
	['a layout shift reads as natively', /^layoutShift\b/],
];
// what the architecture cannot make read as natively (docs/performance.md)
const EXPECTED = [
	[
		/^frames\.promise\.frame\.(scripts\.0\.(sourceURL|jsonSourceURL|sourceCharPosition)|jsonScripts|jsonPositions): /,
		'a callback run from a promise the inject made (fetch) is named without its source or position: the browser has only where the reaction started, in the inject',
	],
	[
		/^frames\.image-detached\.frame\.(scripts\.0\.(invoker|jsonInvoker)|jsonScripts): /,
		"a handler of an element that is not in the document is named by the element's whole URL, not the src attribute as written",
	],
	[
		/^dropped\.interaction-contentful-paint: /,
		'the browser makes interaction contentful paint entries for the main frame only, which a proxied page is not',
	],
];
// only where the page shares the host's process and frame tree, which with
// the site pool (docs/site-pool.md) it does not: the pool shows it from a
// slot, another origin than the host's, so the page is a local root of its
// own as in isolated mode.
const EXPECTED_SAME_ORIGIN = SLOT_PORTS.length
	? []
	: [
			[
				/^frames\.(animation|click|keydown)\./,
				"Chrome reports a long frame's rendering part (animation callbacks, input handlers) to the local root's window, which in same-origin mode is the host's",
			],
			[
				/^layoutShift\.lastInputSet: /,
				"a layout shift's last input time is kept by the local root, which in same-origin mode is the host's",
			],
		];

for (const [mode, base] of MODES) {
	const { record, errors } = await proxiedRecord(browser, base, 'entries', {
		drive,
		label: mode,
	});
	if (
		!ok(
			`${mode}: the page made every entry`,
			!!record?.layoutShift && !!record?.firstInput,
			errors.join(' | '),
		)
	)
		continue;
	report(
		mode,
		differences(natives, record),
		GROUPS,
		mode === 'same-origin' ? [...EXPECTED, ...EXPECTED_SAME_ORIGIN] : EXPECTED,
	);
}
await done(browser);
