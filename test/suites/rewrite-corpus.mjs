// The real-site rewrite gate on the committed sample (node only): the shapes
// minified bundles of real sites broke the rewriter with, reduced to a few
// lines each (test/corpus/sample/, the site and the bundle named in each
// file), rewritten by the wasm core the build ships and held to what V8
// makes of them by test/corpus/check.mjs, as written and as esbuild's
// minifier prints them. Every sample script must compile natively, and its
// rewrite must compile in the same goal and keep every statement,
// function, class and literal of it. The full corpus (the scripts about
// forty sites' login and home pages load) is fetched and checked locally:
// test/corpus/fetch.mjs, never from CI.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

try {
	await import('esbuild');
} catch (error) {
	console.log('SKIP rewrite-corpus: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const report = `${OUT}rewrite-corpus-${process.pid}.json`;
const core = `${root}dist/core.wasm`;
const run = spawnSync(
	process.execPath,
	[
		`${root}test/corpus/check.mjs`,
		'--minify',
		'--json',
		report,
		`${root}test/corpus/sample`,
	],
	{
		encoding: 'utf8',
		env: { ...process.env, ...(existsSync(core) ? { CORE_WASM: core } : {}) },
	},
);
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
const results = existsSync(report)
	? JSON.parse(readFileSync(report, 'utf8'))
	: [];
ok('the check ran', results.length > 0, `exit ${run.status}`);
const written = results.filter((r) => !r.url.endsWith('#minified'));
ok(
	'every sample script is in the check',
	written.length >= 5,
	`${written.length} scripts`,
);
for (const r of results)
	ok(
		`${r.url}: ${r.type ?? 'no goal'}`,
		r.verdict === 'ok',
		r.verdict === 'ok'
			? ''
			: `${r.verdict}: ${r.why}${r.where ? ` ${r.where}` : ''}`,
	);
ok('the check passed', run.status === 0, `exit ${run.status}`);
await done(null);
