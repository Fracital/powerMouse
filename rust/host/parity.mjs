// Output parity between the wasm rewriter (rust/rwjs) and the JavaScript one
// (src/rewriteJS.ts), without a browser. The two do not print alike: the
// JavaScript rewriter prints its tree, the wasm one splices edits into the
// script's own text. So each output is parsed again and the two programs
// are compared as trees (printed compact from the tree, empty statements
// dropped), and the function marks, which are comments, as the lists they
// are. A script the module declines is counted apart: it is the JavaScript
// rewriter's in a browser, which is correct and slow.
//
//   node rust/host/parity.mjs [--cases] [--family name] [-v] <dir-or-file>...
//
// --cases runs rust/host/cases.mjs (every rewrite family, by shape); a
// directory is a corpus (docs/rust-plan.md, section 11): an index.json of
// {file, url, bytes, module} entries, or plain .js files. TIME=1 times both
// backends on what they agree on. REWRITER_WASM names another artifact than
// assets/rewriter.wasm (a fresh deploy/rust/out build).
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
	readdirSync,
	readFileSync,
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
		// as one (decided below, once the parser is loaded)
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

// both rewriters, bundled as the suites bundle them
const esbuild = await import('esbuild');
const out = `${root}test/out/`;
mkdirSync(out, { recursive: true });
const entry = `${out}parity-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyJS, scriptLead } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { compileModule, BufferInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
export { rewriteWith, rewriterRoute } from ${JSON.stringify(`${root}src/wasm/rewriter.ts`)};
`,
);
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['css-tree'],
	outfile: `${out}parity.mjs`,
	logLevel: 'silent',
});
const {
	modifyJS,
	scriptLead,
	StompURL,
	parseConfig,
	compileModule,
	BufferInstance,
	rewriteWith,
	rewriterRoute,
} = await import(`${out}parity.mjs?${Date.now()}`);
const { parse } = await import(`${root}node_modules/meriyah/dist/meriyah.mjs`);
const { generate } = await import('@javascript-obfuscator/escodegen');

const config = { directory: '/stomp/', codec: 'xor' };
const parsed = parseConfig(config, 'k');
const module = await compileModule(
	readFileSync(process.env.REWRITER_WASM || `${root}assets/rewriter.wasm`),
);
let route = () => null;
let instance = new BufferInstance(module, (kind, text) => route(kind, text));
// the JavaScript rewriter warns about a script it cannot parse
console.warn = () => {};

const STATUS = {
	2: 'a URL did not route',
	3: 'not UTF-8',
	4: 'did not parse',
	5: 'a shape left to the JavaScript rewriter',
	6: 'the edits did not nest',
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
		instance = new BufferInstance(module, (kind, text) => route(kind, text));
		return { trap: String(error) };
	}
}

/** why the module declined `text` */
function declined(text, type) {
	const result = instance.call(text, type === 'genericModule' ? 2 : 0);
	return 'status' in result
		? (STATUS[result.status] ?? `status ${result.status}`)
		: 'declined';
}

