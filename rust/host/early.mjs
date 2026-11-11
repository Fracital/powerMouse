// Early errors, three ways: what V8 refuses to compile, what the JavaScript
// rewriter (meriyah) makes of it, and what the wasm rewriter (rust/rwjs)
// makes of it, without a browser. The cases are rust/host/early-errors.txt
// (one text a line, with V8's recorded verdict as a classic script, a strict
// one and a module); each text is also run inside a function, an arrow, an
// async function, a generator, a method, a static block and a block, with
// V8 asked each time.
//
//   node rust/host/early.mjs [--narrow] [-v] [--list outcome] [file...]
//   node rust/host/early.mjs --record
//   node rust/host/early.mjs --corpus <dir-or-file>...
//
// For a script V8 refuses, a rewriter either hands it back as it was (the
// page gets V8's own SyntaxError), rewrites it into something V8 still
// refuses (a SyntaxError at the same moment), or rewrites it into something
// that RUNS, which is the defect. For one V8 takes, it rewrites it, hands it
// back unrewritten as if it did not parse (RAW: the page's code runs with
// the real globals), or rewrites it into something V8 refuses (BROKE). The
// module may also decline a script (the JavaScript rewriter then decides).
//
// The run fails on RUNS, RAW and BROKE of the wasm rewriter, on a recorded
// verdict that is not this V8's, and on anything short of V8's answer that
// rust/host/early-known.txt does not name: a script V8 refuses that is
// rewritten (and still refused), one V8 takes that is declined, a parse
// question (flags 64 and 128) answered otherwise than V8 does. A name in
// that file nothing needs any more fails it too.
//
// Eval code is strict when its caller is, which no rewriter sees. So each
// text sloppy code takes and strict code refuses is also rewritten as sloppy
// code and compiled behind `'use strict'`: V8 must refuse the rewrite as it
// refuses the text ("inherited strictness").
//
// --narrow runs only the three recorded forms. --record rewrites the file's
// verdict column from this V8 and drops a text that is there twice. A file
// argument is a list of the same format (verdicts are not checked for `?`).
// REWRITER_WASM names another artifact than assets/rewriter.wasm.
//
// --corpus is the other direction, over real scripts (a corpus directory
// with an index.json as rust/host/parity.mjs reads it, or any directory:
// its .js, .mjs and .cjs files and the inline scripts of its .html files):
// a script V8 takes must not be answered as one no browser runs, and the
// first parse question must be answered "yes" for it. It fails on either.
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CASES,
	NODE_DIFFERS,
	readCases,
	readKnown,
	STRICT,
	v8Verdicts,
	variants,
} from './early-lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const listed = args.includes('--list') ? args[args.indexOf('--list') + 1] : '';
const files = args.filter(
	(arg, index) => !arg.startsWith('-') && args[index - 1] !== '--list',
);

if (args.includes('--record')) {
	const lines = readCases();
	const seen = new Set();
	const kept = lines.filter((entry) => {
		if (entry.code === undefined) return true;
		if (seen.has(entry.text)) return false;
		seen.add(entry.text);
		return true;
	});
	const entries = kept.filter((entry) => entry.code !== undefined);
	const verdicts = v8Verdicts(entries.flatMap((entry) => variants(entry)));
	entries.forEach((entry, index) => {
		// (recorded from Chrome, by hand)
		if (NODE_DIFFERS.has(entry.text) && !entry.recorded.includes('?')) return;
		const marks = [0, 1, 2]
			.map((form) => (verdicts[index * 3 + form] === null ? '+' : '-'))
			.join('');
		entry.raw = `${marks} ${entry.text}`;
	});
	writeFileSync(CASES, kept.map((entry) => entry.raw).join('\n'));
	console.log(
		`${entries.length} cases recorded (${lines.length - kept.length} dropped as repeated)`,
	);
	process.exit(0);
}

const esbuild = await import('esbuild');
const out = `${root}test/out/`;
mkdirSync(out, { recursive: true });
const entry = `${out}early-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyJS, singleExpression } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { compileModule, BufferInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
`,
);
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['css-tree'],
	outfile: `${out}early.mjs`,
	logLevel: 'silent',
});
const { modifyJS, StompURL, parseConfig, compileModule, BufferInstance } =
	await import(`${out}early.mjs?${Date.now()}`);
