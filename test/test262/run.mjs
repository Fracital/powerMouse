#!/usr/bin/env node
// test262, natively and rewritten by STomp: the rewriter's completeness
// oracle (docs/surface-audit.md, class J).
//
//   TEST262=<checkout> node test/test262/run.mjs [filter...] [--jobs N]
//       [--out DIR] [--force] [--native-timeout MS] [--proxied-timeout MS]
//       [--file-timeout MS] [--list]
//   TEST262=<checkout> node --experimental-vm-modules test/test262/run.mjs
//       --probe [--strict] [--raw] [--async] '<js>'...
//
// (npm run test262 -- <args>.) A filter is a path prefix relative to the
// checkout (test/language/expressions), a glob (test/language/**/eval*.js)
// or @<file> (the paths listed in it, one per line). With no filter the run
// is test/language, test/built-ins and test/annexB (intl402 and staging are
// left out). CORE_WASM chooses the rewriter artifact (dist/core.wasm, what
// the build ships, when not given): build first.
//
// Each test is built as test262's INTERPRETING.md says (the "use strict";
// line of the strict variant, then assert.js, sta.js, doneprintHandle.js for
// an async test and the test's includes, then the test, as one classic
// script) and run twice in bare realms of test/differential/harness.mjs:
// the text as written in a native realm, and the text rewritten as the
// service worker rewrites a page's script (`modifyJS(..., 'generic')`) in a
// realm holding the inject's real access API, Function hooks and toString
// hook, so a string the test evaluates (eval, new Function,
// $262.evalScript) is rewritten the way the inject rewrites one. A module
// test's harness is a classic script of its realm and the test file and
// every module it imports are rewritten as modules (`'genericModule'`). The
// verdict is test262's: a negative test passes when it throws the named
// error in the named phase.
//
// One JSON line per test file goes to <out>/results.jsonl (resumable: a file
// already there is not run again unless --force); report.mjs turns it into
// counts, the difference set, the rewriter's throughput and, with --known,
// a gate. Tests run in worker processes (this file with --worker, at most 12,
// half the CPUs by default), one file per message, so a crash or a hang
// costs one file: the master records it, with the stage the worker was in
// (a hang in `rewrite` is the rewriter's), and starts another worker. Start
// it niced on a shared machine (`nice -n 10`); the workers inherit it.
import { fork } from 'node:child_process';
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};
const T262 = resolve(option('--test262', process.env.TEST262 ?? ''));
const CORE = process.env.CORE_WASM ?? join(ROOT, 'dist/core.wasm');
const NATIVE_TIMEOUT = Number(option('--native-timeout', 10000));
const PROXIED_TIMEOUT = Number(option('--proxied-timeout', 20000));
const FILE_TIMEOUT = Number(option('--file-timeout', 120000));
const PROBE = flag('--probe');
const DEFAULT_SCOPE = ['test/language', 'test/built-ins', 'test/annexB'];
const MAX_JOBS = 12;

if (!process.env.TEST262 && !argv.includes('--test262')) {
	console.error(
		'test262: set TEST262 to a checkout of tc39/test262 (its harness/ and test/)',
	);
	process.exit(2);
}
if (!existsSync(join(T262, 'harness/assert.js'))) {
	console.error(`test262: ${T262} holds no harness/assert.js`);
	process.exit(2);
}

/** a test's frontmatter: includes, flags, features, negative */
function parseMeta(source) {
	const meta = { includes: [], flags: [], features: [], negative: null };
	const found = /\/\*---([\s\S]*?)---\*\//.exec(source);
	if (!found) return meta;
	const yaml = found[1];
	const list = (key) => {
		const inline = new RegExp(
			`^[ \\t]*${key}:[ \\t]*\\[([^\\]]*)\\]`,
			'm',
		).exec(yaml);
		if (inline)
			return inline[1]
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean);
		const block = new RegExp(
			`^[ \\t]*${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[^\\n]*(?:\\r?\\n|$))+)`,
			'm',
		).exec(yaml);
		if (block)
			return block[1]
				.split(/\r?\n/)
				.map((item) => item.replace(/^\s*-\s*/, '').trim())
				.filter(Boolean);
		return [];
	};
	meta.includes = list('includes');
	meta.flags = list('flags');
	meta.features = list('features');
	const negative =
		/^[ \t]*negative:[ \t]*\r?\n((?:[ \t]+[^\n]*(?:\n|$))+)/m.exec(yaml);
	if (negative)
		meta.negative = {
			phase: /phase:\s*(\S+)/.exec(negative[1])?.[1] ?? 'runtime',
			type: /type:\s*(\S+)/.exec(negative[1])?.[1] ?? 'Error',
		};
	return meta;
}