const MARK = /\/\*[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+\*\//g;
const HOLDER = /\.src\("[0-9a-z]+","[^"]*",function\(\)\{\/\*[^]*?\*\/\}\);/;

/** the statement lists an empty statement means nothing in */
const LISTS = new Set(['Program', 'BlockStatement', 'StaticBlock']);

/** a tree both rewriters' outputs print alike from */
function clean(node, access) {
	if (Array.isArray(node)) {
		for (const item of node) clean(item, access);
		return;
	}
	if (!node || typeof node !== 'object') return;
	if (LISTS.has(node.type) && Array.isArray(node.body))
		node.body = node.body.filter((item) => item.type !== 'EmptyStatement');
	if (node.type === 'SwitchCase')
		node.consequent = node.consequent.filter(
			(item) => item.type !== 'EmptyStatement',
		);
	// a hoisted parameter's pattern has no text of its own to name in an
	// error: the JavaScript rewriter prints the declaration it made, the wasm
	// one quotes the page's pattern, and neither is checked beyond being there
	if (
		node.type === 'CallExpression' &&
		node.callee.type === 'MemberExpression' &&
		node.callee.object.name === access &&
		node.callee.property.name === 'pattern' &&
		node.arguments[0]?.type === 'Identifier' &&
		node.arguments[0].name.startsWith(`${access}a`) &&
		node.arguments[2]?.type === 'Literal'
	)
		node.arguments[2] = { type: 'Literal', value: 'hoisted' };
	for (const key in node) {
		const value = node[key];
		if (value && typeof value === 'object') clean(value, access);
	}
}

function normal(code, module) {
	const tree = parse(code, {
		module,
		next: true,
		globalReturn: true,
		webcompat: true,
	});
	clean(tree, '$s$j');
	return generate(tree, { format: { compact: true } });
}

/** where two strings part, with what stands around it in each */
function parting(a, b) {
	let at = 0;
	while (at < a.length && at < b.length && a[at] === b[at]) at++;
	const around = (text) =>
		JSON.stringify(text.slice(Math.max(0, at - 100), at + 140));
	return `at ${at}\n      js:   ${around(a)}\n      wasm: ${around(b)}`;
}

function compare(text, js, out, module) {
	let a;
	let b;
	try {
		a = normal(js, module);
	} catch (error) {
		return `the JavaScript output does not parse: ${error}`;
	}
	try {
		b = normal(out, module);
	} catch (error) {
		return `the wasm output does not parse: ${error}\n      wasm: ${JSON.stringify(out.slice(0, 400))}`;
	}
	if (a !== b) return `the programs differ ${parting(a, b)}`;
	const marksJS = (js.match(MARK) ?? []).sort();
	const marksOut = (out.match(MARK) ?? []).sort();
	// (a page's own comment may look like a mark: it is in the wasm output
	// only, where comments stay)
	const page = (text.match(MARK) ?? []).length;
	if (
		marksJS.length !== marksOut.length - page ||
		(!page && marksJS.join() !== marksOut.join())
	) {
		const only = (from, other) => from.filter((mark) => !other.includes(mark));
		return `the marks differ: ${marksJS.length} js, ${marksOut.length} wasm; js only ${only(marksJS, marksOut).slice(0, 5)}; wasm only ${only(marksOut, marksJS).slice(0, 5)}`;
	}
	const holderJS = HOLDER.exec(js)?.[0];
	const holderOut = HOLDER.exec(out)?.[0];
	if (holderJS !== holderOut && !page)
		return `the holders differ ${parting(holderJS ?? '', holderOut ?? '')}`;
	return null;
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
	same: 0,
	differ: 0,
	known: 0,
	declined: 0,
	gaveUp: 0,
	trapped: 0,
};
const reasons = new Map();
/** what the module wrote for the cases, for its revision */
const written = createHash('sha256');
const rows = [];
let bytes = 0;
const parses = (text, module) => {
	try {
		parse(text, { module, next: true, globalReturn: true, webcompat: true });
		return true;
	} catch (error) {
		return false;
	}
};
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
	const js = modifyJS(text, url, config, type);
	const out = wasm(text, url, type);
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
	// the JavaScript rewriter hands back what it cannot parse as it was
	let gaveUp = false;
	try {
		parse(text, {
			module: isModule,
			next: true,
			globalReturn: true,
			webcompat: true,
		});
	} catch (error) {
		gaveUp = true;
	}
	if (out === null) {
		if (gaveUp) tally.gaveUp++;
		else {
			const why = declined(text, type);
			reasons.set(why, (reasons.get(why) ?? 0) + 1);
			tally.declined++;
			if (verbose || input.family) show(`DECLINED ${label}: ${why}`);
		}
		continue;
	}
	if (gaveUp) {
		tally.differ++;
		show(
			`DIFF ${label}: the wasm rewriter took what the JavaScript one gives up`,
		);
		continue;
	}
	const difference = compare(text, js, out, isModule);
	if (input.diverges) {
		tally.known++;
		console.log(
			`KNOWN ${label}: ${input.diverges}${difference ? '' : ' (the outputs are the same now)'}\n      source: ${JSON.stringify(text)}`,
		);
		continue;
	}
	if (difference) {
		tally.differ++;
		show(`DIFF ${label}: ${difference}`);
		continue;
	}
	tally.same++;
	if (verbose && input.family)
		console.log(`same ${label}\n      ${JSON.stringify(out)}`);
	if (process.env.TIME) {
		const wasmMs = timed(() => wasm(text, url, type));
		const jsMs = timed(() => modifyJS(text, url, config, type));
		rows.push({
			script: name.replace(/^\/tmp\/stomp-speed\/js\//, ''),
			KB: Math.round(text.length / 1024),
			outKB: Math.round(out.length / 1024),
			jsOutKB: Math.round(js.length / 1024),
			wasmMs: Math.round(wasmMs),
			jsMs: Math.round(jsMs),
			ratio: +(jsMs / wasmMs).toFixed(1),
		});
	}
}

if (rows.length) {
	console.table(rows);
	const sum = (key) => rows.reduce((n, row) => n + row[key], 0);
	console.log(
		`total wasm ${sum('wasmMs')} ms, js ${sum('jsMs')} ms over ${(bytes / 1024 / 1024).toFixed(1)} MB (${(sum('jsMs') / sum('wasmMs')).toFixed(1)}x); instance memory ${Math.round(instance.memoryBytes / 1024 / 1024)} MB`,
	);
}
console.log(`${inputs.length} scripts`);
console.log(`  same program, marks and holder: ${tally.same}`);
console.log(`  differ: ${tally.differ}`);
console.log(`  known divergences (rust/host/cases.mjs): ${tally.known}`);
console.log(`  trapped: ${tally.trapped}`);
console.log(
	`  declined by the module (the JavaScript rewriter's): ${tally.declined}`,
);
for (const [why, count] of reasons) console.log(`    ${why}: ${count}`);
console.log(`  neither rewrites (does not parse): ${tally.gaveUp}`);
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
process.exit(tally.differ || tally.trapped || stale ? 1 : 0);
