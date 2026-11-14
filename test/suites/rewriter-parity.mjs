// The wasm rewriter's output is stable: rust/host/parity.mjs --cases, in node
// with the module the build ships (dist/core.wasm). Every rewrite family of
// src/rewriteJS.ts by shape (rust/host/cases.mjs), and a family for each hole
// the old JavaScript rewriter had (the `holes` families: shapes it got wrong,
// which the wasm rewriter must get right), are rewritten by the module. No
// case may trap, every hole's shape must be rewritten, and the digest of the
// module's outputs must be the one recorded under the module's revision
// (rust/host/cases.revision); that recorded-outputs check is the correctness
// oracle now that the wasm core is the only rewriter.
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
// a hole's case the module did not rewrite itself
const reported = [
	...output.matchAll(/^(DIFF|TRAP|DECLINED) (holes\w+#\d+)/gm),
].map(([, kind, name]) => `${kind} ${name}`);
for (const line of output.trim().split('\n').slice(-10))
	console.log(`  ${line}`);

ok(
	'the harness ran every case',
	harness.status !== null &&
		new RegExp(`^${all.length} scripts$`, 'm').test(output),
	`exit ${harness.status}: ${(harness.stderr ?? '').slice(0, 2000)}`,
);
ok(
	'the module rewrote the cases with no trap, and declined none it parses',
	count('trapped') === 0 &&
		count('declined by the module') === 0 &&
		count('rewritten') > 800,
	output
		.split('\n')
		.filter((line) => /^(DIFF|TRAP|DECLINED)/.test(line))
		.slice(0, 10)
		.join(' | '),
);
ok(
	"and the module rewrites every hole's case itself, as a correct rewriter must",
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
