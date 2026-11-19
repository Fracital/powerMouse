// The differential semantic oracle of the JavaScript rewriter, in node.
//
// A case is a script. It runs twice, each time in a fresh realm that holds
// the same world (world.js): once as written, and once rewritten by the wasm
// core (src/rewriteJS.ts, the module the build ships) with the inject's real
// access API, Function hooks and toString hook installed (runtime.ts). Every
// object of the world records what is done to it, so each run leaves a
// trace: the ordered gets, sets, calls and constructions on the world's
// objects with their keys and values, what the case logged, and how it
// ended (its completion value, or the class and message of what it threw).
// The two traces must be the same text: the rewritten script did what the
// page's own would do in a browser, in the same order, and said the same.
//
// Proxied, the realm's real `location` and `top` are host objects no page
// code may reach; a touch of one is recorded as an escape, and a value that
// is one names itself in whatever trace line shows it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const OUT = `${root}test/out/`;
export const BASE = 'https://page.example/dir/page.html';
export const CONFIG = { directory: '/stomp/', codec: 'xor' };
const NAMES = {
	access: '$s$j',
	globalProxy: '$s$L',
	globalName: '$s$N',
	client: '$P$s',
};

/** the marks and the kept-text statement taken out of a rewrite, for a reader */
export const unmarked = (out) =>
	out
		.replace(
			/0\.\.\S+?\?\.src\("[0-9a-z]+","[^"]*",function\(\)\{\/\*[\s\S]*?\*\/\}\);/,
			'',
		)
		.replace(/\/\*[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+\*\//g, '');

/**
 * The harness: `run(source, options)` answers both traces. `core` is the
 * artifact to rewrite with (assets/core.wasm when not given).
 */
export async function createHarness({ core } = {}) {
	const esbuild = await import('esbuild');
	mkdirSync(OUT, { recursive: true });
	const tag = `differential-${process.pid}`;
	// the rewriter, as the service worker has it and as a page's realm has it
	const entry = `${OUT}${tag}-entry.mjs`;
	writeFileSync(
		entry,
		`export { modifyJS } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { reportKeptSources } from ${JSON.stringify(`${root}src/functionSource.ts`)};
export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
export { adoptModule } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
export { printInWasm } from ${JSON.stringify(`${root}src/wasm/rewriter.ts`)};
`,
	);
	const bundle = `${OUT}${tag}-rewriter.mjs`;
	const runtimeFile = `${OUT}${tag}-runtime.js`;
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundle,
		logLevel: 'silent',
	});
	await esbuild.build({
		entryPoints: [`${here}runtime.ts`],
		bundle: true,
		platform: 'browser',
		format: 'iife',
		outfile: runtimeFile,
		logLevel: 'silent',
		// (what build.js defines for the inject bundles; none is read here)
		define: {
			'process.env.STOMP_VERSION': '"differential"',
			'process.env.STOMP_BUILD': '"differential"',
			'process.env.NODE_ENV': '"production"',
			'process.env.STOMP_LIBRARY': '""',
			'process.env.STOMP_CORE': '""',
			'process.env.STOMP_ADBLOCK_SNAPSHOT': '""',
			'process.env.STOMP_TRANSPORT_WORKER': '""',
			'process.env.STOMP_REWRITE_WORKER': '""',
			'process.env.STOMP_BLOCKER': '""',
			'process.env.STOMP_CONTROLLER_FRAME': '""',
			'process.env.STOMP_CONTROLLER_FRAME_SCRIPT': '""',
			'process.env.STOMP_SITE_FRAME_SCRIPT': '""',
			'process.env.STOMP_DOCUMENT': '""',
			'process.env.STOMP_DOCUMENT_FULL': '""',
			'process.env.STOMP_REWRITE_GENERATION': '""',
			'process.env.STOMP_CODEC_WASM': 'undefined',
		},
		plugins: [
			{
				name: 'differential-shims',
				setup(build) {
					// the inject's rewriter is the harness's, and a route only has
					// to be told from the page's URL
					build.onResolve({ filter: /(^|\/)rewriter$/ }, (args) =>
						args.importer.includes('/src/inject/')
							? { path: `${here}shims/rewriter.ts` }
							: null,
					);
					build.onResolve({ filter: /(^|\/)rewriteHTML$/ }, () => ({
						path: `${here}shims/rewriteHTML.ts`,
					}));
					build.onResolve({ filter: /^\.\/Unroute$/ }, () => ({
						path: `${here}shims/Unroute.ts`,
					}));
				},
			},
		],
	});
	const bytes = readFileSync(core ?? `${root}assets/core.wasm`);
	const load = async (as) => {
		const lib = await import(`${bundle}?${as}-${Date.now()}`);
		lib.adoptModule('core', await lib.compileModule(bytes));
		const parsed = lib.parseConfig(CONFIG, 'k');
		const url = new lib.StompURL(BASE, parsed.codec, '/stomp/');
		return { lib, url };
	};
	// the worker's copy writes a script's text into its output (the holder);
	// the page's keeps it beside the realm's toString hook
	const worker = await load('worker');
	const page = await load('page');
	const kept = [];
	page.lib.reportKeptSources((key, text) => kept.push([key, text]));
	// (test262 runner) the access API's own `import()` of a route it made
	// (`$s$j.import`) is answered by whoever runs the case: `setImporter`
	let importer = null;
	const runtime = new vm.Script(readFileSync(runtimeFile, 'utf8'), {
		filename: 'stomp-runtime.js',
		importModuleDynamically: (specifier, referrer, attributes) => {
			if (!importer) throw new TypeError('no importer for this case');
			return importer(specifier, attributes);
		},
	});
	const world = new vm.Script(readFileSync(`${here}world.js`, 'utf8'), {
		filename: 'stomp-world.js',
	});
	for (const file of [entry, bundle, runtimeFile])
		rmSync(file, { force: true });

	const warn = console.warn;
	const quietly = (work) => {
		console.warn = () => {};
		try {
			return work();
		} finally {
			console.warn = warn;
		}
	};
	/**
	 * `source` as the service worker rewrites a script of the page's (`at`:
	 * the script's own URL, when it is not the page's)
	 */
	const rewrite = (source, type = 'generic', at = undefined) =>
		quietly(() =>
			worker.lib.modifyJS(
				source,
				at === undefined ? worker.url : new worker.lib.StompURL(at, worker.url),
				CONFIG,
				type,
			),
		);
	/** the URL a route of a module or a file stands for, or null for anything else */
	const unroute = (specifier) => {
		const found = /^\/stomp\/[A-Za-z:]+\/([^#/]*)(#.*)?$/.exec(
			String(specifier),
		);
		if (!found) return null;
		try {
			return worker.url.codec.decode(found[1]) + (found[2] ?? '');
		} catch (error) {
			return null;
		}
	};
	const host = {
		config: CONFIG,
		base: BASE,
		rewrite: (script, type, preamble) => {
			kept.length = 0;
			const output = quietly(() =>
				page.lib.modifyJS(script, page.url, CONFIG, type, preamble),
			);
			return [output, ...kept.splice(0)];
		},
		print: (source, part) =>
			page.lib.printInWasm(source, part)?.printed ?? null,
	};

	/**
	 * A fresh realm holding the world (`bare`: none of it, the inject alone
	 * when proxied): `{ global, world }`, the world's hooks taken off the
	 * global
	 */
	function realm(mode, { bare = false } = {}) {
		const global = vm.createContext(vm.constants.DONT_CONTEXTIFY);
		global.URL = URL;
		world.runInContext(global)(mode, NAMES, BASE, bare);
		const made = global.__world;
		if (mode === 'proxied') {
			runtime.runInContext(global);
			global.__differential(host, made);
			delete global.__differential;
		}
		delete global.__world;
		return { global, world: made };
	}

	// a promise of the case's that nothing handles is part of its trace (the
	// process would end on it)
	let running = null;
	process.on('unhandledRejection', (reason) => {
		if (!running) throw reason;
		running.push(`unhandled rejection ${running.show(reason)}`);
	});

	/** one run of `code` in a fresh realm holding the world: its trace */
	async function trace(code, mode, { timeout = 2000, bare = false } = {}) {
		const { global, world: made } = realm(mode, { bare });
		running = made;
		let outcome;
		try {
			const script = new vm.Script(code, { filename: 'case.js' });
			const value = script.runInContext(global, { timeout });
			outcome = `completion ${made.show(value)}`;
		} catch (error) {
			outcome = `threw ${made.show(error)}`;
		}
		// what the case left for later (a promise's reactions, an async
		// function's rest)
		for (let turn = 0; turn < 3; turn++)
			await new Promise((resolve) => setImmediate(resolve));
		running = null;
		return made.done(outcome);
	}

	/**
	 * Both runs of a case: `{ native, proxied, rewritten, same, escape }`.
	 * `type` is the kind of script it is rewritten as.
	 */
	async function run(source, options = {}) {
		const rewritten = rewrite(source, options.type);
		const native = await trace(source, 'native', options);
		const proxied = await trace(rewritten, 'proxied', options);
		// (what the inject asked of a page's object by one of its own names
		// is a tell, counted apart: `tells`)
		const steps = proxied
			.split('\n')
			.filter((line) => !line.startsWith('tell '));
		const tells = proxied.split('\n').length - steps.length;
		return {
			native,
			proxied,
			rewritten,
			same: native === steps.join('\n'),
			tells,
			escape: proxied.includes('HOST'),
		};
	}
	return {
		run,
		rewrite,
		trace,
		realm,
		unroute,
		setImporter: (given) => {
			importer = given;
		},
	};
}

/** the first line two traces differ at, for a report */
export function firstDifference(native, proxied) {
	const a = native.split('\n');
	const b = proxied.split('\n').filter((line) => !line.startsWith('tell '));
	let at = 0;
	while (at < a.length && at < b.length && a[at] === b[at]) at++;
	return `line ${at + 1}: native ${JSON.stringify(a[at] ?? '(end)')} proxied ${JSON.stringify(b[at] ?? '(end)')}`;
}
