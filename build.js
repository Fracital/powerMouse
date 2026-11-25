import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	watch,
} from 'node:fs';
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { context, build as esbuildBuild, formatMessages } from 'esbuild';
import { rimraf } from 'rimraf';
import ts from 'typescript';
import {
	memberCache,
	memberPattern,
	namesLeft,
	shortNamesTaken,
} from './scripts/memberNames.mjs';
import { ownIterationPlugin } from './scripts/ownIteration.mjs';
import { ownMethodsFrom, ownMethodsSource } from './scripts/ownMethods.mjs';
import { buildVibeOS } from './scripts/vibeos.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const dev = process.argv.includes('--dev');
// where `npm run dev`'s demo server listens; each finished rebuild is reported
// to it so the page can reload what changed (demo/public/pm/dev.js)
const devPort = parseInt(process.env.PORT || '') || 8080;

/**
 * What the bundles are built from, files and directories from the root: the
 * build id is a hash of them (buildId), and every file a build reads is
 * checked to be among them or the locked dependencies (checkInputs), so two
 * trees with the same inputs build the same files under the same id and two
 * whose bundles differ never share one. The tests, docs, demo, changelog,
 * CI and deploy files are not among them: a commit of only those keeps
 * every bundle's bytes and hash.
 */
const BUILD_INPUTS = [
	'build.js',
	'package.json',
	'package-lock.json',
	'tsconfig.json',
	'src',
	'assets',
	'scripts/memberNames.mjs',
	'scripts/ownIteration.mjs',
	'scripts/ownMethods.mjs',
];

/**
 * The build id (src/version.ts BUILD): the package version and a hash of
 * the inputs (BUILD_INPUTS), each file by its path and bytes; package.json
 * without its scripts, which no bundle reads. The service worker, the
 * controller and the inject bundles compare it, and a new one changes the
 * service worker's bytes, so the browser installs it
 */
function buildId() {
	const hash = createHash('sha256');
	const add = (path) => {
		if (statSync(path).isDirectory())
			for (const name of readdirSync(path).sort()) add(`${path}/${name}`);
		else {
			let bytes = readFileSync(path);
			if (path === 'package.json') {
				const manifest = JSON.parse(bytes.toString('utf8'));
				delete manifest.scripts;
				bytes = Buffer.from(JSON.stringify(manifest));
			}
			hash.update(`${path}\0`).update(bytes).update('\0');
		}
	};
	for (const path of BUILD_INPUTS) if (existsSync(path)) add(path);
	return `${pkg.version}+${hash.digest('hex').slice(0, 12)}`;
}
const BUILD_ID = buildId();

/**
 * What the build is, for a host to show (dist/build.json, the demo's About):
 * the version, the build id, the last commit that changed the build's inputs
 * (BUILD_INPUTS) and that commit's date. Never the time of the build: the
 * date is the commit's (SOURCE_DATE_EPOCH wins when it is set, as in any
 * reproducible build), so building the same tree again writes the same
 * file, and a commit of only the tests, docs, demo or CI keeps it as it is,
 * with every other file of dist/. Outside a git checkout the commit is null,
 * and so is the date unless SOURCE_DATE_EPOCH gives one.
 */
function buildInfo() {
	let commit = null;
	let date = null;
	try {
		const [sha, seconds] = execFileSync(
			'git',
			['log', '-1', '--format=%H %ct', '--', ...BUILD_INPUTS],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		)
			.trim()
			.split(' ');
		if (sha && seconds) {
			commit = sha;
			date = new Date(Number(seconds) * 1000).toISOString();
		}
	} catch {
		// no git, or not a checkout
	}
	const epoch = Number(process.env.SOURCE_DATE_EPOCH);
	if (process.env.SOURCE_DATE_EPOCH && Number.isFinite(epoch))
		date = new Date(epoch * 1000).toISOString();
	return { version: pkg.version, build: BUILD_ID, commit, date };
}

/** every file the builds of this run read, as esbuild names it */
const readInputs = new Set();
/** esbuild's build, noting what it read (checkInputs) */
async function build(options) {
	const result = await esbuildBuild({ ...options, metafile: true });
	for (const input of Object.keys(result.metafile.inputs))
		readInputs.add(input);
	return result;
}

/**
 * Throw unless every file the builds read is an input (BUILD_INPUTS) or a
 * locked dependency's (node_modules, package-lock.json): a bundle built from
 * a file the build id does not cover could change while the id stays
 */
function checkInputs() {
	const root = resolve('.');
	const covered = BUILD_INPUTS.map((path) => resolve(path));
	const outside = [];
	for (const input of readInputs) {
		// (a module of a plugin's own namespace, or a group entry's stdin, named
		// by its sourcefile: text the build made from its inputs, no file)
		if (/^[\w-]+:/.test(input) || !existsSync(resolve(input))) continue;
		const file = realpathSync(resolve(input));
		if (relative(root, file).split(sep)[0] === 'node_modules') continue;
		if (
			!covered.some((path) => file === path || file.startsWith(`${path}${sep}`))
		)
			outside.push(input);
	}
	if (outside.length)
		throw new Error(
			`build: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} built from but not among the build id's inputs (build.js BUILD_INPUTS)`,
		);
}

/**
 * Throw if a built file still names a member scripts/memberNames.mjs lists
 * (something reads it by its name: it comes off the list), or a file the
 * builds read has a property of one of the list's short names
 */
async function checkMemberNames() {
	const problems = [];
	for (const name of readdirSync('dist')) {
		if (!/\.m?js$/.test(name)) continue;
		const left = namesLeft(await readFile(`dist/${name}`, 'utf8'));
		if (left.length) problems.push(`${name} names ${left.join(', ')}`);
	}
	for (const input of readInputs) {
		if (/^[\w-]+:/.test(input) || !existsSync(resolve(input))) continue;
		const taken = shortNamesTaken(await readFile(resolve(input), 'utf8'));
		if (taken.length) problems.push(`${input} has ${taken.join(', ')}`);
	}
	if (problems.length)
		throw new Error(
			`build: ${problems.join('; ')} (scripts/memberNames.mjs: a listed name a bundle keeps is read by its name)`,
		);
}

const snapshot = resolve('src/inject/snapshot.ts');
// what the inject's syntax iterates (src/ownIterable.ts, scripts/ownIteration.mjs)
const ownIterableFile = resolve('src/ownIterable.ts');
// Every `Reflect.<method>` an inject bundle names is the snapshot's method
// under a name of its own (src/inject/snapshot.ts `reflectApply`, ...): a
// call is one short name instead of a member of the snapshot object, which
// the document bundle names some 1,700 times (18 KB of it). The bundles
// that inject the snapshot define these; nothing else does (the light
// library's Reflect is src/libGlobals.ts's).
const REFLECT_METHODS = [
	'apply',
	'construct',
	'defineProperty',
	'deleteProperty',
	'get',
	'has',
	'getOwnPropertyDescriptor',
	'getPrototypeOf',
	'isExtensible',
	'ownKeys',
	'preventExtensions',
	'set',
	'setPrototypeOf',
];
const reflectDefines = Object.fromEntries(
	REFLECT_METHODS.map((name) => [
		`Reflect.${name}`,
		`reflect${name[0].toUpperCase()}${name.slice(1)}`,
	]),
);
const domSnapshot = resolve('src/inject/dom/snapshot.ts');
// what the inject bundles' syntax iterates goes through natives a page
// cannot replace (src/ownIterable.ts)
/**
 * src/ownIterable.ts is evaluated as the end of the file the bundle injects
 * first (the inject bundles' snapshot, the rewriter library's globals),
 * whose names every file of the bundle is given: a module of its own would
 * be one more that every module's initialization calls, and one that would
 * run before the snapshot it is imported from
 *
 * @type {import('esbuild').Plugin}
 */
const withOwnIterable = {
	name: 'with-own-iterable',
	setup(pluginBuild) {
		pluginBuild.onLoad({ filter: /\.ts$/ }, (args) =>
			OWN_ITERABLE_INTO.includes(args.path)
				? {
						contents: sourceText(args.path),
						loader: 'ts',
						watchFiles: [ownIterableFile],
					}
				: undefined,
		);
	},
};
const libGlobals = resolve('src/libGlobals.ts');
const rtcStackGlobals = resolve('src/inject/dom/rtcStackGlobals.ts');
const OWN_ITERABLE_INTO = [snapshot, libGlobals, rtcStackGlobals];
/** a source file's text as the bundles evaluate it (withOwnIterable) */
function sourceText(file) {
	const text = readFileSync(file, 'utf8');
	if (!OWN_ITERABLE_INTO.includes(file)) return text;
	// (the WebRTC library's String and Array method helpers are the
	// bundle's, handed over with its other globals)
	if (file === rtcStackGlobals)
		return `${text}\n${ownMethodsFrom('__stompRtcSnap.ownMethods')}`;
	const helper = readFileSync(ownIterableFile, 'utf8');
	if (file === snapshot) return `${text}\n${helper}\n${ownMethodsSource()}`;
	// The light library's is the inject's when it is made for one (its
	// `realm`, src/inject/rewriter.ts): a copy may be evaluated after the
	// page's scripts ran, in the page's realm, and the inject took the
	// natives before. Made with no realm, it is evaluated in a realm no page
	// code runs in (src/inject/dom/rewriterRealm.ts) and takes its own.
	return `${text}
const ownIteration: any[] =
	realm !== globalThis && realm.ownIterable
		? [realm.ownIterable, (...items: unknown[]) => realm.ownIterable(items)]
		: (() => {
${helper.replace(/^export /gm, '')}
return [ownIterable, ownItems];
})();
export const ownIterable = ownIteration[0];
export const ownItems = ownIteration[1];
`;
}
/**
 * idb, the service worker's IndexedDB wrapper, as a module without side
 * effects in the inject bundles: src/server/Cookies.ts imports it for its jar
 * class, which no inject bundle uses (they take the jar's parse and match
 * functions), and its top level (three WeakMaps and the trap tables it
 * builds) was in every proxied frame, 3 KB of each document bundle. Unused,
 * it is left out.
 */
const idbPure = {
	name: 'idb-pure',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^idb$/ }, async (args) => {
			if (args.pluginData === 'idb-pure') return undefined;
			const found = await pluginBuild.resolve(args.path, {
				kind: args.kind,
				importer: args.importer,
				resolveDir: args.resolveDir,
				pluginData: 'idb-pure',
			});
			return found.errors.length ? undefined : { ...found, sideEffects: false };
		});
	},
};

const ownIteration = ownIterationPlugin(
	[snapshot, domSnapshot, ownIterableFile],
	false,
	true,
);
// (the rewriter library's module statements run when it is evaluated, which
// may be after the page's scripts ran, in the page's realm: a worker's, a
// frame's own copy)
const libraryIteration = ownIterationPlugin(
	[libGlobals, ownIterableFile],
	true,
);

