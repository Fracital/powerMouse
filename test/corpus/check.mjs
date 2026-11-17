// The real-site rewrite gate: every script of a corpus rewritten by the wasm
// core (src/rewriteJS.ts modifyJS, the service worker's call) and the result
// held to what V8 makes of the original. Minified bundles are where the
// rewriter's text edits break (no spaces between tokens, unusual adjacency,
// huge files); the suites' hand-written shapes rarely are.
//
//   node test/corpus/check.mjs [-v] [--minify] [--json <file>] [--out <dir>] <corpus>...
//
// A corpus is a directory: a manifest.json of test/corpus/fetch.mjs (the
// full corpus, kept outside the repository), or plain files (test/corpus/
// sample/, which CI checks through the rewrite-corpus suite): `.mjs` a
// module, `.worker.js` a classic worker, `.handler.js` an event handler
// attribute's code, any other `.js` a classic script. An inline classic
// script is rewritten with its preamble, as the page gets it. --minify
// checks each script a second time as esbuild's minifier prints it, which
// leaves out every space it can. CORE_WASM names another artifact than
// assets/core.wasm.
//
// Each script is compiled by V8 (node's vm: vm.Script for the script goal,
// vm.SourceTextModule for a module, vm.compileFunction for a handler; never
// `new Function` for a script, whose body takes `return` and `new.target`
// and so differs from the script goal) in the goal it is loaded with, and a
// manifest's `unknown` (a preload) in the first goal that takes it. One V8
// refuses as it came is not checked (-v lists them). Then:
//   broken    the rewrite does not compile in the goal the original did: a
//             bug, the page gets a SyntaxError where it ran
//   declined  the rewriter gave the script up (it threw, or handed it back
//             ended with UNREWRITTEN_END, or as it came) though V8 takes it:
//             the page loses the script
//   loses     the rewrite compiles but has fewer nodes of a kind the
//             rewriter only ever adds (statements, functions, classes,
//             literals, directives, ...; parsed by acorn): code went missing
//             or was swallowed into a comment or a string. Insertions only
//             add nodes, so a loss is sound evidence; a gain is not checked.
// Exit code 1 when any script is broken, declined or loses.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));

// vm.SourceTextModule is behind a flag
if (!vm.SourceTextModule) {
	const run = spawnSync(
		process.execPath,
		[
			'--experimental-vm-modules',
			'--no-warnings',
			'--stack-size=8000',
			...process.argv.slice(1),
		],
		{ stdio: 'inherit' },
	);
	process.exit(run.status ?? 1);
}

const args = process.argv.slice(2);
const option = (name) => {
	const at = args.indexOf(name);
	if (at === -1) return null;
	const [, value] = args.splice(at, 2);
	return value;
};
const verbose = args.includes('-v');
const minify = args.includes('--minify');
const jsonFile = option('--json');
const outDir = option('--out');
const targets = args.filter((arg) => !arg.startsWith('-'));
if (!targets.length) {
	console.error(
		'usage: node test/corpus/check.mjs [-v] [--json <file>] [--out <dir>] <corpus>...',
	);
	process.exit(2);
}

/** the scripts of a corpus directory, one per distinct text */
function corpus(dir) {
	const scripts = new Map();
	const add = (entry, file) => {
		const text = readFileSync(file, 'utf8');
		const sha256 = createHash('sha256').update(text).digest('hex');
		const known = scripts.get(sha256);
		if (known) {
			known.from.push(entry);
			return;
		}
		scripts.set(sha256, {
			sha256,
			text,
			kind: entry.kind,
			inline: entry.inline === true,
			from: [entry],
		});
	};
	const manifest = join(dir, 'manifest.json');
	if (existsSync(manifest)) {
		for (const entry of JSON.parse(readFileSync(manifest, 'utf8')).scripts)
			if (entry.file)
				add(
					{
						site: entry.site,
						url: entry.url,
						kind: entry.kind,
						inline: entry.inline,
					},
					join(dir, entry.file),
				);
		return [...scripts.values()];
	}
	for (const name of readdirSync(dir).sort()) {
		if (!/\.m?js$/.test(name)) continue;
		const kind = name.endsWith('.mjs')
			? 'module'
			: name.endsWith('.worker.js')
				? 'worker'
				: name.endsWith('.handler.js')
					? 'handler'
					: 'classic';
		add(
			{ site: name.replace(/[.-].*$/, ''), url: name, kind },
			join(dir, name),
		);
	}
	return [...scripts.values()];
}

