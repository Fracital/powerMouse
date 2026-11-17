#!/usr/bin/env node
// The rewriter's throughput on test262, in one process with nothing else
// running in it: every test file in scope (test/language, test/built-ins,
// test/annexB, or the given prefixes) rewritten alone as the kind of script
// it is, after a warm-up, the best of --rounds rounds per file.
//
//   TEST262=<checkout> node test/test262/throughput.mjs [prefix...]
//       [--rounds N] [--top N]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};
const T262 = resolve(process.env.TEST262 ?? '');
const rounds = Number(option('--rounds', 3));
const top = Number(option('--top', 20));
const prefixes = argv.filter(
	(arg, at) => !arg.startsWith('--') && !argv[at - 1]?.startsWith('--'),
);
const scope = prefixes.length
	? prefixes
	: ['test/language', 'test/built-ins', 'test/annexB'];

const files = [];
const walk = (dir) => {
	for (const entry of readdirSync(join(T262, dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) walk(path);
		else if (entry.name.endsWith('.js')) files.push(path);
	}
};
for (const dir of scope) walk(dir.replace(/\/$/, ''));
files.sort();

const { createHarness } = await import(`${ROOT}/test/differential/harness.mjs`);
const h = await createHarness({
	core: process.env.CORE_WASM ?? join(ROOT, 'dist/core.wasm'),
});
const sources = files.map((file) => {
	const source = readFileSync(join(T262, file), 'utf8');
	const module =
		/flags:\s*\[[^\]]*\bmodule\b/.test(source) || file.includes('_FIXTURE');
	return { file, source, bytes: Buffer.byteLength(source), module };
});
const rewriteOf = ({ file, source, module }) =>
	module
		? h.rewrite(
				source,
				'genericModule',
				`https://page.example/dir/${file.split('/').pop()}`,
			)
		: h.rewrite(source, 'generic');
// warm-up: the first thousand files twice
for (let pass = 0; pass < 2; pass++)
	for (const entry of sources.slice(0, 1000)) rewriteOf(entry);

const best = new Float64Array(sources.length).fill(Infinity);
let outBytes = 0;
for (let round = 0; round < rounds; round++)
	sources.forEach((entry, at) => {
		const started = performance.now();
		const text = rewriteOf(entry);
		const ms = performance.now() - started;
		if (ms < best[at]) best[at] = ms;
		if (round === 0) outBytes += Buffer.byteLength(text);
	});
let bytes = 0;
let ms = 0;
sources.forEach((entry, at) => {
	bytes += entry.bytes;
	ms += best[at];
});
console.log(
	`${sources.length} files, ${(bytes / 1e6).toFixed(2)} MB in ${(ms / 1000).toFixed(3)} s (best of ${rounds}) = ${(bytes / 1e6 / (ms / 1000)).toFixed(2)} MB/s; output ${(outBytes / bytes).toFixed(2)}x the input`,
);
const sized = (low, high) => {
	let b = 0;
	let t = 0;
	let n = 0;
	sources.forEach((entry, at) => {
		if (entry.bytes >= low && entry.bytes < high) {
			b += entry.bytes;
			t += best[at];
			n++;
		}
	});
	return n
		? `${n} files ${(b / 1e6).toFixed(2)} MB ${(b / 1e6 / (t / 1000)).toFixed(2)} MB/s, ${((t * 1000) / n).toFixed(1)} us/file`
		: `0 files`;
};
console.log(`  under 1 KB: ${sized(0, 1000)}`);
console.log(`  1 to 10 KB: ${sized(1000, 10000)}`);
console.log(`  10 to 100 KB: ${sized(10000, 100000)}`);
console.log(`  100 KB and over: ${sized(100000, Infinity)}`);
const order = [...sources.keys()].sort((a, b) => best[b] - best[a]);
console.log('slowest (ms, bytes, MB/s, file):');
for (const at of order.slice(0, top))
	console.log(
		`  ${best[at].toFixed(2)}  ${sources[at].bytes}  ${(sources[at].bytes / 1e3 / best[at]).toFixed(2)}  ${sources[at].file}`,
	);
const rate = [...sources.keys()]
	.filter((at) => sources[at].bytes >= 5000)
	.sort((a, b) => sources[a].bytes / best[a] - sources[b].bytes / best[b]);
console.log(
	'lowest MB/s among files of 5 KB and over (MB/s, ms, bytes, file):',
);
for (const at of rate.slice(0, top))
	console.log(
		`  ${(sources[at].bytes / 1e3 / best[at]).toFixed(2)}  ${best[at].toFixed(2)}  ${sources[at].bytes}  ${sources[at].file}`,
	);
