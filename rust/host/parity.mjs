// Output stability of the wasm rewriter (rust/rwjs, a member of the core
// module), without a browser. The wasm core is the only rewriter now, so this
// no longer compares two backends: every rewrite family of src/rewriteJS.ts by
// shape (rust/host/cases.mjs) is rewritten by the module, and the digest of
// its outputs must be the one rust/host/cases.revision recorded under the
// module's revision. A rewrite that changed without REVISION being raised
// fails the run: that recorded-outputs check is the correctness oracle.
//
//   node rust/host/parity.mjs [--cases] [--family name] [-v] <dir-or-file>...
//
// --cases runs rust/host/cases.mjs (every rewrite family, by shape); a
// directory is a corpus (docs/rust-plan.md, section 11): an index.json of
// {file, url, bytes, module} entries, or plain .js files. TIME=1 times the
// module on what it rewrites. CORE_WASM names another artifact than
// assets/core.wasm (a fresh deploy/rust/out build).
//
// --cases also holds the module's revision (rust/rwjs/src/rewrite.rs
// REVISION, what a cache of rewrites keys on) to what it writes: the digest
// of its outputs for the cases is recorded beside the revision in
// rust/host/cases.revision, and a digest that changed under the same
// revision fails the run. RECORD=1 writes the file (after raising REVISION
// when the visitor's output changed, as it is when only cases were added).
import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** the scripts named by a path: an index.json directory, a directory of files, or one file */
function scripts(path) {
	const out = [];
	if (statSync(path).isFile()) {
		// a plain file says nothing of its kind: a module when it only parses
		// as one (decided below, once the module is loaded)
		out.push({
			name: path,
			module: /\.mjs$/.test(path) ? true : undefined,
			text: readFileSync(path, 'utf8'),
		});
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
				url: entry.url,
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

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const family = args.includes('--family')
	? args[args.indexOf('--family') + 1]
	: null;
const targets = args.filter(
	(arg, index) => !arg.startsWith('-') && args[index - 1] !== '--family',
);
const inputs = [];
if (args.includes('--cases') || family)
	inputs.push(...cases().filter((entry) => !family || entry.family === family));
for (const target of targets) inputs.push(...scripts(target));
if (!inputs.length) {
	console.error(
		'usage: parity.mjs [--cases] [--family name] [-v] <dir-or-file>...',
	);
	process.exit(2);
}

// the wasm rewriter, bundled as the suites bundle it
const esbuild = await import('esbuild');
// (a directory of its own, under test/out)
mkdirSync(`${root}test/out/`, { recursive: true });
const out = `${mkdtempSync(`${root}test/out/parity-`)}/`;
const entry = `${out}parity-entry.mjs`;
writeFileSync(
	entry,
	`export { scriptLead } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { compileModule, CoreInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
export { rewriteWith, rewriterRoute } from ${JSON.stringify(`${root}src/wasm/rewriter.ts`)};
`,
);
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: `${out}parity.mjs`,
	logLevel: 'silent',
});
const {
	scriptLead,
	StompURL,
	parseConfig,
	compileModule,
	CoreInstance,
	rewriteWith,
	rewriterRoute,
} = await import(`${out}parity.mjs?${Date.now()}`);
rmSync(out, { recursive: true, force: true });

const config = { directory: '/stomp/', codec: 'xor' };
const parsed = parseConfig(config, 'k');
const module = await compileModule(
	readFileSync(process.env.CORE_WASM || `${root}assets/core.wasm`),
);
let route = () => null;
/** the rewriter member of a fresh instance of the core */
const rewriterOf = () =>
	new CoreInstance(module, (member, kind, text) => route(kind, text)).members
		.rewriter;
let instance = rewriterOf();

const STATUS = {
	2: 'a URL did not route',
	3: 'not UTF-8',
	4: 'did not parse',
	5: 'a shape the rewriter declines',
	6: 'the edits did not nest',
	7: 'no browser runs it',
};

function wasm(text, url, type) {
	route = rewriterRoute(url, config, type);
	try {
		return rewriteWith(
			instance,
			text,
			url,
			config,
			type,
			scriptLead(url, config, type, ''),
		);
	} catch (error) {
		// a trap: the instance is dead
		instance = rewriterOf();
		return { trap: String(error) };
	}
}

/** the raw status the module answers for `text`, or null when it rewrote it */
function status(text, type) {
	const result = instance.call(text, type === 'genericModule' ? 2 : 0);
	return 'status' in result ? result.status : null;
}

/** why the module declined `text` */
function declined(text, type) {
	const code = status(text, type);
	return code === null ? 'declined' : (STATUS[code] ?? `status ${code}`);
}