/** why a file is not run (null: it is) */
function skipOf(relative, source, meta) {
	// node 24.16's V8 itself dies of this one (SIGSEGV, no STomp code in the
	// process: `for (await using i = null; ...; i = {...}) {}`)
	if (
		relative.endsWith('await-using-invalid-assignment-next-expression-for.js')
	)
		return 'node-segv';
	// node dies of a V8 CHECK (module->status() == kLinked) in this runner's
	// loader on an import() into an errored cycle
	if (
		relative.endsWith(
			'dynamic-import/import-fulfilled-member-of-errored-cycle.js',
		)
	)
		return 'node-fatal-in-loader';
	// document.all: a host object node has no way to make
	if (meta.features.includes('IsHTMLDDA')) return 'IsHTMLDDA';
	// $262.agent: other agents (workers sharing memory) this runner has none of
	if (
		/\$262\.agent\b/.test(source) ||
		meta.includes.includes('atomicsHelper.js')
	)
		return 'agent';
	if (/\$262\.AbstractModuleSource\b/.test(source))
		return 'AbstractModuleSource';
	return null;
}

if (flag('--worker') || PROBE) await worker();
else await master();

// ------------------------------------------------------------------ worker
async function worker() {
	process.on('unhandledRejection', () => {});
	process.on('uncaughtException', (error) => {
		try {
			process.send?.({ note: `uncaughtException ${error?.message}` });
		} catch {
			// (the channel is gone: the master records the file)
		}
	});
	// the stage this worker is in, written synchronously where the master can
	// read it after a hang (a rewrite that never returns never lets IPC run)
	const stageFile = process.env.T262_STAGE;
	const stageFd = stageFile ? openSync(stageFile, 'w') : null;
	const stage = (what) => {
		if (stageFd !== null) writeSync(stageFd, what.padEnd(160).slice(0, 160), 0);
	};

	const { createHarness, unmarked } = await import(
		`${ROOT}/test/differential/harness.mjs`
	);
	const h = await createHarness({ core: CORE });
	const harnessText = new Map();
	const harnessFile = (name) => {
		if (!harnessText.has(name))
			harnessText.set(name, readFileSync(join(T262, 'harness', name), 'utf8'));
		return harnessText.get(name);
	};
	const now = () => performance.now();
	const rounded = (ms) => Math.round(ms * 1000) / 1000;
	/** a rewrite, timed: `{ text, ms }`, or `{ threw, ms }` */
	const rewriteTimed = (source, type, at) => {
		const started = now();
		try {
			const text = h.rewrite(source, type, at);
			return { text, ms: now() - started };
		} catch (error) {
			return {
				threw: shorten(error?.stack ?? error, 600),
				ms: now() - started,
			};
		}
	};

	// $262 and print, made by the same native (never rewritten) code in both
	// kinds of realm, so they are the same objects to the test either way
	const boot = new vm.Script(
		`(function (host) {
	'use strict';
	var g = globalThis;
	var define = Object.defineProperty;
	var $262 = {
		global: g,
		gc: function gc() {},
		createRealm: function createRealm() { return host.createRealm(); },
		evalScript: function evalScript(code) {
			var refused = host.compile(code);
			if (refused) throw new g[refused.name](refused.message);
			return host.run();
		},
		detachArrayBuffer: function detachArrayBuffer(buffer) {
			host.detach(buffer);
			return null;
		},
	};
	define(g, '$262', { value: $262, writable: true, configurable: true, enumerable: false });
	define(g, 'print', {
		value: function print(text) { host.print(String(text)); },
		writable: true, configurable: true, enumerable: false,
	});
	return $262;
})`,
		{ filename: 'test262-boot.js' },
	);

	function install(global, mode, prints, timeout) {
		let compiled = null;
		const host = {
			print: (text) => {
				prints.push(text);
			},
			createRealm: () => {
				const made = h.realm(mode, { bare: true });
				return install(made.global, mode, prints, timeout);
			},
			// a script the engine refuses is refused in the realm's own error
			// class (vm compiles in node's realm). Proxied, the script is one the
			// page inserts: the service worker rewrites it
			compile: (code) => {
				let text = String(code);
				if (mode === 'proxied') text = h.rewrite(text, 'generic');
				try {
					compiled = new vm.Script(text, scriptOptions('evalScript.js'));
					return null;
				} catch (error) {
					compiled = null;
					return {
						name: String(error?.name ?? 'Error'),
						message: String(error?.message ?? ''),
					};
				}
			},
			run: () => {
				const script = compiled;
				compiled = null;
				return script.runInContext(global, { timeout });
			},
			detach: (buffer) => {
				structuredClone(buffer, { transfer: [buffer] });
			},
		};
		return boot.runInContext(global)(host);
	}

	function shorten(value, limit = 300) {
		let out;
		try {
			out = String(value);
		} catch {
			out = '(unprintable)';
		}
		return out.length > limit ? `${out.slice(0, limit)}...` : out;
	}
	function describe(error) {
		if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
			return { name: 'TIMEOUT', message: '' };
		if (
			error === null ||
			(typeof error !== 'object' && typeof error !== 'function')
		)
			return { name: `(thrown ${typeof error})`, message: shorten(error) };
		let name;
		let message;
		try {
			name = error.constructor?.name;
			if (typeof name !== 'string' || name === '') name = error.name;
		} catch {
			name = '(throwing name)';
		}
		try {
			message = error.message;
		} catch {
			message = '(throwing message)';
		}
		return { name: shorten(name, 80), message: shorten(message) };
	}

	const turn = () => new Promise((done) => setImmediate(done));

	// ---- modules and import(): one loader per run of a test. A test file
	// <dir>/<name>.js is https://page.example/dir/<name>.js to the page (the
	// harness's page URL is in that directory, and a classic script's imports
	// resolve against it), and a URL under that directory is a file beside the
	// test. Proxied, a specifier arrives routed (/stomp/js:genericModule/...)
	// and h.unroute gives the URL back.
	const PAGE_DIR = 'https://page.example/dir/';
	let current = null;
	h.setImporter((specifier, attributes) =>
		current.dynamic(specifier, current.rootURL, attributes),
	);
	function loader(file, mode, global, timeout) {
		const dir = dirname(file);
		const modules = new Map();
		const pending = new WeakMap();
		const rootURL = PAGE_DIR + file.split('/').pop();
		// an error of node's realm (a module the engine refuses) as the realm's
		// own, which is what a page's import() rejects with
		const realmError = (error) => {
			if (!(error instanceof Error)) return error;
			const Class = global[error.name];
			return typeof Class === 'function' ? new Class(error.message) : error;
		};
		const urlOf = (specifier, referrerURL) => {
			if (mode === 'proxied') {
				const real = h.unroute(specifier);
				if (real !== null) return real;
			}
			return new URL(specifier, referrerURL).href;
		};
		const api = { rootURL, declined: false, rewriteMs: 0, rewriteThrew: null };
		const load = (url, attributes) => {
			if (modules.has(url)) return modules.get(url);
			if (!url.startsWith(PAGE_DIR))
				throw new TypeError(`no such module: ${url}`);
			const path = join(
				dir,
				decodeURIComponent(url.slice(PAGE_DIR.length).replace(/[?#].*$/, '')),
			);
			let body;
			try {
				body = readFileSync(path, 'utf8');
			} catch {
				throw new TypeError(
					`Failed to fetch dynamically imported module: ${url}`,
				);
			}
			let module;
			if (attributes?.type === 'json' || path.endsWith('.json')) {
				module = new vm.SyntheticModule(
					['default'],
					function () {
						this.setExport('default', global.JSON.parse(body));
					},
					{ context: global, identifier: url },
				);
			} else {
				let code = body;
				if (mode === 'proxied') {
					stage(`rewrite module ${url}`);
					const made = rewriteTimed(body, 'genericModule', url);
					stage(`run proxied module`);
					api.rewriteMs += made.ms;
					if (made.threw !== undefined) {
						api.rewriteThrew = made.threw;
						throw new SyntaxError(`REWRITE-THREW ${made.threw}`);
					}
					code = made.text;
					if (code.includes('STomp_could_not_rewrite')) api.declined = true;
				}
				module = new vm.SourceTextModule(code, {
					context: global,
					identifier: url,
					// proxied, the browser's own answer is the route: the rewrite
					// writes the page's URL over it
					initializeImportMeta: (importMeta) => {
						importMeta.url =
							mode === 'proxied'
								? 'https://proxy.example/stomp/js:genericModule/sealed'
								: url;
					},
					importModuleDynamically: (specifier, referrer, attrs) =>
						dynamic(specifier, url, attrs),
				});
			}
			modules.set(url, module);
			return module;
		};
		const link = (specifier, referrer, extra) =>
			load(
				urlOf(specifier, referrer.identifier),
				extra?.attributes ?? extra?.assert,
			);
		const ready = (module) => {
			if (!pending.has(module))
				pending.set(
					module,
					(async () => {
						if (module.status === 'unlinked') await module.link(link);
						await module.evaluate({ timeout });
						return module;
					})(),
				);
			return pending.get(module);
		};
		const dynamic = async (specifier, referrerURL, attributes) => {
			try {
				return await ready(
					load(urlOf(String(specifier), referrerURL), attributes),
				);
			} catch (error) {
				throw realmError(error);
			}
		};
		Object.assign(api, { load, link, dynamic });
		return api;
	}
	const scriptOptions = (filename) => ({
		filename,
		importModuleDynamically: (specifier, script, attributes) =>
			current.dynamic(specifier, current.rootURL, attributes),
	});

	async function runScript(file, code, mode, meta) {
		const prints = [];
		const timeout = mode === 'native' ? NATIVE_TIMEOUT : PROXIED_TIMEOUT;
		const started = now();
		const { global } = h.realm(mode, { bare: true });
		install(global, mode, prints, timeout);
		current = loader(file, mode, global, timeout);
		let phase = null;
		let error = null;
		let script = null;
		try {
			script = new vm.Script(code, scriptOptions('test262.js'));
		} catch (thrown) {
			phase = 'parse';
			error = describe(thrown);
		}
		if (script) {
			try {
				script.runInContext(global, { timeout });
			} catch (thrown) {
				phase = 'runtime';
				error = describe(thrown);
			}
		}
		const out = await finish(meta, phase, error, prints);
		out.ms = rounded(now() - started);
		if (PROBE) out.prints = prints;
		return out;
	}

	// a module test: the harness files as a classic script of the realm (its
	// globals), then the test file as the root module
	async function runModule(file, prelude, mode, meta) {
		const prints = [];
		const timeout = mode === 'native' ? NATIVE_TIMEOUT : PROXIED_TIMEOUT;
		const started = now();
		const { global } = h.realm(mode, { bare: true });
		install(global, mode, prints, timeout);
		current = loader(file, mode, global, timeout);
		let phase = null;
		let error = null;
		let root = null;
		try {
			if (prelude)
				new vm.Script(
					mode === 'proxied' ? h.rewrite(prelude, 'generic') : prelude,
					scriptOptions('harness.js'),
				).runInContext(global, { timeout });
		} catch (thrown) {
			phase = 'harness';
			error = describe(thrown);
		}
		if (!error) {
			try {
				root = current.load(current.rootURL);
			} catch (thrown) {
				phase = 'parse';
				error = describe(thrown);
			}
		}
		if (root) {
			try {
				await root.link(current.link);
			} catch (thrown) {
				// a dependency the engine refuses, or a name that does not resolve
				phase = 'resolution';
				error = describe(thrown);
			}
		}
		if (root && !error) {
			try {
				await root.evaluate({ timeout });
			} catch (thrown) {
				// (instantiation, which node does on the way in, is resolution)
				phase = root.status === 'errored' ? 'runtime' : 'resolution';
				error = describe(thrown);
			}
		}
		const out = await finish(meta, phase, error, prints);
		out.ms = rounded(now() - started);
		if (current.declined) out.declined = true;
		if (current.rewriteThrew) out.rewriteThrew = current.rewriteThrew;
		if (mode === 'proxied') out.rwMs = rounded(current.rewriteMs);
		if (PROBE) out.prints = prints;
		return out;
	}

	async function finish(meta, phase, error, prints) {
		const asyncDone = () =>
			prints.find((line) => line.startsWith('Test262:Async')) ?? null;
		if (!error && meta.flags.includes('async')) {
			for (let turns = 0; turns < 60 && asyncDone() === null; turns++)
				await turn();
			const said = asyncDone();
			if (said === null) {
				phase = 'async';
				error = { name: 'NO-DONE', message: '$DONE never called' };
			} else if (said !== 'Test262:AsyncTestComplete') {
				phase = 'async';
				const rest = said.slice('Test262:AsyncTestFailure:'.length);
				const colon = rest.indexOf(':');
				error = {
					name: colon === -1 ? 'Error' : rest.slice(0, colon),
					message: shorten(colon === -1 ? rest : rest.slice(colon + 1).trim()),
				};
			}
		} else {
			// what the test left behind runs now, not during the next test
			await turn();
		}
		const ok = meta.negative
			? error !== null &&
				error.name === meta.negative.type &&
				phase === meta.negative.phase
			: error === null;
		const out = { ok };
		if (error) {
			out.phase = phase;
			out.err = `${error.name}: ${error.message}`;
		} else if (meta.negative) {
			out.err = `(completed; expected ${meta.negative.type} at ${meta.negative.phase})`;
		}
		return out;
	}

	async function runFile(relative) {
		const file = join(T262, relative);
		const source = readFileSync(file, 'utf8');
		const meta = parseMeta(source);
		const result = {
			file: relative,
			flags: meta.flags,
			features: meta.features,
			negative: meta.negative,
			bytes: Buffer.byteLength(source),
			variants: [],
		};
		const skip = skipOf(relative, source, meta);
		if (skip) return { ...result, skip };
		const isModule = meta.flags.includes('module');
		// the rewriter's throughput on the corpus: the test file alone, as the
		// kind of script it is
		stage(`rewrite alone ${relative}`);
		const alone = rewriteTimed(
			source,
			isModule ? 'genericModule' : 'generic',
			isModule
				? `https://page.example/dir/${relative.split('/').pop()}`
				: undefined,
		);
		result.rw = { ms: rounded(alone.ms) };
		if (alone.threw !== undefined) result.rw.threw = alone.threw;
		else {
			result.rw.out = Buffer.byteLength(alone.text);
			if (alone.text.includes('STomp_could_not_rewrite'))
				result.rw.declined = true;
		}

		const raw = meta.flags.includes('raw');
		let prelude = '';
		if (!raw) {
			const names = ['assert.js', 'sta.js'];
			if (meta.flags.includes('async')) names.push('doneprintHandle.js');
			for (const name of meta.includes)
				if (!names.includes(name)) names.push(name);
			prelude = `${names.map(harnessFile).join('\n')}\n`;
		}
		const variants = [];
		if (isModule) variants.push('module');
		else if (raw) variants.push('raw');
		else {
			if (!meta.flags.includes('onlyStrict')) variants.push('sloppy');
			if (!meta.flags.includes('noStrict')) variants.push('strict');
		}
		for (const variant of variants) {
			const entry = { v: variant };
			if (variant === 'module') {
				stage(`native module ${relative}`);
				entry.n = await runModule(file, prelude, 'native', meta);
				stage(`proxied module ${relative}`);
				entry.p = await runModule(file, prelude, 'proxied', meta);
			} else {
				const code =
					(variant === 'strict' ? '"use strict";\n' : '') + prelude + source;
				stage(`native ${variant} ${relative}`);
				entry.n = await runScript(file, code, 'native', meta);
				stage(`rewrite ${variant} ${relative}`);
				const made = rewriteTimed(code, 'generic');
				if (made.threw !== undefined) {
					entry.p = {
						ok: false,
						phase: 'rewrite',
						err: `REWRITE-THREW: ${made.threw}`,
						rwMs: rounded(made.ms),
					};
				} else {
					stage(`proxied ${variant} ${relative}`);
					entry.p = await runScript(file, made.text, 'proxied', meta);
					entry.p.rwMs = rounded(made.ms);
					if (made.text.includes('STomp_could_not_rewrite'))
						entry.p.declined = true;
					else if (made.text === code) entry.p.unchanged = true;
				}
			}
			result.variants.push(entry);
		}
		stage('idle');
		return result;
	}

	if (PROBE) {
		// one snippet both ways, print() to say things; assert.js, sta.js and
		// doneprintHandle.js go before it unless --raw
		const snippets = argv.filter(
			(arg, at) => !arg.startsWith('--') && argv[at - 1] !== '--test262',
		);
		for (const snippet of snippets) {
			const prelude = flag('--raw')
				? ''
				: `${harnessFile('assert.js')}\n${harnessFile('sta.js')}\n${harnessFile('doneprintHandle.js')}\n`;
			const lead = flag('--strict') ? '"use strict";\n' : '';
			const code = lead + prelude + snippet;
			const meta = { flags: flag('--async') ? ['async'] : [], negative: null };
			const probeFile = join(T262, 'test/probe.js');
			const n = await runScript(probeFile, code, 'native', meta);
			const p = await runScript(
				probeFile,
				h.rewrite(code, 'generic'),
				'proxied',
				meta,
			);
			const shown = (side) =>
				`${side.ok ? 'completed' : `${side.phase} ${side.err}`}${side.prints.length ? `\n      print: ${side.prints.join('\n      print: ')}` : ''}`;
			console.log(`CASE ${snippet}`);
			console.log(
				`  rewritten: ${unmarked(h.rewrite(lead + snippet, 'generic'))}`,
			);
			console.log(`  ${shown(n) === shown(p) ? 'SAME' : 'DIFF'}`);
			console.log(`  native:  ${shown(n)}`);
			console.log(`  proxied: ${shown(p)}`);
		}
		process.exit(0);
	}

	process.on('message', async (message) => {
		if (message.exit) {
			if (stageFd !== null) closeSync(stageFd);
			process.exit(0);
		}
		let result;
		try {
			result = await runFile(message.file);
		} catch (error) {
			result = {
				file: message.file,
				crash: `runner: ${error?.stack ?? error}`,
			};
		}
		process.send({ result });
	});
	process.send({ ready: true });
}

// ------------------------------------------------------------------ master
function listFiles(filters) {
	const all = [];
	const walk = (dir) => {
		for (const entry of readdirSync(join(T262, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.js') && !entry.name.includes('_FIXTURE'))
				all.push(path);
		}
	};
	walk('test');
	all.sort();
	if (filters.length === 0)
		return all.filter((path) =>
			DEFAULT_SCOPE.some((dir) => path.startsWith(`${dir}/`)),
		);
	const matchers = filters.map((filter) => {
		if (filter.startsWith('@')) {
			const wanted = new Set(
				readFileSync(filter.slice(1), 'utf8')
					.split('\n')
					.map((line) => line.trim().split(/\s+/)[0])
					.filter((line) => line && !line.startsWith('#')),
			);
			return (path) => wanted.has(path);
		}
		if (/[*?]/.test(filter)) {
			const pattern = filter
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*\*\/?/g, '\uffff')
				.replace(/\*/g, '[^/]*')
				.replace(/\?/g, '[^/]')
				.replace(/\uffff/g, '.*');
			const regex = new RegExp(`^${pattern}$`);
			return (path) => regex.test(path);
		}
		const prefix = filter.replace(/\/$/, '');
		return (path) => path === prefix || path.startsWith(`${prefix}/`);
	});
	return all.filter((path) => matchers.some((match) => match(path)));
}

async function master() {
	const valued = new Set([
		'--jobs',
		'--out',
		'--test262',
		'--native-timeout',
		'--proxied-timeout',
		'--file-timeout',
	]);
	const filters = [];
	for (let at = 0; at < argv.length; at++) {
		if (valued.has(argv[at])) at++;
		else if (!argv[at].startsWith('--')) filters.push(argv[at]);
	}
	const jobs = Math.max(
		1,
		Math.min(
			MAX_JOBS,
			Number(option('--jobs', Math.max(1, Math.floor(cpus().length / 2)))),
		),
	);
	const out = resolve(option('--out', join(ROOT, 'test/out/test262')));
	mkdirSync(out, { recursive: true });
	const resultsFile = join(out, 'results.jsonl');
	const logFile = join(out, 'run.log');
	const log = (line) => {
		const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
		console.log(stamped);
		appendFileSync(logFile, `${stamped}\n`);
	};
	let files = listFiles(filters);
	if (flag('--list')) {
		console.log(files.join('\n'));
		return;
	}
	if (!existsSync(CORE)) {
		console.error(`test262: no rewriter at ${CORE} (npm run build first)`);
		process.exit(2);
	}
	const had = new Set();
	if (flag('--force')) rmSync(resultsFile, { force: true });
	else if (existsSync(resultsFile))
		for (const line of readFileSync(resultsFile, 'utf8').split('\n')) {
			if (!line) continue;
			try {
				had.add(JSON.parse(line).file);
			} catch {
				// (a line cut off by a killed run: that file runs again)
			}
		}
	const total = files.length;
	files = files.filter((file) => !had.has(file));
	let head = '';
	try {
		head = readFileSync(join(T262, '.git/HEAD'), 'utf8').trim();
		if (head.startsWith('ref: '))
			head = readFileSync(join(T262, '.git', head.slice(5)), 'utf8').trim();
	} catch {
		// (a checkout with no .git of its own: the commit is not known)
	}
	writeFileSync(
		join(out, 'meta.json'),
		`${JSON.stringify({ test262: T262, test262Head: head, core: CORE, node: process.version, jobs, nativeTimeout: NATIVE_TIMEOUT, proxiedTimeout: PROXIED_TIMEOUT, fileTimeout: FILE_TIMEOUT }, null, '\t')}\n`,
	);
	log(
		`test262 ${T262} (${head.slice(0, 12)}) core=${CORE} files=${total} todo=${files.length} jobs=${jobs} out=${out} master pid=${process.pid}`,
	);
	if (files.length === 0) return;

	let next = 0;
	let finished = 0;
	let crashes = 0;
	let failedStarts = 0;
	const started = Date.now();
	let serial = 0;
	await new Promise((resolveAll) => {
		let live = 0;
		const spawn = () => {
			if (next >= files.length) {
				if (live === 0) resolveAll();
				return;
			}
			live++;
			const args = ['--worker'];
			for (const name of valued)
				if (name !== '--jobs' && name !== '--out' && option(name) !== undefined)
					args.push(name, option(name));
			const stageFile = join(out, `stage-${process.pid}-${serial++}`);
			const child = fork(fileURLToPath(import.meta.url), args, {
				cwd: ROOT,
				env: {
					...process.env,
					TEST262: T262,
					CORE_WASM: CORE,
					T262_STAGE: stageFile,
				},
				// (vm.SourceTextModule, and import() answered with one)
				execArgv: ['--experimental-vm-modules', '--no-warnings'],
				stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			});
			let stderr = '';
			child.stderr.on('data', (chunk) => {
				stderr = (stderr + chunk).slice(-2000);
			});
			appendFileSync(join(out, 'pids'), `${child.pid}\n`);
			let current = null;
			let timer = null;
			let served = 0;
			let hung = false;
			const stageNow = () => {
				try {
					return readFileSync(stageFile, 'utf8').trim();
				} catch {
					return '';
				}
			};
			const give = () => {
				// a worker is replaced every 300 files: realms and kept sources
				// pile up in one
				if (next >= files.length || served >= 300) {
					current = null;
					child.send({ exit: true });
					return;
				}
				current = files[next++];
				served++;
				timer = setTimeout(() => {
					hung = true;
					log(
						`HANG ${current} in "${stageNow()}" (worker ${child.pid} killed)`,
					);
					child.kill('SIGKILL');
				}, FILE_TIMEOUT);
				child.send({ file: current });
			};
			let ready = false;
			child.on('message', (message) => {
				if (message.ready) {
					ready = true;
					failedStarts = 0;
					return give();
				}
				if (message.note) return;
				clearTimeout(timer);
				appendFileSync(resultsFile, `${JSON.stringify(message.result)}\n`);
				current = null;
				finished++;
				if (finished % 1000 === 0) {
					const rate = finished / ((Date.now() - started) / 1000);
					log(
						`${finished}/${files.length} ${rate.toFixed(1)} files/s, eta ${Math.round((files.length - finished) / rate)} s, crashes ${crashes}`,
					);
				}
				give();
			});
			child.on('exit', (code, signal) => {
				clearTimeout(timer);
				live--;
				if (current !== null) {
					crashes++;
					finished++;
					const where = stageNow();
					appendFileSync(
						resultsFile,
						`${JSON.stringify({ file: current, crash: hung ? 'hang' : `exit code=${code} signal=${signal}`, stage: where, stderr: stderr.slice(-600) })}\n`,
					);
					if (!hung)
						log(`CRASH ${current} in "${where}" code=${code} signal=${signal}`);
				} else if (code !== 0) {
					log(
						`worker ${child.pid} exit code=${code} signal=${signal} ${stderr.slice(-300)}`,
					);
				}
				rmSync(stageFile, { force: true });
				if (!ready && ++failedStarts >= 3) {
					log('workers do not start: giving up');
					if (live === 0) resolveAll();
					return;
				}
				spawn();
			});
		};
		for (let job = 0; job < jobs; job++) spawn();
	});
	log(
		`done ${finished} files in ${Math.round((Date.now() - started) / 1000)} s, crashes and hangs ${crashes}`,
	);
}