const { parse } = await import(`${root}node_modules/meriyah/dist/meriyah.mjs`);

const config = { directory: '/stomp/', codec: 'xor' };
const parsed = parseConfig(config, 'k');
const url = new StompURL(
	'https://example.com/dir/a.js',
	parsed.codec,
	'/stomp/',
);
const compiled = await compileModule(
	readFileSync(process.env.REWRITER_WASM || `${root}assets/rewriter.wasm`),
);
// a static import routes to anything: only what compiles is asked here
const route = (kind, text) => `/routed/${kind}/${text.length}`;
let instance = new BufferInstance(compiled, route);
console.warn = () => {};

/** what the module makes of a script: `{ output }` or `{ status }` */
function wasm({ code, module }) {
	try {
		instance.configure(
			'access\t$s$j\nclient\t$P$s\nglobalProxy\t$s$g\nglobalName\t$s$n\n',
		);
		instance.call(`${url}\n\n\n`, 8);
		return instance.call(code, module ? 2 : 0);
	} catch (error) {
		instance = new BufferInstance(compiled, route);
		return { status: 'trap' };
	}
}

/** the module's answer to a parse question (flag 64 or 128) */
function asked(code, flag) {
	const answered = instance.call(code, flag);
	return 'output' in answered ? answered.output === '1' : null;
}

/** the scripts under a path: `{ name, code, module }`, `module` undefined when nothing says */
function corpus(path, out = []) {
	if (statSync(path).isFile()) {
		if (/\.(js|mjs|cjs)$/.test(path))
			out.push({
				name: path,
				code: readFileSync(path, 'utf8'),
				module: /\.mjs$/.test(path) ? true : undefined,
			});
		else if (/\.html?$/.test(path)) {
			const html = readFileSync(path, 'utf8');
			let count = 0;
			for (const [, attributes, code] of html.matchAll(
				/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
			)) {
				const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attributes)?.[1];
				if (/\bsrc\s*=/i.test(attributes) || !code.trim()) continue;
				if (type && !/^(module|(text|application)\/javascript)$/i.test(type))
					continue;
				out.push({
					name: `${path}#${count++}`,
					code,
					module: type?.toLowerCase() === 'module',
				});
			}
		}
		return out;
	}
	const names = readdirSync(path);
	// (a corpus's index.json lists its files; a package's own is no index)
	let index = null;
	if (names.includes('index.json'))
		try {
			index = JSON.parse(readFileSync(join(path, 'index.json'), 'utf8'));
		} catch (error) {
			// not JSON
		}
	if (
		Array.isArray(index) &&
		index.length &&
		index.every((entry) => typeof entry?.file === 'string')
	) {
		for (const entry of index) {
			const file = entry.file.startsWith('/')
				? entry.file
				: join(path, entry.file);
			out.push({
				name: file,
				code: readFileSync(file, 'utf8'),
				module: !!entry.module,
			});
		}
		return out;
	}
	for (const name of names) {
		const child = join(path, name);
		let stat;
		try {
			stat = statSync(child);
		} catch (error) {
			continue;
		}
		if (stat.isDirectory() || stat.size < 32 * 1024 * 1024) corpus(child, out);
	}
	return out;
}

