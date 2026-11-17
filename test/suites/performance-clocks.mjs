// A page's clocks and memory figures read as they do natively
// (test/pages/perf-clocks.js, test/perf.mjs): its time origin against the
// wall clock, its frames' and its workers', how fine performance.now() is,
// performance.memory in the page and in frames of its site and of another,
// and, in a cross-origin isolated page, the result of
// performance.measureUserAgentSpecificMemory(), whose attribution names the
// page's own URLs.
import { done, launch, ok, SLOT_PORTS } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const NATIVE_RUNS = Number(process.env.NATIVE_RUNS) || 3;
// (the collector is the page's to call, so the measurement comes at once)
const browser = await launch(['--js-flags=--expose-gc']);

const GROUPS = [
	[
		"the page's clock starts, steps and serialises as natively",
		/^(self|grain)\./,
	],
	["a frame's clock is its own, after its parent's", /^frames\./],
	["a worker's clock is its own, after its creator's", /^workers\./],
	[
		'performance.memory reads as natively, in the page and its frames',
		/^memory\b/,
	],
	[
		'performance.measureUserAgentSpecificMemory() answers as natively',
		/^measure\b/,
	],
];

// What the architecture cannot close (docs/process-model.md), each with why.
// One that reads as natively again fails the suite: take it off the list.
const EXPECTED = {
	plain: [
		[
			/^memory\.frames\.crossSmaller: true -> false$/,
			"a frame of another site reads the page's allocations in its own figure: every proxied site shares one renderer heap, and what the heap grew is not any one site's to tell",
			// with the site pool a frame of another site is in a slot of its
			// own, a process of its own whenever Chrome gives an
			// Origin-Agent-Cluster origin one (docs/site-pool.md), which it
			// does not always: Chrome 157 read it as natively in 2 of 3 runs
			// in the same-origin page and 1 of 3 in the isolated one
			SLOT_PORTS.length > 0,
		],
	],
};

for (const [name, query] of [
	['plain', ''],
	['isolated page', '&coi=1'],
]) {
	const natives = [];
	for (let i = 0; i < NATIVE_RUNS; i++)
		natives.push(
			await nativeRecord(browser, 'clocks', {
				query,
				label: `${query ? 'coi-' : ''}native${i}`,
				timeout: 90000,
			}),
		);
	if (
		!ok(
			`natively, the ${name} page read its clocks every time`,
			natives.every((native) => native?.measure),
		)
	)
		continue;
	for (const [mode, base] of MODES) {
		const { record, errors } = await proxiedRecord(browser, base, 'clocks', {
			query,
			label: `${query ? 'coi-' : ''}${mode}`,
			timeout: 90000,
		});
		if (
			!ok(
				`${mode}, ${name}: the page read its clocks`,
				!!record?.measure,
				errors.join(' | '),
			)
		)
			continue;
		report(
			`${mode}, ${name}`,
			differences(natives, record),
			GROUPS,
			EXPECTED[name] ?? [],
		);
	}
}
await done(browser);