/**
 * The built-in blocker's engine snapshot (scripts/adblock-snapshot.mjs,
 * docs/adblock.md): what a worker with no engine stored serves on a first
 * visit, gzipped. Its serialization is blocker.wasm's, so a snapshot made by
 * another module, or a file its UPSTREAM does not describe, is refused here
 * rather than failing to load in every browser. Its age is not a build's
 * concern (an old checkout builds as it did); the nightly workflow checks
 * it (`--check`). It is asked for by the hash of its bytes (src/version.ts
 * ADBLOCK_SNAPSHOT), so a host may let browsers keep it for good.
 */
function adblockSnapshot() {
	const upstream = readFileSync('assets/adblock-snapshot.UPSTREAM', 'utf8');
	const digest = (path) =>
		createHash('sha256').update(readFileSync(path)).digest('hex');
	const file = digest('assets/adblock-snapshot.dat.gz');
	if (
		/^blocker\.wasm sha256 ([0-9a-f]{64})$/m.exec(upstream)?.[1] !==
		digest('assets/blocker.wasm')
	)
		throw new Error(
			'build: assets/adblock-snapshot.dat.gz was made by another blocker.wasm; run node scripts/adblock-snapshot.mjs',
		);
	if (/^sha256 ([0-9a-f]{64})$/m.exec(upstream)?.[1] !== file)
		throw new Error(
			'build: assets/adblock-snapshot.dat.gz is not the file assets/adblock-snapshot.UPSTREAM describes; run node scripts/adblock-snapshot.mjs',
		);
	return file.slice(0, 16);
}

/** @type {import('esbuild').BuildOptions} */
const common = {
	platform: 'browser',
	target: 'es2022',
	bundle: true,
	sourcemap: true,
	minify: !dev,
	// (the inject's own members by short names: scripts/memberNames.mjs)
	mangleProps: memberPattern,
	mangleCache: memberCache(),
	legalComments: 'none',
	logLevel: 'info',
	outdir: 'dist',
	define: {
		'process.env.STOMP_VERSION': JSON.stringify(pkg.version),
		// build id for the version pin between the service worker, the inject
		// bundles and the controller: the version plus a hash of the inputs
		'process.env.STOMP_BUILD': JSON.stringify(BUILD_ID),
		'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
		// what the rewriter library asset is asked for by: known once that
		// file is built (see `bundles` below)
		'process.env.STOMP_LIBRARY': '""',
		// what the rewriter's wasm core module is asked for by: the hash of
		// assets/core.wasm (see `bundles` below)
		'process.env.STOMP_CORE': '""',
		// what the blocker's engine snapshot is asked for by (src/version.ts
		// ADBLOCK_SNAPSHOT): the hash of its bytes
		'process.env.STOMP_ADBLOCK_SNAPSHOT': JSON.stringify(adblockSnapshot()),
		// (src/version.ts DOCUMENT, DOCUMENT_FULL: see `bundles` below)
		'process.env.STOMP_DOCUMENT': '""',
		'process.env.STOMP_DOCUMENT_FULL': '""',
		// (src/version.ts TRANSPORT_WORKER, REWRITE_WORKER, BLOCKER and the
		// frames': see `bundles` below)
		'process.env.STOMP_TRANSPORT_WORKER': '""',
		'process.env.STOMP_REWRITE_WORKER': '""',
		'process.env.STOMP_BLOCKER': '""',
		'process.env.STOMP_CONTROLLER_FRAME': '""',
		'process.env.STOMP_CONTROLLER_FRAME_SCRIPT': '""',
		'process.env.STOMP_SITE_FRAME_SCRIPT': '""',
		// the rewriter's generation (src/version.ts REWRITE_GENERATION): a
		// digest of the bytes a rewrite's output depends on, known once the
		// wasm artifacts are copied and the library is built (see `bundles`
		// and the production branch below). Empty under a dev build.
		'process.env.STOMP_REWRITE_GENERATION': '""',
		// the codec module (rust/codec), carried in every bundle that seals a
		// routed URL and compiled where it runs (src/wasm/codec.ts): 1.4 KB
		// no realm can wait for a fetch of
		'process.env.STOMP_CODEC_WASM': JSON.stringify(
			readFileSync('assets/codec.wasm').toString('base64url'),
		),
	},
};

/**
 * `source-map` / `source-map-js` are pulled in only to print source maps,
 * which the rewriters never ask for: any bundle that reaches them gets
 * src/noSourceMaps.ts instead.
 *
 * @type {import('esbuild').Plugin}
 */
const noSourceMaps = {
	name: 'no-source-maps',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^source-map(-js)?(\/.*)?$/ }, () => ({
			path: resolve('src/noSourceMaps.ts'),
		}));
	},
};

/**
 * The light rewriter library (src/rewriterLight.ts: the glue of the wasm
 * modules and nothing they stand in for) for the inject bundles, which
 * import it as `stomp:rewriter-lib`: bundled on its own and handed over as
 * a function that evaluates it, so a frame evaluates none of it until it
 * rewrites something, and a top can evaluate the same text in a realm of
 * its own for the frames under it (src/inject/rewriter.ts). Its globals
 * come from src/libGlobals.ts, which also names every global the inject
 * bundles inject: the text names nothing of the bundle it is carried in.
 * The parsers, the printer and the public suffix list are not in it: they
 * are the rewriter library below, a file of its own.
 *
 * @type {import('esbuild').Plugin}
 */
/**
 * A light library's entry point: its file's `api`, handed out in
 * `__stompLibApi`, a parameter of the function the library's text is the body
 * of. An export would have esbuild copy the module's names out with a
 * for...of, which takes the page's Array.prototype[Symbol.iterator] when a
 * copy is evaluated after the page's scripts ran.
 *
 * @param {string} file
 * @returns {import('esbuild').Plugin}
 */
const libraryEntry = (file) => ({
	name: 'library-entry',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^stomp:library-entry$/ }, () => ({
			path: 'library-entry',
			namespace: 'library-entry',
		}));
		pluginBuild.onLoad({ filter: /.*/, namespace: 'library-entry' }, () => ({
			// (by the file from the root, so no map names the checkout's path)
			contents: `"use strict";\nimport { api } from ${JSON.stringify(`./${fileId(resolve(file))}`)};\n__stompLibApi = api;\n`,
			loader: 'js',
			resolveDir: resolve('.'),
		}));
	},
});

/**
 * A light library's CommonJS imports (crypto-js), each a module whose
 * default is what the package's `require` returns: esbuild's own import of
 * one copies its names out with a for...of as the library is evaluated,
 * which a copy does after the page's scripts ran (libraryEntry says why).
 *
 * @type {import('esbuild').Plugin}
 */
const requiredDefaults = {
	name: 'required-defaults',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^crypto-js\// }, (args) =>
			args.kind === 'require-call'
				? undefined
				: { path: args.path, namespace: 'required-default' },
		);
		pluginBuild.onLoad(
			{ filter: /.*/, namespace: 'required-default' },
			(args) => ({
				contents: `export default require(${JSON.stringify(args.path)});\n`,
				loader: 'js',
				resolveDir: resolve('.'),
			}),
		);
	},
};

/** the light library's text (`worker`: a worker's), built on its own */
async function lightLibrary(worker, define) {
	const result = await build({
		...common,
		define,
		entryPoints: ['stomp:library-entry'],
		format: 'iife',
		inject: [resolve('src/libGlobals.ts')],
		plugins: [
			libraryEntry(
				worker ? 'src/rewriterLightWorker.ts' : 'src/rewriterLightDocument.ts',
			),
			requiredDefaults,
			noSourceMaps,
			withOwnIterable,
			libraryIteration,
		],
		sourcemap: false,
		write: false,
		metafile: true,
		logLevel: 'silent',
	});
	return {
		text: result.outputFiles[0].text,
		inputs: Object.keys(result.metafile.inputs).map((input) => resolve(input)),
	};
}

/**
 * The document's light library is not in the document bundle: a frame uses
 * its top's and evaluates none, so it is the second statement of the
 * rewriter library's file, which every proxied top's shell loads already
 * (`LIGHT_FACTORY`, src/version.ts; src/inject/rewriter.ts lightFactory).
 * The document bundle's `stomp:rewriter-lib` is null; a worker's carries
 * its own.
 */
const LIGHT_FACTORY = '__stompRewriterLight';
/** the name the deferred parts' statement assigns (src/version.ts DEFERRED_FACTORY) */
const DEFERRED_FACTORY = '__stompDeferred';
/** the name the passkey provider's client's statement assigns (src/version.ts PASSKEYS_FACTORY) */
const PASSKEYS_FACTORY = '__stompPasskeys';
/** the name the activation gates' statement assigns (src/version.ts ACTIVATION_FACTORY) */
const ACTIVATION_FACTORY = '__stompActivation';

const rewriterLib = {
	name: 'rewriter-lib',
	setup(pluginBuild) {
		// a worker's has no stylesheets and no suffix list (injectWorker and
		// injectWorkerFull, the crypto-free and crypto-js worker bundles)
		const worker = Object.keys(pluginBuild.initialOptions.entryPoints).some(
			(name) => name.startsWith('injectWorker'),
		);
		pluginBuild.onResolve({ filter: /^stomp:rewriter-lib$/ }, (args) => ({
			path: args.path,
			namespace: 'rewriter-lib',
		}));
		pluginBuild.onLoad(
			{ filter: /.*/, namespace: 'rewriter-lib' },
			async () => {
				if (!worker)
					return { contents: 'export default null;\n', loader: 'js' };
				// the library seals its URLs in JavaScript, the same text: the
				// bundle that carries it carries the codec module already
				// (its Reflect is src/libGlobals.ts's, and it names nothing of the
				// bundle's: not the snapshot's methods either)
				const define = Object.fromEntries(
					Object.entries(pluginBuild.initialOptions.define).filter(
						([key]) => !(key in reflectDefines),
					),
				);
				const { text, inputs } = await lightLibrary(worker, {
					...define,
					'process.env.STOMP_CODEC_WASM': 'undefined',
				});
				return {
					contents: `export default function rewriterLib(__stompRealm, __stompLibApi) {\n${text}\nreturn __stompLibApi;\n}\n`,
					loader: 'js',
					watchFiles: inputs,
				};
			},
		);
	},
};