if (args.includes('--corpus')) {
	const found = files.flatMap((path) => corpus(path));
	// what nothing names a kind of is a script if V8 takes it as one
	const asScript = v8Verdicts(
		found.map(({ code }) => ({ code, module: false })),
	);
	const asModule = v8Verdicts(
		found.map(({ code }) => ({ code, module: true })),
	);
	const counts = {};
	const count = (what) => (counts[what] = (counts[what] ?? 0) + 1);
	const bad = [];
	const outputs = [];
	found.forEach((script, index) => {
		if (script.module === undefined) script.module = asScript[index] !== null;
		const verdict = (script.module ? asModule : asScript)[index];
		const answer = wasm(script);
		const kind = script.module ? 'module' : 'script';
		if (verdict === null) {
			if ('output' in answer) count(`V8 takes the ${kind}: rewritten`);
			else if (answer.status === 7) {
				count(`V8 takes the ${kind}: ANSWERED AS ONE NO BROWSER RUNS`);
				bad.push(`${script.name}: status 7, V8 takes it`);
			} else {
				count(`V8 takes the ${kind}: declined, status ${answer.status}`);
				if (verbose) console.log(`declined (${answer.status}): ${script.name}`);
			}
			if (!script.module && asked(script.code, 64) !== true) {
				count('V8 takes the script: THE PARSE QUESTION SAYS NO');
				bad.push(`${script.name}: flag 64 says no, V8 takes it`);
			}
		} else if ('output' in answer) {
			outputs.push({
				script,
				code: answer.output,
				module: script.module,
				verdict,
			});
		} else
			count(
				`V8 refuses the ${kind}: ${answer.status === 7 ? 'as it was' : `declined, status ${answer.status}`}`,
			);
	});
	v8Verdicts(outputs).forEach((after, index) => {
		const { script, verdict } = outputs[index];
		const kind = script.module ? 'module' : 'script';
		if (after === null) {
			count(`V8 refuses the ${kind}: THE REWRITE RUNS`);
			bad.push(
				`${script.name}: V8 refuses it (${verdict}) and takes the rewrite`,
			);
		} else count(`V8 refuses the ${kind}: rewritten, still refused`);
		if (verbose) console.log(`refused (${verdict}): ${script.name}`);
	});
	const bytes = found.reduce((sum, { code }) => sum + code.length, 0);
	console.log(
		`${found.length} scripts, ${(bytes / 1048576).toFixed(1)} MB (UTF-16 units)`,
	);
	console.table(counts);
	for (const line of bad.slice(0, 40)) console.log(line);
	// (the whole of what was printed first: an exit cuts a pipe short)
	process.exitCode = bad.length ? 1 : 0;
	await new Promise((done) => process.stdout.write('', done));
	process.exit();
}

const cases = (
	files.length ? files.flatMap((file) => readCases(file)) : readCases()
).filter((entry) => entry.code !== undefined);
// (a text node answers otherwise than Chrome has only its recorded forms)
const scripts = cases.flatMap((entry) =>
	variants(entry, !args.includes('--narrow') && !NODE_DIFFERS.has(entry.text)),
);
const known = readKnown();
const needed = new Set();
/** whether a script's text is named as one of `kinds` in early-known.txt */
const named = (script, ...kinds) => {
	if (!kinds.includes(known.get(script.text))) return false;
	needed.add(script.text);
	return true;
};

/** what the JavaScript rewriter makes of a script, null when it gives up */
function javascript({ code, module }) {
	try {
		parse(code, { module, next: true, globalReturn: true, webcompat: true });
	} catch (error) {
		return null;
	}
	const output = modifyJS(
		code,
		url,
		config,
		module ? 'genericModule' : 'generic',
	);
	// (a script it parsed and then could not rewrite comes back as it was)
	return output === code ? null : output;
}

// V8 on every source, then on every rewrite. Where node's V8 is known to
// answer otherwise than Chrome's, the recorded verdict stands
const refused = v8Verdicts(scripts);
scripts.forEach((script, index) => {
	if (NODE_DIFFERS.has(script.text) && script.recorded !== undefined)
		refused[index] =
			script.recorded === '-' ? 'SyntaxError: (as recorded from Chrome)' : null;
});
const rewrites = [];
for (const script of scripts) {
	script.js = javascript(script);
	script.wasm = wasm(script);
	if (script.js !== null)
		rewrites.push({ code: script.js, module: script.module });
	if ('output' in script.wasm)
		rewrites.push({ code: script.wasm.output, module: script.module });
}
const rewritten = v8Verdicts(rewrites);
let at = 0;

// inherited strictness: the sloppy rewrite of what only strict code refuses
const inherited = [];
scripts.forEach((script, index) => {
	if (script.name !== 'script' || script.recorded !== '+') return;
	if (refused[index + 1] === null) return;
	for (const backend of ['js', 'wasm']) {
		const output = backend === 'js' ? script.js : script.wasm.output;
		if (typeof output === 'string')
			inherited.push({ backend, script, code: STRICT + output, module: false });
	}
});
const inheritedVerdicts = v8Verdicts(inherited);

const OUTCOMES = [
	// V8 refuses the source
	'as it was',
	'still refused',
	'still refused, other message',
	'RUNS',
	// V8 takes the source
	'rewritten',
	'RAW',
	'BROKE',
	// the module only: handed to the JavaScript rewriter
	'declined',
];
const table = { js: {}, wasm: {} };
for (const backend of ['js', 'wasm'])
	for (const side of ['refused', 'taken']) {
		table[backend][side] = Object.fromEntries(
			OUTCOMES.map((name) => [name, 0]),
		);
	}
