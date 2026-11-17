import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { build, context, formatMessages } from 'esbuild';
import { rimraf } from 'rimraf';
import ts from 'typescript';
import { ownIterationPlugin } from './scripts/ownIteration.mjs';
import { ownMethodsFrom, ownMethodsSource } from './scripts/ownMethods.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const dev = process.argv.includes('--dev');
// where `npm run dev`'s demo server listens; each finished rebuild is reported
// to it so the page can reload what changed (demo/public/pm/dev.js)
const devPort = parseInt(process.env.PORT || '') || 8080;

function buildId() {
	try {
		const sha = execSync('git rev-parse --short HEAD', {
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.toString()
			.trim();
		if (sha) return `${pkg.version}+${sha}`;
	} catch {
		// not a git checkout (an npm tarball, a stage dir without .git)
	}
	return `${pkg.version}+${Date.now().toString(36)}`;
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

/** @type {import('esbuild').BuildOptions} */
const common = {
	platform: 'browser',
	target: 'es2022',
	bundle: true,
	sourcemap: true,
	minify: !dev,
	legalComments: 'none',
	logLevel: 'info',
	outdir: 'dist',
	define: {
		'process.env.STOMP_VERSION': JSON.stringify(pkg.version),
		// build id for the version pin between the service worker, the inject
		// bundles and the controller: the version plus the commit, or the time
		// when this is not a git checkout
		'process.env.STOMP_BUILD': JSON.stringify(buildId()),
		'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
		// what the rewriter library asset is asked for by: known once that
		// file is built (see `bundles` below)
		'process.env.STOMP_LIBRARY': '""',
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
			contents: `"use strict";\nimport { api } from ${JSON.stringify(resolve(file))};\n__stompLibApi = api;\n`,
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
	banner: { js: `${LIGHT_FACTORY}=function(__stompRealm,__stompLibApi){` },
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
 * document bundle carries. They are the last statement of the rewriter
 * library's file, `__stompDeferred=function(__stompShared){...};`
 * (src/version.ts DEFERRED_FACTORY), after the light library's: a proxied
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
		'src/inject/cookieStoreMethods.ts',
		'src/inject/dom/ancestorOriginsList.ts',
		'src/inject/dom/attributeViewMethods.ts',
		'src/inject/dom/beaconRelay.ts',
		'src/inject/dom/deferredParts.ts',
		'src/inject/dom/legacyEncoding.ts',
		'src/inject/dom/markupMembers.ts',
		'src/inject/dom/openerFacts.ts',
		'src/inject/dom/modules/Fingerprint.ts',
		'src/inject/dom/modules/serviceWorkerEmulation.ts',
		'src/inject/dom/passkeys.ts',
		'src/inject/dom/passkeysPart.ts',
		'src/inject/dom/sourcePolicy.ts',
		'src/inject/idbSize.ts',
		'src/passkeys/types.ts',
		'src/inject/serviceWorkerObjects.ts',
		'src/inject/webTransport.ts',
		'src/inject/webTransportStandIn.ts',
		'src/inject/xhrChecks.ts',
	].map((file) => resolve(file)),
);
const DEFERRED_ENTRY = 'src/inject/dom/deferredParts.ts';
/** what the parts read of the bundle: by file (from the root), the names */
const deferredShared = new Map();
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
			return {
				path: `${found.path}?${names.join(',')}`,
				namespace: SHARED,
				pluginData: { id, names },
			};
		});
		pluginBuild.onLoad({ filter: /.*/, namespace: SHARED }, (args) => {
			const { id, names } = args.pluginData;
			const values = names.map(
				(name, index) => `v${index} = m[${JSON.stringify(name)}]`,
			);
			return {
				contents: `const m = __stompShared[${JSON.stringify(id)}];\n${
					values.length ? `const ${values.join(', ')};\n` : ''
				}export { ${names.map((name, index) => `v${index} as ${name}`).join(', ')} };\n`,
				loader: 'js',
			};
		});
	},
};