/**
 * The light rewriter library (src/rewriterLightDocument.ts: the wasm glue and
 * nothing a parser stands in for), the asset `rewriterLib`: no document bundle
 * carries it (a frame uses its top's and evaluates none). Its statement
 * assigns the factory to a name (src/version.ts LIGHT_FACTORY), and is the
 * file's first; the document bundles' deferred parts are its second (below).
 * It is read two ways. A proxied top's shell loads it as a script before the
 * inject bundle, which takes the factory and removes the name
 * (src/rewriteHTML.ts, src/inject/rewriter.ts). A sandboxed frame's own copy,
 * and a top whose shell did not load it, are handed its text the first time a
 * call needs it (src/inject/rewriter.ts, synchronously) and evaluate it in
 * their own realm as the body of a function that has the name as a parameter,
 * which writes no global. A statement survives a host's minifier, which drops
 * a function expression nobody uses.
 *
 * @type {import('esbuild').BuildOptions}
 */
const rewriterLibrary = {
	...common,
	// (the light library seals its URLs in JavaScript, the same text)
	define: { ...common.define, 'process.env.STOMP_CODEC_WASM': 'undefined' },
	entryPoints: { rewriterLib: 'stomp:library-entry' },
	format: 'iife',
	inject: [resolve('src/libGlobals.ts')],
	banner: {
		js: `globalThis.${LIGHT_FACTORY}=function(__stompRealm,__stompLibApi){`,
	},
	footer: { js: 'return __stompLibApi;};' },
	plugins: [
		libraryEntry('src/rewriterLightDocument.ts'),
		requiredDefaults,
		noSourceMaps,
		withOwnIterable,
		libraryIteration,
	],
	// written with the deferred parts after it (libraryFile)
	write: false,
};

/**
 * The document bundles' deferred parts (src/inject/dom/deferredParts.ts,
 * src/inject/dom/deferred.ts): code most frames never run, which no
 * document bundle carries. They are a statement of the rewriter library's
 * file, `__stompDeferred=function(__stompShared,__stompPart){...};`
 * (src/version.ts DEFERRED_FACTORY; partsStatement), after the light
 * library's, each group of them a case a realm runs at its first need of one
 * of the group's parts (partGroups): a proxied
 * top's shell loads that file already, the controller fetched it when it
 * started, and a realm with no top to take them from reads them from the one
 * request its light library makes. No host serves a new file.
 *
 * Only the files listed here are the parts' own. Every other module they
 * import is the document bundle's, the same values: the import is a module
 * of the parts' that reads them from `__stompShared`, which the bundle
 * makes (`stomp:deferred-shared`, below) with exactly the names the parts
 * import. So the snapshots are the ones taken before any page script ran,
 * the client's classes are the bundle's (getModule finds its modules) and
 * nothing is evaluated twice. A name read that way is read once, when the
 * parts are evaluated: one that may change later (`let`, `var`) is refused
 * here. A listed file may be in no document bundle, and a file only the
 * parts import has to be listed (both checked after the build).
 */
const DEFERRED_FILES = new Set(
	[
		'node_modules/@mercuryworkshop/proxy-transports/dist/index.mjs',
		'node_modules/entities/dist/escape.js',
		'src/blocker/procedural.ts',
		'src/cspJudge.ts',
		'src/cspSources.ts',
		'src/inject/bareClient.ts',
		'src/inject/cacheCalls.ts',
		'src/inject/cookieStoreMethods.ts',
		'src/inject/deviceGrants.ts',
		'src/inject/dom/activationGates.ts',
		'src/inject/dom/activationPart.ts',
		'src/inject/dom/ancestorOriginsList.ts',
		'src/inject/dom/attributeViewMethods.ts',
		'src/inject/dom/calledHooks.ts',
		'src/inject/dom/calledFrames.ts',
		'src/inject/dom/calledNavigation.ts',
		'src/inject/dom/beaconRelay.ts',
		'src/inject/dom/credentialCalls.ts',
		'src/inject/dom/credentialFlows.ts',
		'src/inject/dom/credentialStore.ts',
		'src/inject/dom/deferredParts.ts',
		'src/inject/dom/downloadSave.ts',
		'src/inject/dom/fetchLater.ts',
		'src/inject/dom/formSubmissions.ts',
		'src/inject/dom/fragmentLinks.ts',
		'src/inject/dom/animatedHref.ts',
		'src/inject/dom/handlerGetters.ts',
		'src/inject/dom/importMaps.ts',
		'src/inject/dom/legacyEncoding.ts',
		'src/inject/dom/linkOpens.ts',
		'src/inject/dom/lazyFonts.ts',
		'src/inject/dom/instructions.ts',
		'src/inject/dom/markupMembers.ts',
		'src/inject/dom/measuredMemory.ts',
		'src/inject/dom/mediaArtwork.ts',
		'src/inject/dom/objectLoads.ts',
		'src/inject/dom/markupSinks.ts',
		'src/inject/dom/navigateCalls.ts',
		'src/inject/dom/openerFacts.ts',
		'src/inject/dom/pictureWindows.ts',
		'src/inject/dom/policyChecks.ts',
		'src/inject/dom/rareAttributes.ts',
		'src/inject/dom/rareReads.ts',
		'src/inject/dom/modules/Fingerprint.ts',
		'src/inject/modules/NavigatorIdentity.ts',
		'src/userAgent.ts',
		'src/inject/dom/deviceIds.ts',
		'src/inject/dom/modules/LongFrames.ts',
		'src/inject/dom/modules/LongTasks.ts',
		'src/inject/dom/modules/permissionCalls.ts',
		'src/inject/dom/rtcInstall.ts',
		'src/inject/dom/sealedCopies.ts',
		'src/inject/dom/seenImages.ts',
		'src/inject/dom/xhrMessages.ts',
		'src/inject/dom/xhrParse.ts',
		'src/inject/dom/modules/serviceWorkerEmulation.ts',
		'src/inject/dom/navigateOther.ts',
		'src/inject/dom/navigationRefusal.ts',
		'src/inject/dom/passkeys.ts',
		'src/inject/dom/passkeysPart.ts',
		'src/inject/dom/presentations.ts',
		'src/inject/dom/protocolHandlers.ts',
		'src/inject/dom/sourcePolicy.ts',
		'src/inject/dom/WriteStream.ts',
		'src/inject/dom/windowOpen.ts',
		'src/inject/dom/writeTokenizer.ts',
		'src/inject/dom/storageAccess.ts',
		'src/inject/dom/taintRefusals.ts',
		'src/inject/dom/violationDelivery.ts',
		'src/inject/dom/violations.ts',
		'src/inject/dom/viewTransitions.ts',
		'src/inject/dom/markupPlaces.ts',
		'src/inject/violationDispatch.ts',
		'src/inject/dom/uncontrolledCopies.ts',
		'src/inject/dom/moduleGraph.ts',
		'src/inject/dom/syncAnswer.ts',
		'src/inject/dom/syncRelay.ts',
		'src/acceptLanguage.ts',
		'src/syncAsk.ts',
		'src/inject/idbSize.ts',
		'src/inject/storageUsage.ts',
		'src/inject/legacyFileSystem.ts',
		'src/inject/permissionGates.ts',
		'src/passkeys/types.ts',
		'src/refresh.ts',
		'src/refusalName.ts',
		'src/wasm/codecBytes.ts',
		'src/wasm/codecInstance.ts',
		'src/inject/serviceWorkerObjects.ts',
		'src/inject/positionMaps.ts',
		'src/inject/originFrom.ts',
		'src/inject/storageBucketMethods.ts',
		'src/inject/windowArrays.ts',
		'src/inject/webTransport.ts',
		'src/inject/webTransportStandIn.ts',
		'src/inject/xhrChecks.ts',
		'src/mixedContentNotices.ts',
		'src/sha.ts',
		'src/sriDigest.ts',
		'src/htmlShell.ts',
		'src/importMap.ts',
		'src/inject/accessFailures.ts',
		'src/inject/reportsSeen.ts',
		'src/inject/workerStart.ts',
		'src/inject/dom/siteAcross.ts',
		'src/inject/dom/siteEvents.ts',
		'src/transport/bodyPort.ts',
		'src/transport/RemoteTransport.ts',
		'src/transport/rpc.ts',
		'src/xmlShell.ts',
		'src/xmlStylesheet.ts',
		// (as esbuild names a module: by its real path, a linked node_modules
		// followed)
	].map((file) => realpathSync(resolve(file))),
);

/**
 * Deferred files whose state no two groups need to share (sha.ts: its
 * tables, made on first use): a group that reaches one carries its own
 * copy, and two groups that reach it are not one for it (partGroups). The
 * hashes joined the page's policy checks, the integrity checks and the
 * position maps with long animation frames into one group of 21 KB, which
 * a frame under a script policy evaluated whole (about 2 to 3 KB of heap a
 * frame more than its checks alone, measured, Chrome 157). cspSources.ts,
 * the source matching, is a part of its own (DocumentClient pageRefusals,
 * the violations, the site pool's frames) and in the policy checks' group:
 * joined by it the two would be one, and a document's first load a policy
 * of the page's governs would evaluate the checks with it.
 */
const COPIED_FILES = new Set(
	['src/cspSources.ts', 'src/sha.ts'].map((file) =>
		realpathSync(resolve(file)),
	),
);
const DEFERRED_ENTRY = 'src/inject/dom/deferredParts.ts';
/** what the parts read of the bundle: by file (from the root), the names */
const deferredShared = new Map();
/**
 * A shared module's number, `__stompShared(<number>)`: its place among the
 * modules by file name, from SHARED_FIRST. The parts are built in parallel,
 * so the order in which they first ask for each module varies from build to
 * build; while they build, a module has its place in that order
 * (deferredSharing), and once all are built writeLibrary renumbers it by
 * name (sharedNumbers), as the table is (deferredTable). Both numbers have
 * two digits, so the renumbering moves no column of the parts' maps.
 */
const SHARED_FIRST = 10;
const SHARED_LAST = 99;
/** `map` with the shared modules' texts in it renumbered (sharedNumbers) */
function sharedSources(map) {
	if (!map.sourcesContent) return map;
	return {
		...map,
		sourcesContent: map.sourcesContent.map((content, index) =>
			map.sources[index]?.startsWith(`${SHARED}:`) && content !== null
				? sharedNumbers(content)
				: content,
		),
	};
}
/** the shared modules' files, in the order of their numbers */
const sharedOrder = () => [...deferredShared.keys()].sort();
/**
 * `text` with every module's number while building replaced by its number by
 * name (deferredShared complete: all the parts built)
 */
function sharedNumbers(text) {
	const order = sharedOrder();
	const building = [...deferredShared.keys()];
	return text.replace(/__stompShared\((\d+)\)/g, (call, number) => {
		const id = building[Number(number) - SHARED_FIRST];
		if (id === undefined)
			throw new Error(`build: ${call} names no shared module`);
		return `__stompShared(${SHARED_FIRST + order.indexOf(id)})`;
	});
}
const fileId = (file) => relative(resolve('.'), file).split(sep).join('/');

