// Parse parity between oxc (the wasm rewriter) and meriyah (the JavaScript
// one), over a corpus, without a browser. The wasm backend may only answer
// for a script both parsers accept: oxc rejecting what meriyah accepts would
// turn a working script into a fallback (slow but correct), and oxc
// accepting what meriyah rejects would rewrite something the JavaScript
// rewriter hands back untouched. Both are reported; only the first is
// tolerable, and even that is counted.
//
//   node rust/host/parity.mjs <dir-or-file>...        # files or index.json dirs
//
// The corpora live in /tmp (docs/rust-plan.md, section 11): a directory with
// an index.json of {file, url, bytes, module} entries, or plain .js files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** the scripts named by a path: an index.json directory, a directory of files, or one file */
function scripts(path) {
	const out = [];
	if (statSync(path).isFile()) {
		out.push({ name: path, module: false, text: readFileSync(path, 'utf8') });
		return out;
	}
	const names = readdirSync(path);
	if (names.includes('index.json')) {
		const index = JSON.parse(readFileSync(join(path, 'index.json'), 'utf8'));
		for (const entry of index) {
			// the index names its files absolutely or beside itself
			const file = entry.file.startsWith('/')
				? entry.file
				: join(path, entry.file);
			out.push({
				name: file,
				module: !!entry.module,
				text: readFileSync(file, 'utf8'),
			});
		}
		return out;
	}
	for (const name of names)
		if (/\.(js|txt|mjs)$/.test(name)) out.push(...scripts(join(path, name)));
	return out;
}

const targets = process.argv.slice(2);
if (!targets.length) {
	console.error('usage: parity.mjs <dir-or-file>...');
	process.exit(2);
}

const { parse } = await import(`${root}node_modules/meriyah/dist/meriyah.mjs`);

/** whether meriyah parses it, as modifyJS parses it (src/rewriteJS.ts) */
function meriyahParses(text, module) {
	try {
		parse(text, {
			module,
			next: true,
			ranges: true,
			globalReturn: true,
			webcompat: true,
		});
		return true;
	} catch (error) {
		return false;
	}
}

// oxc answers through the artifact: status 4 is "the parser could not make a
// program of this", which is what the fallback keys on
const FLAG_MODULE = 2;
const { compileModule, BufferInstance } = await import(
	`${root}test/out/wasm-artifact.mjs`
).catch(() => {
	console.error(
		'build the loader bundle first: run the wasm-artifact suite, which writes test/out/wasm-artifact.mjs',
	);
	process.exit(2);
});
// REWRITER_WASM names another artifact (a fresh deploy/rust/out build while
// dist/ is in use by a suite run)
const module = await compileModule(
	readFileSync(process.env.REWRITER_WASM || `${root}dist/rewriter.wasm`),
);
const instance = new BufferInstance(module);
instance.configure('{}');

function oxcParses(text, module) {
	const result = instance.call(text, module ? FLAG_MODULE : 0);
	return 'output' in result;
}

/** median of `times`, in ms */
const median = (times) => {
	const sorted = [...times].sort((a, b) => a - b);
	return sorted[sorted.length >> 1] ?? 0;
};

/** ms of `work()` run `runs` times, the median (the first run warms up) */
function timed(work, runs = 3) {
	const times = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		work();
		times.push(performance.now() - start);
	}
	return median(times);
}

let total = 0;
let bytes = 0;
const bothOk = [];
const oxcOnly = [];
const meriyahOnly = [];
const neither = [];
const rows = [];
for (const target of targets)
	for (const { name, text, module } of scripts(target)) {
		total++;
		bytes += text.length;
		const o = oxcParses(text, module);
		const m = meriyahParses(text, module);
		const where = o && m ? bothOk : o ? oxcOnly : m ? meriyahOnly : neither;
		where.push(`${name}${module ? ' (module)' : ''}`);
		if (o && m && process.env.TIME) {
			// oxc through the artifact (the copy in, the parse, the copy out,
			// as a rewrite pays them) against meriyah's parse alone
			const oxcMs = timed(() => instance.call(text, module ? FLAG_MODULE : 0));
			const meriyahMs = timed(() => meriyahParses(text, module));
			rows.push({
				script: name.replace(/^\/tmp\/stomp-speed\/js\//, ''),
				KB: Math.round(text.length / 1024),
				oxcMs: Math.round(oxcMs),
				meriyahMs: Math.round(meriyahMs),
				ratio: +(meriyahMs / oxcMs).toFixed(2),
			});
		}
	}

if (rows.length) {
	console.table(rows);
	const sum = (key) => rows.reduce((n, row) => n + row[key], 0);
	console.log(
		`total oxc ${sum('oxcMs')} ms, meriyah ${sum('meriyahMs')} ms over ${Math.round(bytes / 1024 / 1024)} MB`,
	);
}
console.log(`${total} scripts`);
console.log(`  both parse: ${bothOk.length}`);
console.log(`  neither parses: ${neither.length}`);
console.log(`  meriyah only (oxc would fall back): ${meriyahOnly.length}`);
for (const name of meriyahOnly.slice(0, 20)) console.log(`    ${name}`);
console.log(
	`  oxc only (the JS rewriter hands these back untouched): ${oxcOnly.length}`,
);
for (const name of oxcOnly.slice(0, 20)) console.log(`    ${name}`);
process.exit(meriyahOnly.length || oxcOnly.length ? 1 : 0);
