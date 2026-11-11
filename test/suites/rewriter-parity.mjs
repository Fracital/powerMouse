// The two JavaScript rewriters print the same programs: rust/host/parity.mjs
// --cases, the differential harness, in node with the module the build
// ships (dist/core.wasm). Every rewrite family of src/rewriteJS.ts by
// shape (rust/host/cases.mjs), and a family for each hole the JavaScript
// rewriter had (the `holes` families: what each fix changed, which the wasm
// rewriter must do too, or shows it never had), are rewritten by both and
// compared as trees, their function marks as lists and the holder as text.
// No known divergence is allowed, and the module's revision must be the one
// its outputs for the cases were recorded under.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { done, ok } from '../lib.mjs';

try {
	await import('esbuild');
} catch (error) {
	console.log('SKIP rewriter-parity: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const { cases } = await import(`${root}rust/host/cases.mjs`);

const harness = spawnSync(
	process.execPath,
	[`${root}rust/host/parity.mjs`, '--cases'],
	{
		env: { ...process.env, CORE_WASM: `${root}dist/core.wasm` },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	},
);
const output = harness.stdout ?? '';
const count = (label) =>
	Number(new RegExp(`^ {2}${label}: (\\d+)`, 'm').exec(output)?.[1] ?? NaN);
const all = cases();
const holes = all.filter((entry) => entry.family.startsWith('holes'));
// a hole's case reported as anything but the same program
const reported = [
	...output.matchAll(/^(DIFF|TRAP|DECLINED|KNOWN) (holes\w+#\d+)/gm),
].map(([, kind, name]) => `${kind} ${name}`);
for (const line of output.trim().split('\n').slice(-12))
	console.log(`  ${line}`);

ok(
	'the harness ran every case',
	harness.status !== null &&
		new RegExp(`^${all.length} scripts$`, 'm').test(output),
	`exit ${harness.status}: ${(harness.stderr ?? '').slice(0, 2000)}`,
);
ok(
	'both rewriters print the same program for every case, with no known divergence',
	count('differ') === 0 &&
		count('trapped') === 0 &&
		count('known divergences \\(rust/host/cases.mjs\\)') === 0 &&
		count('same program, marks and holder') > 800,
	output
		.split('\n')
		.filter((line) => /^(DIFF|TRAP|KNOWN)/.test(line))
		.slice(0, 10)
		.join(' | '),
);
ok(
	"and the module rewrites every hole's case itself, as the JavaScript rewriter does",
	holes.length > 100 && reported.length === 0,
	`${holes.length} cases; ${reported.join(', ')}`,
);
ok(
	'the outputs are the ones recorded under the revision the module answers',
	/revision \S+: the outputs are the recorded ones/.test(output) &&
		harness.status === 0,
	output.split('\n').slice(-3).join(' '),
);

await done();