const parsedSources = new Map();
function parsedSource(file) {
	let source = parsedSources.get(file);
	if (!source) {
		source = ts.createSourceFile(
			file,
			sourceText(file),
			ts.ScriptTarget.Latest,
		);
		parsedSources.set(file, source);
	}
	return source;
}
const hasModifier = (node, kind) =>
	!!ts.canHaveModifiers(node) &&
	!!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);

/** the value names `importer` imports (or re-exports) from `specifier` */
function importedNames(importer, specifier) {
	const names = new Set();
	const elements = (list) => {
		for (const element of list)
			if (!element.isTypeOnly)
				names.add((element.propertyName ?? element.name).text);
	};
	for (const node of parsedSource(importer).statements) {
		if (node.moduleSpecifier?.text !== specifier) continue;
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			if (!clause || clause.isTypeOnly) continue;
			if (clause.name) names.add('default');
			if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
				throw new Error(
					`${fileId(importer)}: a deferred part imports '${specifier}' as a namespace; import its names`,
				);
			if (clause.namedBindings) elements(clause.namedBindings.elements);
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			if (!node.exportClause || ts.isNamespaceExport(node.exportClause))
				throw new Error(
					`${fileId(importer)}: a deferred part re-exports all of '${specifier}'; name what it exports`,
				);
			elements(node.exportClause.elements);
		}
	}
	return names;
}

/**
 * What `file` exports as values, each with whether its binding may change
 * (`let`, `var`); `star` when it re-exports another module whole
 */
function valueExports(file) {
	const exports = new Map();
	const locals = new Map();
	const lists = [];
	let star = false;
	for (const node of parsedSource(file).statements) {
		const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
		const named = hasModifier(node, ts.SyntaxKind.DefaultKeyword)
			? 'default'
			: node.name?.text;
		if (ts.isVariableStatement(node)) {
			const mutable = !(node.declarationList.flags & ts.NodeFlags.Const);
			for (const declaration of node.declarationList.declarations)
				if (ts.isIdentifier(declaration.name)) {
					locals.set(declaration.name.text, mutable);
					if (exported) exports.set(declaration.name.text, mutable);
				}
		} else if (
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isEnumDeclaration(node)
		) {
			if (node.name) locals.set(node.name.text, false);
			if (exported && named) exports.set(named, false);
		} else if (
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node)
		) {
			locals.set(node.name.text, 'type');
		} else if (ts.isExportAssignment(node) && !node.isExportEquals) {
			exports.set('default', false);
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			if (!node.exportClause) star = true;
			else if (ts.isNamedExports(node.exportClause))
				for (const element of node.exportClause.elements)
					if (!element.isTypeOnly)
						lists.push([
							element.name.text,
							node.moduleSpecifier
								? undefined
								: (element.propertyName ?? element.name).text,
						]);
		}
	}
	for (const [name, local] of lists) {
		const kind = local === undefined ? false : locals.get(local);
		if (kind !== 'type') exports.set(name, kind === true);
	}
	return { exports, star };
}

const SHARED = 'deferred-shared';
/**
 * The key a shared module's value has in the table (deferredTable) and in
 * the parts' reads of it (deferredSharing): its place among the file's
 * exports, which every build reads alike, so a frame's table names no
 * export (2 KB of every document bundle was the names); the name itself
 * for one the file re-exports whole
 */
function sharedKey(id, name) {
	const at = [...valueExports(resolve(id)).exports.keys()].indexOf(name);
	return at < 0 ? JSON.stringify(name) : String(at);
}
/** the parts' imports of the bundle's modules (see DEFERRED_FILES) */
const deferredSharing = {
	name: 'deferred-sharing',
	setup(pluginBuild) {
		const injected = new Set(
			(pluginBuild.initialOptions.inject ?? []).map((file) => resolve(file)),
		);
		pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
			if (args.pluginData === SHARED || args.namespace !== 'file') return;
			const found = await pluginBuild.resolve(args.path, {
				kind: args.kind,
				importer: args.importer,
				resolveDir: args.resolveDir,
				pluginData: SHARED,
			});
			if (found.errors.length || found.external || found.namespace !== 'file')
				return;
			const entry = args.kind === 'entry-point';
			if (entry && !injected.has(found.path)) return;
			if (DEFERRED_FILES.has(found.path)) return;
			const id = fileId(found.path);
			const { exports, star } = valueExports(found.path);
			// an injected file (a snapshot) gives every name it exports
			const names = entry
				? [...exports.keys()]
				: [...importedNames(args.importer, args.path)].filter(
						(name) => exports.has(name) || star,
					);
			for (const name of names)
				if (exports.get(name) === true)
					throw new Error(
						`${id}: a deferred part imports '${name}', a binding that may change (let, var): export a const or a function`,
					);
			names.sort();
			const known = deferredShared.get(id) ?? new Set();
			for (const name of names) known.add(name);
			deferredShared.set(id, known);
			// (by the file from the root, so no map names the checkout's path)
			return {
				path: `${id}?${names.join(',')}`,
				namespace: SHARED,
				pluginData: { id, names },
			};
		});
		pluginBuild.onLoad({ filter: /.*/, namespace: SHARED }, (args) => {
			const { id, names } = args.pluginData;
			// pure, so a group's build keeps only the reads it uses (each
			// group is built on its own and given every name of a snapshot:
			// partGroups); esbuild makes each read a plain one again
			const values = names.map(
				(name, index) =>
					`v${index} = /* @__PURE__ */ (() => m[${sharedKey(id, name)}])()`,
			);
			// the module's number while building (SHARED_FIRST)
			const number = SHARED_FIRST + [...deferredShared.keys()].indexOf(id);
			if (number > SHARED_LAST)
				throw new Error(
					`build: more than ${SHARED_LAST - SHARED_FIRST + 1} modules shared with the deferred parts (build.js SHARED_LAST)`,
				);
			return {
				contents: `const m = /* @__PURE__ */ __stompShared(${number});\n${
					values.length ? `const ${values.join(', ')};\n` : ''
				}export { ${names.map((name, index) => `v${index} as ${name}`).join(', ')} };\n`,
				loader: 'js',
			};
		});
	},
};

/**
 * How the parts' groups and the passkey provider's client are built: as an
 * IIFE whose free names are the statement's (`__stompShared`, the bundle's
 * table, and `__stompParts`, which the group's entry sets `made` on)
 *
 * @type {import('esbuild').BuildOptions}
 */
const partBuild = {
	...common,
	define: { ...common.define, ...reflectDefines },
	format: 'iife',
	inject: [snapshot, domSnapshot],
	plugins: [
		noSourceMaps,
		deferredSharing,
		withOwnIterable,
		ownIterationPlugin([snapshot, domSnapshot, ownIterableFile], true, true),
	],
	write: false,
	metafile: true,
};

/** a file an import of `from` names (`specifier`, relative), as esbuild resolves a TypeScript one */
function importedFile(from, specifier) {
	const base = resolve(dirname(from), specifier);
	for (const file of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
		if (existsSync(file) && statSync(file).isFile()) return realpathSync(file);
	throw new Error(`${fileId(from)}: cannot find '${specifier}'`);
}

/**
 * The parts deferredParts.ts lists, by the file each is imported from: the
 * import's clause, and the names it gives (which `parts` lists, shorthand)
 */
function partFiles() {
	const file = resolve(DEFERRED_ENTRY);
	const source = parsedSource(file);
	const files = new Map();
	let listed = null;
	for (const node of source.statements) {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			if (!clause || clause.isTypeOnly) continue;
			const imported = importedFile(file, node.moduleSpecifier.text);
			if (!DEFERRED_FILES.has(imported))
				throw new Error(
					`${DEFERRED_ENTRY}: '${node.moduleSpecifier.text}' is not a deferred file (build.js DEFERRED_FILES)`,
				);
			const names = [];
			if (clause.name) names.push(clause.name.text);
			if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
				throw new Error(
					`${DEFERRED_ENTRY}: '${node.moduleSpecifier.text}' is imported as a namespace; import its names`,
				);
			for (const element of clause.namedBindings?.elements ?? [])
				if (!element.isTypeOnly) names.push(element.name.text);
			const entry = files.get(imported) ?? {
				file: imported,
				imports: [],
				names: [],
			};
			entry.imports.push(
				// (as deferredParts.ts names it, from its directory: the group's
				// resolveDir, so no map names the checkout's path)
				`import ${clause.getText(source)} from ${JSON.stringify(node.moduleSpecifier.text)};`,
			);
			entry.names.push(...names);
			files.set(imported, entry);
		} else if (ts.isVariableStatement(node))
			for (const declaration of node.declarationList.declarations)
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === 'parts' &&
					declaration.initializer &&
					ts.isObjectLiteralExpression(declaration.initializer)
				)
					listed = declaration.initializer.properties.map((property) => {
						if (!ts.isShorthandPropertyAssignment(property))
							throw new Error(
								`${DEFERRED_ENTRY}: list each part in \`parts\` by its name alone`,
							);
						return property.name.text;
					});
	}
	const imported = [...files.values()].flatMap((entry) => entry.names);
	if (
		!listed ||
		listed.length !== imported.length ||
		!imported.every((name) => listed.includes(name))
	)
		throw new Error(
			`${DEFERRED_ENTRY}: \`parts\` lists every name the file imports, and no other`,
		);
	return [...files.values()];
}

/**
 * A group's build: the imports of its files, `made` the object of their parts
 * (handed over that way and not as the entry's exports, which esbuild would
 * build with helpers of its own that read Object's methods when the group is
 * evaluated: a page's by then)
 */
function groupBuild(files) {
	const names = files.flatMap((entry) => entry.names);
	return {
		...partBuild,
		stdin: {
			contents: `${files.flatMap((entry) => entry.imports).join('\n')}\n__stompParts.made = { ${names.join(', ')} };\n`,
			loader: 'ts',
			resolveDir: resolve(dirname(DEFERRED_ENTRY)),
			sourcefile: DEFERRED_ENTRY,
		},
	};
}

/** the deferred files a build of the parts reached */
function reachedFiles(metafile) {
	const reached = new Set();
	for (const input of Object.keys(metafile.inputs)) {
		// (the group's entry, stdin, is no file; a module the bundle shares
		// is in a namespace of its own)
		if (input.includes(':') || !existsSync(resolve(input))) continue;
		const file = realpathSync(resolve(input));
		if (DEFERRED_FILES.has(file) && !COPIED_FILES.has(file)) reached.add(file);
	}
	return reached;
}