/**
 * V8's verdict on `code` in a goal (`script`, `module`, or `handler`: an
 * event handler attribute, compiled as a function's body): null when it
 * compiles, the error when not
 */
function v8(code, goal) {
	try {
		if (goal === 'module')
			new vm.SourceTextModule(code, { identifier: 'corpus.mjs' });
		else if (goal === 'handler')
			vm.compileFunction(code, ['event'], { filename: 'corpus.js' });
		else new vm.Script(code, { filename: 'corpus.js' });
		return null;
	} catch (error) {
		return error;
	}
}

/** where `code` stops parsing, as text around it (acorn's position: V8's message has none) */
function around(code, goal) {
	if (!acorn) return '';
	try {
		acorn.parse(code, {
			ecmaVersion: 'latest',
			sourceType: goal === 'module' ? 'module' : 'script',
			allowHashBang: true,
			allowReturnOutsideFunction: goal === 'handler',
		});
	} catch (error) {
		if (typeof error.pos === 'number')
			return `at ${error.pos} (${error.message}): ${JSON.stringify(code.slice(Math.max(0, error.pos - 120), error.pos + 80))}`;
	}
	return '';
}

// the rewriter as the service worker has it
const esbuild = await import('esbuild');
const OUT = `${root}test/out/`;
mkdirSync(OUT, { recursive: true });
const tag = `corpus-${process.pid}`;
const entry = `${OUT}${tag}-entry.mjs`;
const bundle = `${OUT}${tag}-rewriter.mjs`;
writeFileSync(
	entry,
	`export { modifyJS, UNREWRITTEN_END, UNREWRITTEN_MODULE_END } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { scriptPreamble } from ${JSON.stringify(`${root}src/prewrite.ts`)};
export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
export { adoptModule } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
`,
);
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const lib = await import(bundle);
const { scriptPreamble } = lib;
rmSync(entry, { force: true });
rmSync(bundle, { force: true });
lib.adoptModule(
	'core',
	await lib.compileModule(
		readFileSync(process.env.CORE_WASM ?? `${root}assets/core.wasm`),
	),
);
const CONFIG = { directory: '/stomp/', codec: 'xor' };
const parsed = lib.parseConfig(CONFIG, 'k');

let acorn = null;
try {
	acorn = await import('acorn');
} catch {
	console.log('(acorn is not installed: no loss check)');
}

// node kinds the rewriter never takes away: its edits wrap, replace a
// pattern or an access with a call that keeps every part of it as code, and
// insert helpers, so a rewrite has at least as many of each as the original.
// Not counted: `debugger` (removed on purpose, CHANGELOG), `new` (a
// construction whose callee may be a hooked constructor is a helper's call)
// and `in` (below).
const KEPT = new Set([
	'IfStatement',
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'DoWhileStatement',
	'SwitchStatement',
	'SwitchCase',
	'TryStatement',
	'CatchClause',
	'ThrowStatement',
	'BreakStatement',
	'ContinueStatement',
	'LabeledStatement',
	'ReturnStatement',
	'ExpressionStatement',
	'BlockStatement',
	'VariableDeclaration',
	'VariableDeclarator',
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ClassDeclaration',
	'ClassExpression',
	'MethodDefinition',
	'PropertyDefinition',
	'StaticBlock',
	'YieldExpression',
	'AwaitExpression',
	'TemplateLiteral',
	'TemplateElement',
	'TaggedTemplateExpression',
	'ConditionalExpression',
	'CallExpression',
	'ObjectExpression',
	'ArrayExpression',
	'SpreadElement',
	'ImportDeclaration',
	'ImportSpecifier',
	'ImportDefaultSpecifier',
	'ImportNamespaceSpecifier',
	'ExportNamedDeclaration',
	'ExportDefaultDeclaration',
	'ExportAllDeclaration',
	'ExportSpecifier',
]);