const examples = new Map();
const note = (backend, side, outcome, script, detail = '') => {
	table[backend][side][outcome]++;
	const key = `${backend} ${side} ${outcome}`;
	if (!examples.has(key)) examples.set(key, []);
	examples.get(key).push({ script, detail });
};
const statuses = new Map();
/** what a script the module declined ends as in the JavaScript rewriter */
const declines = { refused: {}, taken: {} };
let stale = 0;
let parseWrong = 0;
let singleWrong = 0;
/** what the module does short of V8's answer that no line of early-known.txt names */
const unnamed = [];

scripts.forEach((script, index) => {
	const verdict = refused[index];
	const sourceRefused = verdict !== null;
	const where = sourceRefused ? 'refused' : 'taken';
	if (
		script.recorded !== undefined &&
		script.recorded !== '?' &&
		(script.recorded === '-') !== sourceRefused
	) {
		stale++;
		console.log(
			`STALE line ${script.line} (${script.name}): recorded ${script.recorded}, this V8 says ${verdict ?? 'compiles'}\n      ${JSON.stringify(script.code)}`,
		);
	}
	const classify = (backend, output) => {
		let outcome;
		let detail = '';
		if (output === null) outcome = sourceRefused ? 'as it was' : 'RAW';
		else {
			const after = rewritten[at++];
			if (sourceRefused && after === null && !NODE_DIFFERS.has(script.text)) {
				outcome = 'RUNS';
				detail = output;
			} else if (sourceRefused) {
				outcome =
					after === verdict || NODE_DIFFERS.has(script.text)
						? 'still refused'
						: 'still refused, other message';
				detail = `${verdict} / ${after}`;
			} else if (after === null) outcome = 'rewritten';
			else {
				outcome = 'BROKE';
				detail = `${after}\n      ${output}`;
			}
		}
		note(backend, where, outcome, script, detail);
		return outcome;
	};
	const ended = classify('js', script.js);
	if ('output' in script.wasm) {
		const outcome = classify('wasm', script.wasm.output);
		if (outcome.startsWith('still refused') && !named(script, 'top', 'return'))
			unnamed.push({ script, what: outcome });
	} else if (script.wasm.status === 7) classify('wasm', null);
	else {
		const { status } = script.wasm;
		statuses.set(status, (statuses.get(status) ?? 0) + 1);
		note(
			'wasm',
			where,
			'declined',
			script,
			`status ${status}; the JavaScript rewriter: ${ended}`,
		);
		declines[where][ended] = (declines[where][ended] ?? 0) + 1;
		if (!sourceRefused && !named(script, status === 4 ? 'parser' : 'shape'))
			unnamed.push({ script, what: `declined, status ${status}` });
	}

	// the parse questions are of a classic script; a top-level `return` is
	// a function body's and is let through by both parsers on purpose
	if (!script.module && !/Illegal return/.test(verdict ?? '')) {
		const answer = asked(script.code, 64);
		if (answer !== !sourceRefused) {
			parseWrong++;
			if (sourceRefused || !named(script, 'parser'))
				unnamed.push({
					script,
					what: `parses as a script: the module says ${answer}, V8 ${verdict ?? 'compiles'}`,
				});
		}
		const single = asked(script.code, 128);
		let shape = null;
		try {
			const program = parse(script.code, { next: true, webcompat: true });
			shape =
				program.body.length === 1 &&
				program.body[0].type === 'ExpressionStatement';
		} catch (error) {
			// meriyah does not take it: only V8's refusal is held
		}
		if (sourceRefused ? single !== false : shape !== null && single !== shape) {
			singleWrong++;
			if (sourceRefused || !named(script, 'parser'))
				unnamed.push({
					script,
					what: `single expression: the module says ${single}, ${sourceRefused ? `V8 ${verdict}` : `it is ${shape}`}`,
				});
		}
	}
});