/**
 * The parts' groups, each evaluated on its own the first time a document
 * needs one of its parts (src/inject/dom/deferred.ts): a file deferredParts.ts
 * imports parts from is a group, and two that reach one deferred file are one
 * group, so every module is evaluated once in a realm (one WebSocket
 * transport, one tokenizer). Each with its parts' names, its build and that
 * build's output.
 */
async function partGroups() {
	const files = partFiles();
	const alone = await Promise.all(
		files.map(async (entry) => {
			const options = groupBuild([entry]);
			const result = await build(options);
			return {
				files: [entry],
				reached: reachedFiles(result.metafile),
				options,
				result,
			};
		}),
	);
	const groups = [];
	for (const item of alone) {
		const joined = groups.filter((group) =>
			[...item.reached].some((file) => group.reached.has(file)),
		);
		const into = joined[0];
		if (!into) {
			groups.push({ ...item, reached: new Set(item.reached) });
			continue;
		}
		for (const other of [item, ...joined.slice(1)]) {
			into.files.push(...other.files);
			for (const file of other.reached) into.reached.add(file);
			into.result = null;
			if (other !== item) groups.splice(groups.indexOf(other), 1);
		}
	}
	return Promise.all(
		groups.map(async (group) => {
			const options = group.result ? group.options : groupBuild(group.files);
			const result = group.result ?? (await build(options));
			return {
				names: group.files.flatMap((entry) => entry.names),
				options,
				output: outputOf(result),
			};
		}),
	);
}

/**
 * The deferred parts' statement, `__stompDeferred=function(__stompShared,
 * __stompPart){...};` (src/version.ts DEFERRED_FACTORY): a switch on the
 * part's name whose case is the group that has it, run the first time a
 * document needs one of its parts, which returns the group's parts. A top
 * has the statement from its shell's script (one compilation every top
 * shares); a frame evaluates the group it needs alone, cut out of the text
 * (src/inject/rewriter.ts partGroup) at its case line and the `}break;`
 * that ends it, so neither may be anywhere else. Every group's map, by the
 * line it starts at.
 */
function partsStatement(groups, outputs = groups.map((group) => group.output)) {
	let text = `globalThis.${DEFERRED_FACTORY}=function(__stompShared,__stompPart){"use strict";var __stompParts={};switch(__stompPart){\n`;
	const sections = [];
	groups.forEach((group, index) => {
		const output = outputs[index];
		text += `${group.names.map((name) => `case ${JSON.stringify(name)}:`).join('')}{\n`;
		if (output.map)
			sections.push({ line: text.split('\n').length - 1, map: output.map });
		text += `${output.text.endsWith('\n') ? output.text : `${output.text}\n`}}break;\n`;
	});
	text += '}return __stompParts.made;};';
	for (const name of groups.flatMap((group) => group.names))
		if (text.split(`case ${JSON.stringify(name)}:`).length !== 2)
			throw new Error(`build: the parts' statement has case "${name}" twice`);
	if (text.split('\n}break;').length !== groups.length + 1)
		throw new Error("build: a deferred part's code has a line `}break;`");
	return { raw: text, text, map: null, sections };
}

/**
 * The WebAuthn client of STomp's passkey provider
 * (src/inject/dom/passkeysPart.ts), a deferred statement of its own after the
 * parts', `__stompPasskeys=function(__stompShared){...};` (src/version.ts
 * PASSKEYS_FACTORY): built as the parts are, with the same sharing, but not
 * among them, so a frame that needs a part compiles none of it.
 *
 * @type {import('esbuild').BuildOptions}
 */
const passkeysPart = {
	...partBuild,
	entryPoints: { passkeysPart: 'src/inject/dom/passkeysPart.ts' },
	banner: {
		js: `globalThis.${PASSKEYS_FACTORY}=function(__stompShared){"use strict";var __stompParts={};`,
	},
	footer: { js: 'return __stompParts.made;};' },
};

/**
 * The gates of a document's gesture-gated calls
 * (src/inject/dom/activationPart.ts), a deferred statement of its own after
 * the passkey provider's, `__stompActivation=function(__stompShared){...};`
 * (src/version.ts ACTIVATION_FACTORY), built as the passkey provider's is: a
 * document that gets an activation only through the proxy compiles it, and
 * none of the parts.
 *
 * @type {import('esbuild').BuildOptions}
 */
const activationPart = {
	...partBuild,
	entryPoints: { activationPart: 'src/inject/dom/activationPart.ts' },
	banner: {
		js: `globalThis.${ACTIVATION_FACTORY}=function(__stompShared){"use strict";var __stompParts={};`,
	},
	footer: { js: 'return __stompParts.made;};' },
};

/**
 * `extensions-world:source` in the extensions' runtime: the text of the
 * isolated world's bundle (src/extensions/runtime/world/entry.ts), which
 * the runtime evaluates in each world's realm (src/extensions/runtime/
 * worlds.ts). Built with the runtime's own options, so the two mangle the
 * members they share alike
 */
const extensionsWorld = {
	name: 'extensions-world',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^extensions-world:source$/ }, (args) => ({
			path: args.path,
			namespace: 'extensions-world',
		}));
		pluginBuild.onLoad(
			{ filter: /.*/, namespace: 'extensions-world' },
			async () => {
				const options = pluginBuild.initialOptions;
				const built = await esbuildBuild({
					entryPoints: ['src/extensions/runtime/world/entry.ts'],
					bundle: true,
					write: false,
					metafile: true,
					format: 'iife',
					platform: 'browser',
					target: options.target,
					minify: options.minify,
					mangleProps: options.mangleProps,
					mangleCache: options.mangleCache,
					legalComments: 'none',
					define: options.define,
					logLevel: 'silent',
				});
				return {
					contents: `export default ${JSON.stringify(built.outputFiles[0].text)};\n`,
					loader: 'js',
					watchFiles: Object.keys(built.metafile.inputs).map((file) =>
						resolve(file),
					),
				};
			},
		);
	},
};

/**
 * `stomp:deferred-shared` in the document bundles: a function that makes,
 * when the parts are first evaluated, what they read of the bundle
 * (deferredSharing), by file and name
 */
const deferredTable = {
	name: 'deferred-table',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^stomp:deferred-shared$/ }, (args) => ({
			path: args.path,
			namespace: 'deferred-table',
		}));
		pluginBuild.onLoad({ filter: /.*/, namespace: 'deferred-table' }, () => {
			let imports = '';
			const entries = [];
			// (by name, as sharedNumbers numbers the parts' reads)
			sharedOrder().forEach((id, at) => {
				const names = deferredShared.get(id);
				const index = SHARED_FIRST + at;
				const list = [...names].sort();
				if (!list.length) return;
				imports += `import { ${list.map((name, at) => `${name} as s${index}_${at}`).join(', ')} } from ${JSON.stringify(`./${id}`)};\n`;
				entries.push(
					`case ${index}: return { ${list.map((name, at) => `${sharedKey(id, name)}: s${index}_${at}`).join(', ')} };`,
				);
			});
			// by the module's number (deferredSharing), made only for a
			// statement that reads it
			return {
				contents: `${imports}export default (module) => { switch (module) { ${entries.join(' ')} } };\n`,
				loader: 'js',
				resolveDir: resolve('.'),
			};
		});
	},
};

/**
 * What a document bundle's build says of the deferred parts: no listed file
 * in it, and none of the files the parts read of it there only for them
 */
function checkDeferred(metafile, name) {
	const importers = new Map();
	for (const [input, { imports }] of Object.entries(metafile.inputs))
		for (const imported of imports)
			if (!input.startsWith('deferred-table:'))
				importers.set(
					resolve(imported.path),
					(importers.get(resolve(imported.path)) ?? 0) + 1,
				);
	const inputs = new Set(
		Object.keys(metafile.inputs).map((input) => resolve(input)),
	);
	for (const file of DEFERRED_FILES)
		if (inputs.has(file))
			throw new Error(
				`${name}: ${fileId(file)} is a deferred part (build.js DEFERRED_FILES) but the bundle imports it`,
			);
	for (const id of deferredShared.keys()) {
		const file = resolve(id);
		if (file === snapshot || file === domSnapshot) continue;
		if (!importers.get(file))
			throw new Error(
				`${name}: only the deferred parts import ${id}: list it in build.js DEFERRED_FILES`,
			);
	}
}

/** the text of a built file and its map, without the comment that names the map */
function outputOf(result) {
	const text = result.outputFiles.find((file) => file.path.endsWith('.js'));
	const map = result.outputFiles.find((file) => file.path.endsWith('.js.map'));
	return {
		raw: text.text,
		text: text.text.replace(/\/\/# sourceMappingURL=[^\n]*\n?$/, ''),
		map: map ? JSON.parse(map.text) : null,
	};
}

/**
 * dist/rewriterLib.js: the light library's statement, then the deferred
 * parts', then the passkey provider's client's, then the activation
 * gates', each after a line break
 * (src/inject/rewriter.ts fileStatements), with one map of all (a sectioned
 * source map)
 */
async function writeLibrary(light, parts, passkeys, activation) {
	for (const name of [DEFERRED_FACTORY, PASSKEYS_FACTORY, ACTIVATION_FACTORY])
		for (const statement of [light, parts, passkeys, activation])
			if (statement.text.includes(`\nglobalThis.${name}=`))
				throw new Error(
					`rewriterLib: a line of the file starts with the name ${name}`,
				);
	const ended = (text) => (text.endsWith('\n') ? text : `${text}\n`);
	let text = '';
	const sections = [];
	for (const statement of [light, parts, passkeys, activation]) {
		const line = text.split('\n').length - 1;
		if (statement.map)
			sections.push({
				offset: { line, column: 0 },
				map: sharedSources(statement.map),
			});
		// (the parts' statement: a map for each group, by its line)
		for (const section of statement.sections ?? [])
			sections.push({
				offset: { line: line + section.line, column: 0 },
				map: sharedSources(section.map),
			});
		text += ended(sharedNumbers(statement.text));
	}
	await writeFile(
		'dist/rewriterLib.js',
		`${text}//# sourceMappingURL=rewriterLib.js.map\n`,
	);
	await writeFile(
		'dist/rewriterLib.js.map',
		JSON.stringify({ version: 3, file: 'rewriterLib.js', sections }),
	);
}

/**
 * Bundles that expose a classic-script global do so through an entry shim
 * (`Reflect.defineProperty(globalThis, ...)`) rather than esbuild's
 * `globalName`, because `globalName` emits a top-level `var` that cannot be
 * deleted, and the inject bundles delete `createClient` once consumed.
 *
 * @type {import('esbuild').BuildOptions[]}
 */
// The default inject bundles (injectDocument, injectWorker) swap crypto-js
// for a throwing stub (src/cryptoStub.ts), because crypto-js is read only by
// the aes, base64 and siv codecs (src/Codecs.ts, its default imports) and the
// common deployment runs the xor codec. Those codecs load injectDocumentFull
// and injectWorkerFull instead, which carry crypto-js (src/routeURL.ts,
// src/config.ts). So a proxied frame under xor or generic evaluates no crypto-js
// (about 19 KB of the document bundle and 61 KB of the worker's, plus its
// import-time lookup tables: roughly 40 KB of heap and 167 KB of resident
// memory per frame as measured).
const cryptoStub = resolve('src/cryptoStub.ts');
const stubCrypto = {
	'crypto-js/aes': cryptoStub,
	'crypto-js/enc-base64': cryptoStub,
	'crypto-js/enc-utf8': cryptoStub,
	'crypto-js/md5': cryptoStub,
};
/**
 * The siv codec (src/sivCodec.ts) the same way: its class, crypto-js's
 * HMAC-SHA-256 and core are in the full bundles only, the light ones take
 * a class that refuses to be made (src/sivCodecStub.ts)
 *
 * @type {import('esbuild').Plugin}
 */
/**
 * The document bundles' codec instance (src/wasm/codecInstance.ts) is a
 * deferred part: codec.ts imports src/wasm/codecInstanceStub.ts there,
 * which asks the part, so the 0.8 KB of the instance's code are in no frame
 * (a frame seals in its top's instance)
 */
const stubCodecInstance = {
	name: 'stub-codec-instance',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^\.\/codecInstance$/ }, (args) =>
			args.importer === resolve('src/wasm/codec.ts')
				? { path: resolve('src/wasm/codecInstanceStub.ts') }
				: undefined,
		);
	},
};

