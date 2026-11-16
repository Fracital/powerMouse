// The rewriter's differential semantic oracle, in node (test/differential).
// Every case of the curated corpus, and a run of generated programs, runs
// twice in a fresh realm that holds the same world: as written, and
// rewritten by the wasm core the build ships with the inject's real access
// API, Function hooks and toString hook installed. Each run leaves a trace
// (what was done to the world's objects, in order, with keys and values;
// what the case logged; its completion value or the class and message of
// what it threw; the name, length and source of every function it showed),
// and the two traces must be the same text. Proxied, the realm's real
// `location` and `top` are host objects no page code may touch: a touch of
// one, or one as a value anywhere in a trace, is an escape.
//
// What is known to differ is named in test/differential/corpus.mjs (KNOWN),
// each with why; a known case that stops differing fails the suite, so the
// list stays true; the case's code is its reproduction.
//
// DIFFERENTIAL_SEED and DIFFERENTIAL_COUNT choose the generated programs
// (the first seed, how many: 1 and 400 when not given), so a difference is
// reproduced with `DIFFERENTIAL_SEED=<seed> DIFFERENTIAL_COUNT=1`.
// DIFFERENTIAL_VERBOSE=1 prints both traces of whatever differs.
import { fileURLToPath } from 'node:url';
import { done, ok } from '../lib.mjs';

try {
	await import('esbuild');
} catch (error) {
	console.log('SKIP rewriter-differential: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const { createHarness, firstDifference, unmarked } = await import(
	`${root}test/differential/harness.mjs`
);
const { cases, KNOWN } = await import(`${root}test/differential/corpus.mjs`);
const { program } = await import(`${root}test/differential/fuzz.mjs`);

const verbose = !!process.env.DIFFERENTIAL_VERBOSE;
const harness = await createHarness({ core: `${root}dist/core.wasm` });
const report = (name, code, result) => {
	const lines = [
		`${name}: ${firstDifference(result.native, result.proxied)}`,
		`  ${JSON.stringify(code.split('\n').slice(-3).join('\n'))}`,
	];
	if (verbose)
		lines.push(
			`  rewritten: ${unmarked(result.rewritten).split('\n').slice(-3).join('\n')}`,
			`  native:  ${result.native.split('\n').join(' | ')}`,
			`  proxied: ${result.proxied.split('\n').join(' | ')}`,
		);
	return lines.join('\n');
};

const all = cases();
const differ = [];
const escapes = [];
const declined = [];
const stale = [];
let tells = 0;
let known = 0;
for (const entry of all) {
	const result = await harness.run(entry.code, { type: entry.type });
	tells += result.tells;
	if (result.rewritten.includes('STomp_could_not_rewrite'))
		declined.push(entry.name);
	const expected = KNOWN[entry.name];
	if (expected !== undefined) {
		known++;
		if (result.same) stale.push(entry.name);
		continue;
	}
	if (result.escape) escapes.push(report(entry.name, entry.code, result));
	else if (!result.same) differ.push(report(entry.name, entry.code, result));
}
ok(
	'the curated corpus ran',
	all.length > 2000,
	`${all.length} cases, ${known} known to differ, ${tells} tells`,
);
ok(
	'no rewritten case reaches the realm host location or top',
	escapes.length === 0,
	escapes.slice(0, 5).join('\n'),
);
ok(
	'every rewritten case leaves the trace the page code leaves as written',
	differ.length === 0,
	`${differ.length} differ\n${differ.slice(0, 8).join('\n')}`,
);
ok(
	'the rewriter declines no case of the corpus',
	declined.length === 0,
	declined.join(', '),
);
ok(
	'every case named as known to differ still differs',
	stale.length === 0,
	stale.join(', '),
);

// the generated programs
const first = Number(process.env.DIFFERENTIAL_SEED ?? 1);
const count = Number(process.env.DIFFERENTIAL_COUNT ?? 400);
const generated = [];
let refused = 0;
for (let seed = first; seed < first + count; seed++) {
	const { code } = program(seed);
	const result = await harness.run(code);
	if (
		result.native.startsWith('threw "SyntaxError"') &&
		!result.native.includes('\n')
	)
		refused++;
	if (!result.same || result.escape)
		generated.push(report(`seed ${seed}`, code, result));
}
ok(
	`generated programs ${first} to ${first + count - 1} leave the same trace rewritten`,
	generated.length === 0,
	`${generated.length} differ\n${generated.slice(0, 5).join('\n')}`,
);
ok(
	'nearly every generated program is one V8 compiles',
	refused <= count / 20,
	`${refused} of ${count} are refused`,
);

await done();