const total = { refused: 0, taken: 0 };
refused.forEach((verdict) => total[verdict === null ? 'taken' : 'refused']++);
console.log(
	`${cases.length} texts, ${scripts.length} scripts: V8 refuses ${total.refused}, takes ${total.taken}`,
);
for (const side of ['refused', 'taken']) {
	console.log(
		`\nV8 ${side === 'refused' ? 'refuses' : 'takes'} (${total[side]})`,
	);
	console.table(
		Object.fromEntries(
			OUTCOMES.filter(
				(name) => table.js[side][name] || table.wasm[side][name],
			).map((name) => [
				name,
				{ javascript: table.js[side][name], wasm: table.wasm[side][name] },
			]),
		),
	);
}
if (statuses.size)
	console.log(
		`declined by status: ${[...statuses].map(([status, count]) => `${status}: ${count}`).join(', ')}`,
	);
for (const side of ['refused', 'taken'])
	if (Object.keys(declines[side]).length)
		console.log(
			`  of what V8 ${side === 'refused' ? 'refuses' : 'takes'}, the JavaScript rewriter then: ${Object.entries(
				declines[side],
			)
				.map(([outcome, count]) => `${outcome} ${count}`)
				.join(', ')}`,
		);
console.log(
	`parse question (flag 64) answers that are not V8's: ${parseWrong}; single expression (flag 128): ${singleWrong}; recorded verdicts that are not this V8's: ${stale}`,
);
const inheritedRuns = { js: [], wasm: [] };
inherited.forEach(({ backend, script }, index) => {
	if (inheritedVerdicts[index] === null) inheritedRuns[backend].push(script);
});
console.log(
	`inherited strictness: ${inherited.length / 2} sloppy rewrites behind 'use strict' of what strict code alone refuses; V8 takes ${inheritedRuns.js.length} of the JavaScript rewriter's, ${inheritedRuns.wasm.length} of the module's`,
);
for (const backend of ['js', 'wasm'])
	for (const script of inheritedRuns[backend].slice(0, verbose ? Infinity : 12))
		console.log(
			`  ${backend} ${script.line}: ${script.text}${verbose ? `\n      ${backend === 'js' ? script.js : script.wasm.output}` : ''}`,
		);
const kinds = {};
for (const kind of known.values()) kinds[kind] = (kinds[kind] ?? 0) + 1;
console.log(
	`named in early-known.txt: ${Object.entries(kinds)
		.map(([kind, count]) => `${kind} ${count}`)
		.join(', ')}`,
);

const show = (key, limit) => {
	const found = examples.get(key) ?? [];
	if (!found.length) return;
	// one line per text: the forms it shows in
	const byText = new Map();
	for (const { script, detail } of found) {
		if (!byText.has(script.text))
			byText.set(script.text, { forms: [], detail, line: script.line });
		byText.get(script.text).forms.push(script.name);
	}
	console.log(`\n${key}: ${found.length} scripts of ${byText.size} texts`);
	let shown = 0;
	for (const [text, { forms, detail, line }] of byText) {
		if (shown++ >= limit) {
			console.log(`  ... ${byText.size - limit} more`);
			break;
		}
		console.log(
			`  ${line}: ${text}   [${forms.length > 6 ? `${forms.slice(0, 6).join(', ')}, +${forms.length - 6}` : forms.join(', ')}]${verbose && detail ? `\n      ${detail}` : ''}`,
		);
	}
};
const BAD = ['RUNS', 'RAW', 'BROKE'];
for (const backend of ['wasm', 'js'])
	for (const side of ['refused', 'taken'])
		for (const outcome of OUTCOMES) {
			const key = `${backend} ${side} ${outcome}`;
			if (listed ? key.includes(listed) : BAD.includes(outcome))
				show(key, listed || verbose ? Infinity : 12);
		}

if (unnamed.length) {
	console.log(`\nnot named in early-known.txt: ${unnamed.length}`);
	for (const { script, what } of unnamed.slice(0, verbose ? Infinity : 40))
		console.log(
			`  ${script.line} (${script.name}): ${script.text}\n      ${what}`,
		);
}
// (a part of the corpus does not need every name)
const whole = !files.length && !args.includes('--narrow');
const idle = whole ? [...known.keys()].filter((text) => !needed.has(text)) : [];
if (idle.length)
	console.log(
		`\nnamed in early-known.txt and no longer needed:\n  ${idle.join('\n  ')}`,
	);

const failed =
	stale ||
	unnamed.length ||
	idle.length ||
	inheritedRuns.wasm.length ||
	BAD.some((name) => table.wasm.refused[name] || table.wasm.taken[name]);
process.exitCode = failed ? 1 : 0;