const stubSIV = {
	name: 'stub-siv',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^\.\/sivCodec$/ }, () => ({
			path: resolve('src/sivCodecStub.ts'),
		}));
	},
};

/**
 * The service worker's parts (src/server/swParts.ts): data a worker may
 * never read, which its script carries as text in a comment and parses the
 * first time it is asked for. Chrome compiles all of a service worker's
 * script when it installs it and serializes all of it into the code cache
 * before the install event, its literals among it; a comment is in neither.
 * The worker evaluates no string: a part is data its own code reads. Each
 * is its name and what makes its text.
 */
const SW_PARTS = [{ name: 'tldts-trie', text: tldtsTrieText }];
/** the marks of the holder's comment (src/server/swParts.ts) */
const SW_PART_NAME = '\u0002';
const SW_PART_TEXT = '\u0003';
const SW_PART_CLOSE = '*\u0001/';

/** tldts's public suffix trie, the module tldts's lookup imports */
const TLDTS_TRIE = 'node_modules/tldts/dist/es6/src/data/trie.js';
/** what src/server/tldtsTrie.ts makes of each of the trie's exports */
const TLDTS_TRIE_EXPORTS = {
	nodeFlags: 'Uint8Array',
	edgeStart: 'Uint16Array',
	edgeLength: 'Uint8Array',
	edgeChild: 'Uint16Array',
	labelText: 'string',
	rulesRoot: 'number',
	exceptionsRoot: 'number',
};
/**
 * The trie's values as JSON (src/server/tldtsTrie.ts), in ASCII so the
 * worker's script stays a one-byte string. A tldts whose trie has other
 * exports or kinds fails the build here: tldtsTrie.ts follows it first.
 */