/** how many nodes of each kept kind `code` has, or null when acorn cannot parse it */
function census(code, goal) {
	let program;
	try {
		program = acorn.parse(code, {
			ecmaVersion: 'latest',
			sourceType: goal === 'module' ? 'module' : 'script',
			allowHashBang: true,
			allowReturnOutsideFunction: goal === 'handler',
		});
	} catch {
		return null;
	}
	const counts = new Map();
	const count = (kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
	const stack = [program];
	while (stack.length) {
		const node = stack.pop();
		if (KEPT.has(node.type)) count(node.type);
		// by operator, but `in`: one whose key may be a helper's name is the
		// access API's `has` call once rewritten
		if (
			(node.type === 'BinaryExpression' && node.operator !== 'in') ||
			node.type === 'LogicalExpression' ||
			node.type === 'UnaryExpression' ||
			node.type === 'AssignmentExpression' ||
			node.type === 'UpdateExpression'
		)
			count(`${node.type}:${node.operator}`);
		if (node.type === 'Literal')
			count(
				node.regex
					? 'Literal:regex'
					: node.bigint !== undefined
						? 'Literal:bigint'
						: `Literal:${node.value === null ? 'null' : typeof node.value}`,
			);
		if (typeof node.directive === 'string')
			count(`directive:${node.directive}`);
		for (const key in node) {
			if (key === 'type' || key === 'start' || key === 'end') continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const item of value)
					if (item && typeof item.type === 'string') stack.push(item);
			} else if (value && typeof value.type === 'string') stack.push(value);
		}
	}
	return counts;
}

/** the kept kinds `after` has fewer of than `before`, as `kind -n` */
function losses(before, after) {
	const lost = [];
	for (const [kind, n] of before) {
		const m = after.get(kind) ?? 0;
		if (m < n) lost.push(`${kind} ${m - n}`);
	}
	return lost;
}

// the script types (src/scriptRoutes.ts) a corpus kind is rewritten as, the
// first V8 takes, and the goal V8 compiles each in
const TYPES = {
	classic: ['generic'],
	module: ['genericModule'],
	worker: ['worker', 'workerModule'],
	workerModule: ['workerModule'],
	unknown: ['generic', 'genericModule'],
	// (an attribute's code: rewritten by the inject as a classic script,
	// src/inject/dom/modules/DOMAttributes.ts)
	handler: ['handler'],
};
const GOALS = {
	generic: 'script',
	worker: 'script',
	genericModule: 'module',
	workerModule: 'module',
	handler: 'handler',
};