/** @type {import('esbuild').BuildOptions} */
const deferredParts = {
	...common,
	define: { ...common.define, ...reflectDefines },
	entryPoints: { deferredParts: DEFERRED_ENTRY },
	format: 'iife',
	inject: [snapshot, domSnapshot],
	// (src/inject/dom/deferredParts.ts sets `made`)
	banner: {
		js: `${DEFERRED_FACTORY}=function(__stompShared){"use strict";var __stompParts={};`,
	},
	footer: { js: 'return __stompParts.made;};' },
	plugins: [
		noSourceMaps,
		deferredSharing,
		withOwnIterable,
		ownIterationPlugin([snapshot, domSnapshot, ownIterableFile], true, true),
	],
	write: false,
	metafile: true,
};

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
	...deferredParts,
	entryPoints: { passkeysPart: 'src/inject/dom/passkeysPart.ts' },
	banner: {
		js: `${PASSKEYS_FACTORY}=function(__stompShared){"use strict";var __stompParts={};`,
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
			[...deferredShared].forEach(([id, names], index) => {
				const list = [...names];
				if (!list.length) return;
				imports += `import { ${list.map((name, at) => `${name} as s${index}_${at}`).join(', ')} } from ${JSON.stringify(resolve(id))};\n`;
				entries.push(
					`${JSON.stringify(id)}: { ${list.map((name, at) => `${JSON.stringify(name)}: s${index}_${at}`).join(', ')} }`,
				);
			});
			return {
				contents: `${imports}export default () => ({ ${entries.join(', ')} });\n`,
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
 * parts', then the passkey provider's client's, each after a line break
 * (src/inject/rewriter.ts fileStatements), with one map of all (a sectioned
 * source map)
 */
async function writeLibrary(light, parts, passkeys) {
	for (const name of [DEFERRED_FACTORY, PASSKEYS_FACTORY])
		for (const statement of [light, parts, passkeys])
			if (statement.text.includes(`\n${name}=`))
				throw new Error(
					`rewriterLib: a line of the file starts with the name ${name}`,
				);
	const ended = (text) => (text.endsWith('\n') ? text : `${text}\n`);
	let text = '';
	const sections = [];
	for (const statement of [light, parts, passkeys]) {
		if (statement.map)
			sections.push({
				offset: { line: text.split('\n').length - 1, column: 0 },
				map: statement.map,
			});
		text += ended(statement.text);
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
// the aes and base64 codecs (src/Codecs.ts, its four default imports) and the
// common deployment runs the xor codec. Those two codecs load injectDocumentFull
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

const builds = [
	{
		entryPoints: { injectDocument: 'src/inject/dom/entry.ts' },
		format: 'iife',
		alias: stubCrypto,
		inject: [snapshot, domSnapshot],
		plugins: [rewriterLib, deferredTable],
	},
	{
		entryPoints: { injectDocumentFull: 'src/inject/dom/entry.ts' },
		format: 'iife',
		inject: [snapshot, domSnapshot],
		plugins: [rewriterLib, deferredTable],
	},
	{
		entryPoints: { injectWorker: 'src/inject/worker/entry.ts' },
		format: 'iife',
		alias: stubCrypto,
		inject: [snapshot],
		plugins: [rewriterLib],
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
		// uses them: the file is one function's body, which hands the library
		// out in `__stompRtcOut`, an object that function is given; its globals
		// are the bundle's (src/inject/dom/rtcStackGlobals.ts), and what its
		// syntax iterates is handed to the bundle's ownIterable, the library
		// running after the page's scripts
		entryPoints: { rtcStack: 'src/inject/dom/rtcStackEntry.ts' },
		format: 'iife',
		inject: [rtcStackGlobals],
		plugins: [
			withOwnIterable,
			ownIterationPlugin([rtcStackGlobals], true, true),
		],
	},
	{
		entryPoints: { SearchBuilder: 'src/bootstrapper/entry.ts' },
		format: 'iife',
	},
];

/**
 * Every bundle but the rewriter library, which is built first: the inject
 * bundles and the controllers ask for that file by the hash of its bytes
 * (`STOMP_LIBRARY`, src/version.ts LIBRARY), so the URL of another
 * build's file is another URL and a host can let browsers keep it for
 * good. The watch build has no bytes to hash before it starts: its files
 * are asked for by the time it started, and the dev server caches nothing.
 */
const bundles = (library, generation = '') =>
	builds.map((options) => ({
		...common,
		...options,
		define: {
			...common.define,
			'process.env.STOMP_LIBRARY': JSON.stringify(library),
			'process.env.STOMP_REWRITE_GENERATION': JSON.stringify(generation),
			...(options.inject?.includes(snapshot) ? reflectDefines : {}),
		},
		plugins: [
			noSourceMaps,
			...(options.plugins ?? []),
			...(options.inject?.includes(snapshot)
				? [withOwnIterable, ownIteration]
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
// container) and committed under assets/: the build copies them, so a
// checkout with no Rust toolchain (CI, the deploy) ships the same bytes
const ASSETS = 'assets';
async function copyAssets() {
	const copied = [];
	for (const name of await readdir(ASSETS))
		if (name.endsWith('.wasm') || name.endsWith('.js')) {
			await copyFile(`${ASSETS}/${name}`, `dist/${name}`);
			copied.push(`dist/${name}`);
		}
	return copied;
}
await copyAssets();

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
	// the file is the three statements: each rebuild of one writes it with the
	// others' last output. The parts are built once first, so the document
	// bundles know what they read (a part that imports a new name of the
	// bundle's needs a restart of the watch)
	const latest = {
		light: null,
		parts: await build(deferredParts).then(outputOf),
		passkeys: await build(passkeysPart).then(outputOf),
	};
	const written = (key) => ({
		name: 'rewriter-lib-file',
		setup(pluginBuild) {
			pluginBuild.onEnd(async (result) => {
				if (result.errors.length || !result.outputFiles) return;
				latest[key] = outputOf(result);
				if (latest.light && latest.parts && latest.passkeys)
					await writeLibrary(latest.light, latest.parts, latest.passkeys);
			});
		},
	});
	const contexts = await Promise.all(
		[
			{
				...rewriterLibrary,
				plugins: [...rewriterLibrary.plugins, written('light')],
			},
			{
				...deferredParts,
				plugins: [...deferredParts.plugins, written('parts')],
			},
			{
				...passkeysPart,
				plugins: [...passkeysPart.plugins, written('passkeys')],
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
	const [light, parts, passkeys] = await Promise.all([
		build(rewriterLibrary).then(outputOf),
		build(deferredParts).then(outputOf),
		build(passkeysPart).then(outputOf),
	]);
	await writeLibrary(light, parts, passkeys);
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
	await Promise.all(
		bundles(library, generation).map(async (options) => {
			const result = await build({
				...options,
				metafile: options.plugins.includes(deferredTable) || options.metafile,
			});
			if (options.plugins.includes(deferredTable))
				checkDeferred(result.metafile, Object.keys(options.entryPoints)[0]);
		}),
	);
}