async function tldtsTrieText() {
	const trie = await import(pathToFileURL(realpathSync(TLDTS_TRIE)).href);
	const names = Object.keys(trie).sort();
	const expected = Object.keys(TLDTS_TRIE_EXPORTS).sort();
	if (names.join() !== expected.join())
		throw new Error(
			`build: ${TLDTS_TRIE} exports ${names.join(', ')}, and src/server/tldtsTrie.ts makes ${expected.join(', ')}`,
		);
	const values = {};
	for (const name of expected) {
		const value = trie[name];
		const kind = ArrayBuffer.isView(value)
			? value.constructor.name
			: typeof value;
		if (kind !== TLDTS_TRIE_EXPORTS[name])
			throw new Error(
				`build: ${TLDTS_TRIE}'s ${name} is a ${kind}, and src/server/tldtsTrie.ts makes a ${TLDTS_TRIE_EXPORTS[name]}`,
			);
		values[name] = ArrayBuffer.isView(value) ? Array.from(value) : value;
	}
	return JSON.stringify(values).replace(
		/[\u007f-￿]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
}

/** each part's text as the holder's comment has it */
async function swPartTexts() {
	return Promise.all(
		SW_PARTS.map(async ({ name, text: make }) => {
			const text = await make();
			for (const mark of [SW_PART_NAME, SW_PART_TEXT, '\u0001'])
				if (text.includes(mark))
					throw new Error(
						`build: the service worker's part '${name}' has a U+000${mark.charCodeAt(0)} of its own`,
					);
			return `${SW_PART_NAME}${name}${SW_PART_TEXT}${text.replaceAll('*/', SW_PART_CLOSE)}`;
		}),
	);
}

/**
 * tldts in the service worker: src/suffix.ts's import of it is
 * src/server/tldtsPart.ts, which requires tldts at its first call (so
 * esbuild evaluates tldts's modules then), and the trie tldts's lookup
 * imports is src/server/tldtsTrie.ts, which parses its part
 *
 * @type {import('esbuild').Plugin}
 */
const swTldts = {
	name: 'sw-tldts',
	setup(pluginBuild) {
		const suffix = resolve('src/suffix.ts');
		const trie = realpathSync(resolve(TLDTS_TRIE));
		const part = resolve('src/server/tldtsPart.ts');
		pluginBuild.onResolve({ filter: /^tldts$/ }, (args) => {
			if (args.importer === suffix) return { path: part };
			// (the part's require is of the ES module tldts's import is, not
			// of its CommonJS build, which carries a trie of its own)
			if (args.importer === part && args.pluginData !== 'sw-tldts')
				return pluginBuild.resolve(args.path, {
					kind: 'import-statement',
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: 'sw-tldts',
				});
			return undefined;
		});
		pluginBuild.onResolve({ filter: /\/data\/trie$/ }, async (args) => {
			if (args.pluginData === 'sw-tldts') return undefined;
			const found = await pluginBuild.resolve(args.path, {
				kind: args.kind,
				importer: args.importer,
				resolveDir: args.resolveDir,
				pluginData: 'sw-tldts',
			});
			return !found.errors.length && realpathSync(found.path) === trie
				? { path: resolve('src/server/tldtsTrie.ts') }
				: undefined;
		});
	},
};

/**
 * The service worker's build writes its files itself: the script with the
 * parts' holder, `function __stompSwParts(){/*...*\/}`, as the last statement
 * of its IIFE (in the bundle's scope, no global of the worker's). The map
 * stays the build's: nothing it maps moves.
 *
 * @type {import('esbuild').Plugin}
 */
const swPartsHolder = {
	name: 'sw-parts-holder',
	setup(pluginBuild) {
		pluginBuild.onEnd(async (result) => {
			if (result.errors.length || !result.outputFiles) return;
			const holder = `function __stompSwParts(){/*${(await swPartTexts()).join('')}*/}`;
			for (const file of result.outputFiles) {
				let contents = file.contents;
				if (file.path.endsWith('.js')) {
					const text = file.text;
					const end = text.lastIndexOf('})();');
					if (
						end < 0 ||
						!/^\n(\/\/# sourceMappingURL=[^\n]*\n)?$/.test(text.slice(end + 5))
					)
						throw new Error(
							`build: ${relative(resolve('.'), file.path)} does not end with its IIFE`,
						);
					contents = `${text.slice(0, end)}${holder}${text.slice(end)}`;
				}
				await mkdir(dirname(file.path), { recursive: true });
				await writeFile(file.path, contents);
			}
		});
	},
};

/**
 * The property names a document bundle reads through a variable of its
 * IIFE (poolNames): minified, it wrote `.prototype` some 1,040 times, 10
 * bytes each, nearly all where hooks are installed as a frame starts, and
 * `a[pn]` is 4. A computed read of the same string is the same read (the
 * same getter, `this`, assignment, delete and optional chain). The others
 * are the interfaces and methods it names most often as it installs its
 * hooks, or as one of its listeners takes an event: each saves 180 bytes or
 * more. No name read on every access the rewriter routes is here (`length`,
 * `client`, `getAttribute`).
 */
const POOLED_NAMES = [
	'prototype',
	'addEventListener',
	'addModule',
	'removeAttribute',
	'stopImmediatePropagation',
	'Document',
	'querySelectorAll',
	'Element',
	'HTMLFormElement',
	'postMessage',
	'DOMException',
	'HTMLScriptElement',
	'dispatchEvent',
	'EventTarget',
];
const NAME_CHARACTERS =
	'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const RESERVED_SHORT = new Set(['do', 'if', 'in']);
const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** a source map's mappings as absolute values: per line, its segments */
function decodeMappings(mappings) {
	const state = [0, 0, 0, 0, 0];
	return mappings.split(';').map((line) => {
		state[0] = 0;
		return (line ? line.split(',') : []).map((text) => {
			const segment = [];
			let value = 0;
			let shift = 0;
			for (const character of text) {
				const digit = VLQ.indexOf(character);
				value += (digit & 31) * 2 ** shift;
				if (digit & 32) {
					shift += 5;
					continue;
				}
				const index = segment.length;
				state[index] += value % 2 ? -Math.floor(value / 2) : value / 2;
				segment.push(state[index]);
				value = 0;
				shift = 0;
			}
			return segment;
		});
	});
}

/** decodeMappings's lines as a source map's mappings */
function encodeMappings(lines) {
	const state = [0, 0, 0, 0, 0];
	return lines
		.map((segments) => {
			state[0] = 0;
			return segments
				.map((segment) =>
					segment
						.map((value, index) => {
							const delta = value - state[index];
							state[index] = value;
							let rest = delta < 0 ? -delta * 2 + 1 : delta * 2;
							let text = '';
							do {
								const digit = rest % 32;
								rest = Math.floor(rest / 32);
								text += VLQ[digit + (rest ? 32 : 0)];
							} while (rest);
							return text;
						})
						.join(''),
				)
				.join(',');
		})
		.join(';');
}

/**
 * A minified IIFE bundle's `text` with every `.name` of POOLED_NAMES read
 * as `[v]`, `v` a variable its IIFE declares first that no identifier of
 * the bundle names (so nothing shadows it, and it shadows nothing), and its
 * source map's columns moved with the text
 */
function poolNames(file, text, map) {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const taken = new Set();
	const reads = [];
	const visit = (node) => {
		if (ts.isIdentifier(node)) taken.add(node.text);
		else if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.name) &&
			POOLED_NAMES.includes(node.name.text)
		)
			reads.push(node);
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (!reads.length) return { text, map };
	// the IIFE: the outermost function around every read
	const outermost = (node) => {
		let found = null;
		for (let at = node.parent; at; at = at.parent)
			if (ts.isFunctionLike(at)) found = at;
		return found;
	};
	const iife = outermost(reads[0]);
	if (
		!iife ||
		!(ts.isArrowFunction(iife) || ts.isFunctionExpression(iife)) ||
		!ts.isBlock(iife.body) ||
		reads.some((read) => outermost(read) !== iife)
	)
		throw new Error(`build: ${file} reads ${POOLED_NAMES} outside its IIFE`);
	const free = [];
	for (const first of NAME_CHARACTERS)
		for (const second of ['', ...NAME_CHARACTERS, ...'0123456789']) {
			const name = first + second;
			if (!taken.has(name) && !RESERVED_SHORT.has(name)) free.push(name);
		}
	const variables = new Map(POOLED_NAMES.map((name, at) => [name, free[at]]));
	// after the IIFE's directives
	let declareAt = iife.body.getStart(source) + 1;
	for (const statement of iife.body.statements) {
		if (
			!ts.isExpressionStatement(statement) ||
			!ts.isStringLiteral(statement.expression)
		)
			break;
		declareAt = statement.end;
	}
	const edits = [
		{
			at: declareAt,
			length: 0,
			text: `var ${[...variables].map(([name, variable]) => `${variable}=${JSON.stringify(name)}`).join(',')};`,
		},
	];
	for (const read of reads) {
		const start = read.name.getStart(source);
		const dot = text.lastIndexOf('.', start);
		if (dot < read.expression.end || text.slice(dot + 1, start).trim())
			throw new Error(`build: ${file}: no dot before the name at ${start}`);
		// (`a?.name` keeps its `?.`)
		const from = read.questionDotToken ? dot + 1 : dot;
		edits.push({
			at: from,
			length: read.name.end - from,
			text: `[${variables.get(read.name.text)}]`,
		});
	}
	edits.sort((a, b) => a.at - b.at);
	let out = '';
	let last = 0;
	for (const edit of edits) {
		out += text.slice(last, edit.at) + edit.text;
		last = edit.at + edit.length;
	}
	out += text.slice(last);
	if (map === undefined) return { text: out, map };
	// the edits by line and column, to move the map's generated columns
	const byLine = new Map();
	for (const edit of edits) {
		const { line, character } = source.getLineAndCharacterOfPosition(edit.at);
		if (!byLine.has(line)) byLine.set(line, []);
		byLine.get(line).push({ ...edit, column: character });
	}
	const parsed = JSON.parse(map);
	const lines = decodeMappings(parsed.mappings);
	for (const [line, lineEdits] of byLine) {
		const segments = lines[line] ?? [];
		let next = 0;
		let moved = 0;
		for (const segment of segments) {
			while (
				next < lineEdits.length &&
				lineEdits[next].column + lineEdits[next].length <= segment[0]
			) {
				moved += lineEdits[next].text.length - lineEdits[next].length;
				next++;
			}
			// (one inside a replaced read: at its start)
			segment[0] =
				next < lineEdits.length && lineEdits[next].column < segment[0]
					? lineEdits[next].column + moved
					: segment[0] + moved;
		}
	}
	parsed.mappings = encodeMappings(lines);
	return { text: out, map: JSON.stringify(parsed) };
}

/**
 * A document bundle's build writes its files itself, the script through
 * poolNames (not under the watch, which does not minify)
 *
 * @type {import('esbuild').Plugin}
 */
const pooledNames = {
	name: 'pooled-names',
	setup(pluginBuild) {
		const minified = pluginBuild.initialOptions.minify;
		pluginBuild.onEnd(async (result) => {
			if (result.errors.length || !result.outputFiles) return;
			const maps = new Map(
				result.outputFiles
					.filter((file) => file.path.endsWith('.js.map'))
					.map((file) => [file.path, file.text]),
			);
			for (const file of result.outputFiles) {
				if (file.path.endsWith('.js.map')) continue;
				await mkdir(dirname(file.path), { recursive: true });
				if (!minified || !file.path.endsWith('.js')) {
					await writeFile(file.path, file.contents);
					continue;
				}
				const pooled = poolNames(
					relative(resolve('.'), file.path),
					file.text,
					maps.get(`${file.path}.map`),
				);
				await writeFile(file.path, pooled.text);
				if (pooled.map !== undefined) maps.set(`${file.path}.map`, pooled.map);
			}
			for (const [path, text] of maps) await writeFile(path, text);
		});
	},
};

/** the document bundles, built before the others (`bundles`) */
const DOCUMENT_BUNDLES = ['injectDocument', 'injectDocumentFull'];
/**
 * the workers the controller starts by the hash of their bytes, built after
 * the document bundles and before the bundles that name them
 */
const NAMED_WORKERS = ['transportWorker', 'rewriteWorker'];
/**
 * the scripts of isolation mode's frame and the site pool's, asked for by
 * the hash of their bytes too: built after the workers (whose hashes they
 * carry) and before the controllers that name them
 */
// (the site pool's first: isolation mode's controller host names it)
const NAMED_FRAMES = ['siteFrame', 'controllerFrame'];

// (a document bundle's codec module is a deferred part, src/wasm/codecBytes.ts)
const documentDefine = { 'process.env.STOMP_CODEC_WASM': 'undefined' };

/**
 * A document bundle's first statement: in a window that already holds the
 * client its shell names (src/routeURL.ts BUNDLE_CLIENT, `data-c`: a frame
 * its parent injected before it navigated), the bundle evaluates nothing,
 * as the shell throws away what it would make (takeNamedBase). Evaluated
 * in that realm through the parent's hooks, the bundle's script took a
 * median 1.8 ms of such a frame's start, and 0.2 ms with this (Chrome 157).
 * The test only ever skips: with no client of that name the shell's own
 * check says the bundle did not load. Strict as the bundle is: the
 * directive comes first.
 */
const DOCUMENT_GUARD = {
	banner: {
		js: '"use strict";if(!(()=>{try{return document.currentScript.getAttribute("data-c")in globalThis}catch{}})()){',
	},
	footer: { js: '}' },
};

const builds = [
	{
		entryPoints: { injectDocument: 'src/inject/dom/entry.ts' },
		format: 'iife',
		...DOCUMENT_GUARD,
		alias: stubCrypto,
		inject: [snapshot, domSnapshot],
		write: false,
		plugins: [
			stubSIV,
			stubCodecInstance,
			rewriterLib,
			deferredTable,
			pooledNames,
		],
		define: documentDefine,
	},
	{
		entryPoints: { injectDocumentFull: 'src/inject/dom/entry.ts' },
		format: 'iife',
		...DOCUMENT_GUARD,
		inject: [snapshot, domSnapshot],
		write: false,
		plugins: [stubCodecInstance, rewriterLib, deferredTable, pooledNames],
		define: documentDefine,
	},
	{
		entryPoints: { injectWorker: 'src/inject/worker/entry.ts' },
		format: 'iife',
		alias: stubCrypto,
		inject: [snapshot],
		plugins: [stubSIV, rewriterLib],
	},
	{
		entryPoints: { injectWorkerFull: 'src/inject/worker/entry.ts' },
		format: 'iife',
		inject: [snapshot],
		plugins: [rewriterLib],
	},
	{
		entryPoints: { serviceWorker: 'src/server/serviceWorker.ts' },
		format: 'iife',
		// (its parts: SW_PARTS)
		write: false,
		plugins: [swTldts, swPartsHolder],
	},
	{
		entryPoints: { Controller: 'src/controller/entry.ts' },
		format: 'iife',
	},
	{
		entryPoints: { controllerFrame: 'src/controller/frame.ts' },
		format: 'iife',
	},
	{
		// a slot's agent of the site pool (src/controller/sites.ts), loaded by
		// controllerFrame.html as `?script=siteFrame.js`
		entryPoints: { siteFrame: 'src/controller/site.ts' },
		format: 'iife',
	},
	{
		entryPoints: { controller: 'src/controller/index.ts' },
		format: 'esm',
		outExtension: { '.js': '.mjs' },
	},
	{
		// a classic worker script: the transport modules' emscripten glue
		// (libcurl) recognises a worker by `importScripts`, which a module
		// worker does not have. The transport module itself is loaded with a
		// dynamic import(), which classic workers support.
		entryPoints: { transportWorker: 'src/transport/worker.ts' },
		format: 'iife',
	},
	{
		// the controller's rewrite workers (src/controller/rewriteWorkers.ts)
		entryPoints: { rewriteWorker: 'src/rewriteWorker.ts' },
		format: 'iife',
	},
	{
		// a document's WebRTC worker (src/rtc/worker.ts, docs/webrtc-over-wisp.md)
		entryPoints: { rtcWorker: 'src/rtc/worker.ts' },
		format: 'iife',
	},
	{
		// what a document's WebRTC classes do (src/inject/dom/rtcStack.ts),
		// which the inject's WebRTC module evaluates the first time a document
		// uses them: the file declares one function, called with the object it
		// hands the library out in (`__stompRtcOut`) and the bundle's globals
		// (src/inject/dom/rtcStackGlobals.ts); what its syntax iterates is
		// handed to the bundle's ownIterable, the library running after the
		// page's scripts
		entryPoints: { rtcStack: 'src/inject/dom/rtcStackEntry.ts' },
		format: 'iife',
		banner: {
			js: 'const __stompRtcLibrary=function(__stompRtcSnap,__stompRtcOut){',
		},
		footer: { js: 'return __stompRtcOut;};' },
		inject: [rtcStackGlobals],
		plugins: [
			withOwnIterable,
			ownIterationPlugin([rtcStackGlobals], true, true),
		],
	},
	{
		// the extensions' runtime (docs/extensions.md): loaded by a document
		// an installed extension reaches, before its inject bundle, so it
		// captures the natives it talks over unhooked
		entryPoints: { extensionsRuntime: 'src/extensions/runtime/entry.ts' },
		format: 'iife',
		plugins: [extensionsWorld],
	},
	{
		entryPoints: { SearchBuilder: 'src/bootstrapper/entry.ts' },
		format: 'iife',
	},
	{
		// the host's omnibox (src/omnibox/), a classic script whose global is
		// `Omnibox` (init.assets.omnibox), and the same as a module for a
		// host's bundler (`@sysce/stomp/omnibox`); no proxied page loads either
		entryPoints: { omnibox: 'src/omnibox/entry.ts' },
		format: 'iife',
	},
	{
		entryPoints: { omnibox: 'src/omnibox/index.ts' },
		format: 'esm',
		outExtension: { '.js': '.mjs' },
	},
];

/**
 * Every bundle but the rewriter library, which is built first: the inject
 * bundles and the controllers ask for that file by the hash of its bytes
 * (`STOMP_LIBRARY`, src/version.ts LIBRARY), so the URL of another
 * build's file is another URL and a host can let browsers keep it for
 * good. The watch build has no bytes to hash before it starts: its files
 * are asked for by the time it started, and the dev server caches nothing.
 * `documents` and `files` are the hashes of the document bundles and of
 * the files the controller starts (NAMED_WORKERS, the blocker's module), by
 * name: empty until those are built, and in the watch build.
 */
const bundles = (
	library,
	generation = '',
	core = library,
	documents = {},
	files = {},
) =>
	builds.map((options) => ({
		...common,
		...options,
		define: {
			...common.define,
			'process.env.STOMP_LIBRARY': JSON.stringify(library),
			'process.env.STOMP_CORE': JSON.stringify(core),
			'process.env.STOMP_DOCUMENT': JSON.stringify(
				documents.injectDocument ?? '',
			),
			'process.env.STOMP_DOCUMENT_FULL': JSON.stringify(
				documents.injectDocumentFull ?? '',
			),
			'process.env.STOMP_TRANSPORT_WORKER': JSON.stringify(
				files.transportWorker ?? '',
			),
			'process.env.STOMP_REWRITE_WORKER': JSON.stringify(
				files.rewriteWorker ?? '',
			),
			'process.env.STOMP_BLOCKER': JSON.stringify(files.blocker ?? ''),
			'process.env.STOMP_CONTROLLER_FRAME': JSON.stringify(
				files.controllerFrameHtml ?? '',
			),
			'process.env.STOMP_CONTROLLER_FRAME_SCRIPT': JSON.stringify(
				files.controllerFrame ?? '',
			),
			'process.env.STOMP_SITE_FRAME_SCRIPT': JSON.stringify(
				files.siteFrame ?? '',
			),
			'process.env.STOMP_REWRITE_GENERATION': JSON.stringify(generation),
			...(options.inject?.includes(snapshot) ? reflectDefines : {}),
			...options.define,
		},
		plugins: [
			noSourceMaps,
			...(options.plugins ?? []),
			...(options.inject?.includes(snapshot)
				? [idbPure, withOwnIterable, ownIteration]
				: []),
		],
	}));

await rimraf('dist');
await mkdir('dist', { recursive: true });
// the controller frame document is static; the deployer may edit its
// allowed-origins meta tag
const FRAME_HTML = 'src/controller/controllerFrame.html';
await copyFile(FRAME_HTML, 'dist/controllerFrame.html');
// the wasm artifacts are built elsewhere (deploy/rust/build.sh, in a
// container) and committed under assets/, as are the blocker's resources
// (scripts/adblock-resources.mjs, from a uBlock Origin release) and its
// engine snapshot (scripts/adblock-snapshot.mjs): the build
// copies them, so a checkout with no Rust toolchain (CI, the deploy) ships
// the same bytes
const ASSETS = 'assets';
async function copyAssets() {
	const copied = [];
	for (const name of await readdir(ASSETS))
		if (/\.(wasm|js|json|gz)$/.test(name)) {
			await copyFile(`${ASSETS}/${name}`, `dist/${name}`);
			copied.push(`dist/${name}`);
		}
	return copied;
}
await copyAssets();
await writeFile(
	'dist/build.json',
	`${JSON.stringify(buildInfo(), null, '\t')}\n`,
);
// the desktop the demo can switch to, when its submodule is checked out
// (scripts/vibeos.mjs); the log says when it is left out
await buildVibeOS();

/**
 * Tell the dev server what a build produced. The server may be down or
 * restarting (node --watch on demo/server.js), so failures are ignored: the
 * page reloads on reconnect anyway when the server comes back.
 */
async function notify(outputs, errors = []) {
	const body = {
		outputs,
		errors: errors.length,
		messages: errors.length
			? await formatMessages(errors, { kind: 'error', color: false })
			: [],
	};
	try {
		await fetch(`http://127.0.0.1:${devPort}/__dev/changed`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(2000),
		});
	} catch {
		// no dev server listening; nothing to tell
	}
}