const results = [];
const started = performance.now();
let rewriteTime = 0;
let bytes = 0;
const warn = console.warn;
const queue = targets.flatMap((target) => corpus(target));
const minifiedOf = new Map();
while (queue.length) {
	{
		const script = queue.shift();
		const { text } = script;
		bytes += text.length;
		const result = {
			sha256: script.sha256,
			size: text.length,
			sites: [...new Set(script.from.map((f) => f.site))],
			url: script.from[0].url,
		};
		results.push(result);
		// the goal it is loaded in: the first of its kind's that V8 takes
		let type = null;
		let refused = null;
		for (const candidate of TYPES[script.kind] ?? TYPES.unknown) {
			refused = v8(text, GOALS[candidate]);
			if (!refused) {
				type = candidate;
				break;
			}
		}
		if (!type) {
			result.verdict = 'refused';
			result.why = `${refused?.name}: ${refused?.message}`;
			continue;
		}
		const goal = GOALS[type];
		result.type = type;
		// (where the classic goals differ: new Function's body takes `return`
		// and `new.target`, and src/rewriteJS.ts refusedHere asks it)
		if (goal === 'script') {
			let fn = null;
			try {
				new Function(text);
			} catch (error) {
				fn = error;
			}
			if (fn) result.functionRefuses = `${fn.name}: ${fn.message}`;
		}
		const url = new lib.StompURL(
			/^https?:/.test(result.url)
				? result.url.replace(/#.*$/, '')
				: `https://corpus.example/${result.url}`,
			parsed.codec,
			'/stomp/',
		);
		const warned = [];
		console.warn = (...message) => warned.push(message.join(' '));
		let output;
		const t0 = performance.now();
		try {
			output = lib.modifyJS(
				text,
				url,
				CONFIG,
				type === 'handler' ? 'generic' : type,
				// an inline classic script's, as the service worker's prewrite
				// and the page's loadHTML rewrite it
				script.inline && type === 'generic' ? scriptPreamble(text) : '',
			);
		} catch (error) {
			result.verdict = 'declined';
			result.why = `threw ${error?.name}: ${error?.message}`;
			continue;
		} finally {
			result.ms = +(performance.now() - t0).toFixed(1);
			rewriteTime += result.ms;
			console.warn = warn;
		}
		if (
			output === text + lib.UNREWRITTEN_END ||
			output === text + lib.UNREWRITTEN_MODULE_END ||
			(output === text && warned.length)
		) {
			result.verdict = 'declined';
			result.why = warned
				.join('; ')
				.replace(/^Stomp could not rewrite \S+: /, '');
			result.ended = output !== text;
			continue;
		}
		const broken = v8(output, goal);
		if (broken) {
			result.verdict = 'broken';
			result.why = `${broken.name}: ${broken.message}`;
			result.where = around(output, goal);
			if (outDir) {
				mkdirSync(outDir, { recursive: true });
				writeFileSync(join(outDir, `${script.sha256}.out.js`), output);
			}
			continue;
		}
		if (acorn) {
			const before = census(text, goal);
			const after = before && census(output, goal);
			if (!before) result.census = 'acorn refuses the original';
			else if (!after) result.census = 'acorn refuses the rewrite';
			else {
				const lost = losses(before, after);
				if (lost.length) {
					result.verdict = 'loses';
					result.why = lost.join(', ');
					if (outDir) {
						mkdirSync(outDir, { recursive: true });
						writeFileSync(join(outDir, `${script.sha256}.out.js`), output);
					}
					continue;
				}
			}
		}
		result.verdict = 'ok';
		// --minify: the script again as esbuild's minifier prints it, which
		// leaves out every space it can (`for(const{a}of b)`, `return"a"`)
		if (minify && !script.minified && goal !== 'handler') {
			let minified = null;
			try {
				minified = esbuild.transformSync(text, {
					loader: 'js',
					minify: true,
					target: 'esnext',
					legalComments: 'none',
					charset: 'utf8',
					format: goal === 'module' ? 'esm' : undefined,
				}).code;
			} catch {
				// (esbuild refuses a few things V8 takes: skipped)
			}
			if (minified && minified !== text && !minifiedOf.has(minified)) {
				minifiedOf.set(minified, true);
				queue.push({
					sha256: createHash('sha256').update(minified).digest('hex'),
					text: minified,
					kind:
						script.kind === 'unknown'
							? type === 'generic'
								? 'classic'
								: 'module'
							: script.kind,
					minified: true,
					from: script.from.map((f) => ({ ...f, url: `${f.url}#minified` })),
				});
			}
		}
	}
}

const by = (verdict) => results.filter((r) => r.verdict === verdict);
const bad = [...by('broken'), ...by('declined'), ...by('loses')];
for (const r of bad)
	console.log(
		`${r.verdict.toUpperCase()} ${r.sites.join(',')} ${r.url} (${r.size} bytes, ${r.type}): ${r.why}${r.where ? `\n  ${r.where}` : ''}`,
	);
if (verbose) {
	for (const r of by('refused'))
		console.log(`refused ${r.sites.join(',')} ${r.url}: ${r.why}`);
	for (const r of results.filter((r) => r.census))
		console.log(`no census ${r.sites.join(',')} ${r.url}: ${r.census}`);
	for (const r of results.filter((r) => r.functionRefuses))
		console.log(
			`new Function refuses ${r.sites.join(',')} ${r.url} (V8 script goal takes it): ${r.functionRefuses}`,
		);
	const slow = results
		.filter((r) => r.ms !== undefined)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 10);
	for (const r of slow)
		console.log(
			`slow ${r.ms} ms ${r.size} bytes ${r.sites.join(',')} ${r.url}`,
		);
}
const sites = new Map();
for (const r of results)
	for (const site of r.sites) {
		const row = sites.get(site) ?? { scripts: 0, bytes: 0, bad: 0 };
		row.scripts++;
		row.bytes += r.size;
		if (bad.includes(r)) row.bad++;
		sites.set(site, row);
	}
if (verbose)
	for (const [site, row] of [...sites].sort())
		console.log(
			`site ${site}: ${row.scripts} scripts, ${(row.bytes / 1e6).toFixed(2)} MB, ${row.bad} bad`,
		);
console.log(
	`${results.length} scripts, ${(bytes / 1e6).toFixed(1)} MB: ${by('ok').length} ok, ${by('broken').length} broken, ${by('declined').length} declined, ${by('loses').length} lose code, ${by('refused').length} refused by V8 as they came; rewrite ${(rewriteTime / 1000).toFixed(1)} s, total ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(results, null, '\t'));
process.exit(bad.length ? 1 : 0);