/**
 * Whether the module's parser accepts `text` (as a module or a classic
 * script): the wasm module is the only parser now, so its own verdict stands
 * in for what used to be a separate parse. Status 4 is "did not parse";
 * any other answer (a rewrite, or a decline for another reason) means it
 * parsed.
 */
function parses(text, module) {
	return status(text, module ? 'genericModule' : 'generic') !== 4;
}

const median = (times) => [...times].sort((a, b) => a - b)[times.length >> 1];
function timed(work, runs = 3) {
	const times = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		work();
		times.push(performance.now() - start);
	}
	return median(times);
}

const tally = {
	rewritten: 0,
	unchanged: 0,
	declined: 0,
	gaveUp: 0,
	trapped: 0,
};
const reasons = new Map();
/** what the module wrote for the cases, for its revision */
const written = createHash('sha256');
const rows = [];
let bytes = 0;
for (const input of inputs) {
	const { name, text } = input;
	const isModule = input.module ?? (!parses(text, false) && parses(text, true));
	const type = isModule ? 'genericModule' : 'generic';
	const url = new StompURL(
		input.url && /^https?:/.test(input.url)
			? input.url
			: 'https://example.com/dir/a.js',
		parsed.codec,
		'/stomp/',
	);
	bytes += text.length;
	const out = wasm(text, url, type);
	// the digest the recorded revision keys on: the module's output for every
	// case, byte for byte (the correctness oracle). A script no browser runs
	// (status 7) comes back as it was, which is the module's answer and is
	// recorded as such; a decline (null) is recorded as "declined"
	if (input.family)
		written.update(`${typeof out === 'string' ? out : 'declined'}\0`);
	const label = `${name}${isModule ? ' (module)' : ''}`;
	const show = (line) =>
		console.log(
			`${line}${input.family ? `\n      source: ${JSON.stringify(text)}` : ''}`,
		);
	if (out && typeof out === 'object') {
		tally.trapped++;
		show(`TRAP ${label}: ${out.trap}`);
		continue;
	}
	if (out === null) {
		if (!parses(text, isModule)) tally.gaveUp++;
		else {
			const why = declined(text, type);
			reasons.set(why, (reasons.get(why) ?? 0) + 1);
			tally.declined++;
			if (verbose || input.family) show(`DECLINED ${label}: ${why}`);
		}
		continue;
	}
	if (out === text) tally.unchanged++;
	else tally.rewritten++;
	if (verbose && input.family)
		console.log(`ok ${label}\n      ${JSON.stringify(out)}`);
	if (process.env.TIME && out !== text) {
		const wasmMs = timed(() => wasm(text, url, type));
		rows.push({
			script: name.replace(/^\/tmp\/stomp-speed\/js\//, ''),
			KB: Math.round(text.length / 1024),
			outKB: Math.round(out.length / 1024),
			wasmMs: Math.round(wasmMs),
		});
	}
}

if (rows.length) {
	console.table(rows);
	const sum = (key) => rows.reduce((n, row) => n + row[key], 0);
	console.log(
		`total wasm ${sum('wasmMs')} ms over ${(bytes / 1024 / 1024).toFixed(1)} MB; instance memory ${Math.round(instance.memoryBytes / 1024 / 1024)} MB`,
	);
}
console.log(`${inputs.length} scripts`);
console.log(`  rewritten: ${tally.rewritten}`);
console.log(
	`  unchanged (nothing to route, or no browser runs it): ${tally.unchanged}`,
);
console.log(`  trapped: ${tally.trapped}`);
console.log(`  declined by the module: ${tally.declined}`);
for (const [why, count] of reasons) console.log(`    ${why}: ${count}`);
console.log(`  neither parses nor rewrites (does not parse): ${tally.gaveUp}`);
let stale = false;
if (args.includes('--cases') && !family) {
	const answered = instance.call('', 32);
	const revision = 'output' in answered ? answered.output : '?';
	const line = `${revision} ${written.digest('hex')}`;
	const file = `${root}rust/host/cases.revision`;
	let recorded = '';
	try {
		recorded = readFileSync(file, 'utf8').trim();
	} catch (error) {
		// not recorded yet
	}
	if (process.env.RECORD) {
		writeFileSync(file, `${line}\n`);
		console.log(`  revision ${revision}: recorded`);
	} else if (line === recorded)
		console.log(`  revision ${revision}: the outputs are the recorded ones`);
	else {
		stale = true;
		console.log(
			`  revision ${revision}: the outputs for the cases are not the recorded ones (${recorded.split(' ')[0] || 'none'}).\n  Raise REVISION in rust/rwjs/src/rewrite.rs when the visitor's output changed, then RECORD=1.`,
		);
	}
}
process.exit(tally.trapped || stale ? 1 : 0);