/** @type {import('esbuild').Plugin} */
const reporter = {
	name: 'dev-reporter',
	setup(pluginBuild) {
		pluginBuild.onEnd((result) => {
			const outputs = Object.keys(result.metafile?.outputs || {});
			// an errored build has no outputs; name the bundle's entry so the page
			// knows which one is broken
			if (!outputs.length)
				for (const name of Object.keys(pluginBuild.initialOptions.entryPoints))
					outputs.push(`dist/${name}.js`);
			notify(outputs, result.errors);
		});
	},
};

if (dev) {
	// the file is the four statements: each rebuild of one writes it with the
	// others' last output. The parts are built once first, so the document
	// bundles know what they read (a part that imports a new name of the
	// bundle's needs a restart of the watch)
	// (the parts' groups are the ones the watch started with: a part that
	// joins or splits a group needs a restart too)
	const groups = await partGroups();
	const latest = {
		light: null,
		parts: groups.map((group) => group.output),
		passkeys: await build(passkeysPart).then(outputOf),
		activation: await build(activationPart).then(outputOf),
	};
	const written = (key, index) => ({
		name: 'rewriter-lib-file',
		setup(pluginBuild) {
			pluginBuild.onEnd(async (result) => {
				if (result.errors.length || !result.outputFiles) return;
				if (index === undefined) latest[key] = outputOf(result);
				else latest[key][index] = outputOf(result);
				if (latest.light && latest.passkeys && latest.activation)
					await writeLibrary(
						latest.light,
						partsStatement(groups, latest.parts),
						latest.passkeys,
						latest.activation,
					);
			});
		},
	});
	const contexts = await Promise.all(
		[
			{
				...rewriterLibrary,
				plugins: [...rewriterLibrary.plugins, written('light')],
			},
			...groups.map((group, index) => ({
				...group.options,
				plugins: [...group.options.plugins, written('parts', index)],
			})),
			{
				...passkeysPart,
				plugins: [...passkeysPart.plugins, written('passkeys')],
			},
			{
				...activationPart,
				plugins: [...activationPart.plugins, written('activation')],
			},
			...bundles(`dev${Date.now().toString(36)}`),
		].map((options) =>
			context({
				...options,
				metafile: true,
				plugins: [...(options.plugins ?? []), reporter],
			}),
		),
	);
	await Promise.all(contexts.map((ctx) => ctx.watch()));
	// esbuild only watches what it bundles; the copied document is ours
	watch(FRAME_HTML, async () => {
		await copyFile(FRAME_HTML, 'dist/controllerFrame.html');
		notify(['dist/controllerFrame.html']);
	});
	watch(ASSETS, async () => notify(await copyAssets()));
	console.log('Watching for changes...');
} else {
	const [light, parts, passkeys, activation] = await Promise.all([
		build(rewriterLibrary).then(outputOf),
		partGroups().then((groups) => partsStatement(groups)),
		build(passkeysPart).then(outputOf),
		build(activationPart).then(outputOf),
	]);
	await writeLibrary(light, parts, passkeys, activation);
	const library = createHash('sha256')
		.update(await readFile('dist/rewriterLib.js'))
		.digest('hex')
		.slice(0, 16);
	// the rewriter's generation (src/version.ts REWRITE_GENERATION): everything
	// a rewrite's output depends on that is not already in the cache key per
	// entry (the URL, the script type, the config, the codec key, the
	// partition). That is the rewriter itself: the wasm core, the codec module
	// whose sealing the output carries, and the light rewriter library (its
	// statement as built, not the deferred parts after it in the file). A
	// deploy that changes none of these keeps the same generation, so a
	// revisit after it is answered from the rewrite cache; one that changes any
	// of them gets a new generation, and the last build's output is never
	// served under it.
	const generation = createHash('sha256')
		.update(await readFile('assets/core.wasm'))
		.update(await readFile('assets/codec.wasm'))
		.update(light.raw)
		.digest('hex')
		.slice(0, 16);
	// what the wasm core module is asked for by (src/version.ts CORE), as the
	// library is by its bytes' hash
	const core = createHash('sha256')
		.update(await readFile('assets/core.wasm'))
		.digest('hex')
		.slice(0, 16);
	const run = async (options) => {
		const result = await build(options);
		if (options.plugins.includes(deferredTable))
			checkDeferred(result.metafile, Object.keys(options.entryPoints)[0]);
	};
	// the document bundles first: the bundles that name them (the service
	// worker's shells, the controller's warm fetch) ask for each by the hash
	// of its bytes (src/version.ts DOCUMENT), and a document bundle names the
	// file it was loaded from (src/routeURL.ts ownDocumentBundle)
	const isDocument = (options) =>
		DOCUMENT_BUNDLES.includes(Object.keys(options.entryPoints)[0]);
	await Promise.all(
		bundles(library, generation, core).filter(isDocument).map(run),
	);
	const hashOf = async (path) =>
		createHash('sha256')
			.update(await readFile(path))
			.digest('hex')
			.slice(0, 16);
	const documents = {};
	for (const name of DOCUMENT_BUNDLES)
		documents[name] = await hashOf(`dist/${name}.js`);
	// then the workers the controller starts, which it asks for by the hash
	// of each file as built (src/version.ts TRANSPORT_WORKER, REWRITE_WORKER),
	// and the blocker's module by its bytes' (BLOCKER): a reload of the host
	// finds them in the HTTP cache instead of revalidating each one before
	// the transport can start
	const isNamedWorker = (options) =>
		NAMED_WORKERS.includes(Object.keys(options.entryPoints)[0]);
	await Promise.all(
		bundles(library, generation, core, documents)
			.filter(isNamedWorker)
			.map(run),
	);
	const files = { blocker: await hashOf('dist/blocker.wasm') };
	for (const name of NAMED_WORKERS)
		files[name] = await hashOf(`dist/${name}.js`);
	// then the site pool's frame script and isolation mode's, whose
	// controller host names the site pool's, and the frame document as
	// copied, named so by the controllers
	const isNamedFrame = (options) =>
		NAMED_FRAMES.includes(Object.keys(options.entryPoints)[0]);
	for (const name of NAMED_FRAMES) {
		await Promise.all(
			bundles(library, generation, core, documents, files)
				.filter((options) => Object.keys(options.entryPoints)[0] === name)
				.map(run),
		);
		files[name] = await hashOf(`dist/${name}.js`);
	}
	files.controllerFrameHtml = await hashOf('dist/controllerFrame.html');
	await Promise.all(
		bundles(library, generation, core, documents, files)
			.filter(
				(options) =>
					!isDocument(options) &&
					!isNamedWorker(options) &&
					!isNamedFrame(options),
			)
			.map(run),
	);
	checkInputs();
	await checkMemberNames();
}
