import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, context, formatMessages } from 'esbuild';
import { rimraf } from 'rimraf';

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
const domSnapshot = resolve('src/inject/dom/snapshot.ts');

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
	},
};

/**
 * `source-map` (escodegen) and `source-map-js` (css-tree's generator) are
 * loaded only to print source maps, which the rewriters never ask for:
 * every bundle that holds a rewriter gets src/noSourceMaps.ts instead.
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
 * meriyah builds a 272 KB table of the Unicode identifier characters when it
 * loads (a Uint32Array outside the heap), which it reads only for a
 * character past ASCII where an identifier may start or go on. Every realm
 * that holds the rewriter (the service worker, each rewrite worker, a top's
 * rewriter realm, a sandboxed frame's own copy) paid it whether or not a
 * script it rewrote had one. The table is built the first time it is read.
 * A meriyah whose source no longer has the shape this expects fails the
 * build, so an upgrade has to look at it.
 *
 * @type {import('esbuild').Plugin}
 */
const lazyUnicodeTable = {
	name: 'lazy-unicode-table',
	setup(pluginBuild) {
		pluginBuild.onLoad(
			{ filter: /[\\/]meriyah[\\/]dist[\\/]meriyah\.mjs$/ },
			async (args) => {
				let source = await readFile(args.path, 'utf8');
				const edits = [
					[
						'const unicodeLookup = ((compressed, lookup) => {',
						'let unicodeLookup;\nconst buildUnicodeLookup = () => ((compressed, lookup) => {',
					],
					[
						'const isIDContinue = (code) => (unicodeLookup[',
						'const isIDContinue = (code) => ((unicodeLookup ??= buildUnicodeLookup())[',
					],
					[
						'const isIDStart = (code) => (unicodeLookup[',
						'const isIDStart = (code) => ((unicodeLookup ??= buildUnicodeLookup())[',
					],
				];
				for (const [from, to] of edits) {
					if (source.split(from).length !== 2)
						throw new Error(
							`lazy-unicode-table: meriyah no longer has \`${from}\` once; see build.js`,
						);
					source = source.replace(from, to);
				}
				if (source.split('unicodeLookup[').length !== 1)
					throw new Error(
						'lazy-unicode-table: meriyah reads its table somewhere else too; see build.js',
					);
				return { contents: source, loader: 'js' };
			},
		);
	},
};

/**
 * The light rewriter library (src/rewriterLight.ts: the wasm rewriter's
 * glue and, until their modules answer in the page, css-tree and tldts)
 * for the inject bundles, which import it as `stomp:rewriter-lib`: bundled
 * on its own and handed over as a function that evaluates it, so a frame
 * evaluates none of it until it rewrites something, and a top can evaluate
 * the same text in a realm of its own for the frames under it
 * (src/inject/rewriter.ts). Its globals come from src/libGlobals.ts, which
 * also names every global the inject bundles inject: the text names nothing
 * of the bundle it is carried in. The parsers and the printer are not in
 * it: they are the rewriter library below, a file of its own.
 *
 * @type {import('esbuild').Plugin}
 */
const rewriterLib = {
	name: 'rewriter-lib',
	setup(pluginBuild) {
		// a worker's has no stylesheets and no suffix list
		const worker = 'injectWorker' in pluginBuild.initialOptions.entryPoints;
		pluginBuild.onResolve({ filter: /^stomp:rewriter-lib$/ }, (args) => ({
			path: args.path,
			namespace: 'rewriter-lib',
		}));
		pluginBuild.onLoad(
			{ filter: /.*/, namespace: 'rewriter-lib' },
			async () => {
				const result = await build({
					...common,
					define: pluginBuild.initialOptions.define,
					entryPoints: [
						worker
							? 'src/rewriterLightWorker.ts'
							: 'src/rewriterLightDocument.ts',
					],
					format: 'iife',
					globalName: '__stompLib',
					inject: [resolve('src/libGlobals.ts')],
					plugins: [noSourceMaps],
					sourcemap: false,
					write: false,
					metafile: true,
					logLevel: 'silent',
				});
				const text = result.outputFiles[0].text;
				return {
					contents: `export default function rewriterLib(__stompRealm) {\n${text}\nreturn __stompLib.api;\n}\n`,
					loader: 'js',
					watchFiles: Object.keys(result.metafile.inputs).map((input) =>
						resolve(input),
					),
				};
			},
		);
	},
};

/**
 * The rewriter library (src/rewriterLib.ts: meriyah, escodegen, css-tree,
 * tldts and the rewriters on them), the asset `rewriterLib`: no bundle
 * carries it. The file is one statement that assigns the library's factory
 * to a name (src/version.ts LIBRARY_FACTORY), and is read two ways. With
 * `rewriter: 'js'` a proxied top's shell loads it as a script before the
 * inject bundle, which takes the factory and removes the name
 * (src/rewriteHTML.ts, src/inject/rewriter.ts). Anywhere else a copy of
 * the light library is handed its text the first time a call needs it
 * (src/inject/rewriter.ts loads it, synchronously) and evaluates it in its
 * own realm as the body of a function that has the name as a parameter,
 * which writes no global. A statement survives a host's minifier, which
 * drops a function expression nobody uses. One file for documents and
 * workers; a worker never calls the parts it has no use for.
 *
 * @type {import('esbuild').BuildOptions}
 */
const rewriterLibrary = {
	...common,
	entryPoints: { rewriterLib: 'src/rewriterLibDocument.ts' },
	format: 'iife',
	globalName: '__stompLib',
	inject: [resolve('src/libGlobals.ts')],
	banner: { js: '__stompRewriterLib=function(__stompRealm){' },
	footer: { js: 'return __stompLib.api;};' },
	plugins: [noSourceMaps, lazyUnicodeTable],
};

/**
 * Bundles that expose a classic-script global do so through an entry shim
 * (`Reflect.defineProperty(globalThis, ...)`) rather than esbuild's
 * `globalName`, because `globalName` emits a top-level `var` that cannot be
 * deleted, and the inject bundles delete `createClient` once consumed.
 *
 * @type {import('esbuild').BuildOptions[]}
 */
const builds = [
	{
		entryPoints: { injectDocument: 'src/inject/dom/entry.ts' },
		format: 'iife',
		inject: [snapshot, domSnapshot],
		plugins: [rewriterLib],
	},
	{
		entryPoints: { injectWorker: 'src/inject/worker/entry.ts' },
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
const bundles = (library) =>
	builds.map((options) => ({
		...common,
		...options,
		define: {
			...common.define,
			'process.env.STOMP_LIBRARY': JSON.stringify(library),
		},
		plugins: [noSourceMaps, lazyUnicodeTable, ...(options.plugins ?? [])],
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
	const contexts = await Promise.all(
		[rewriterLibrary, ...bundles(`dev${Date.now().toString(36)}`)].map(
			(options) =>
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
	await build(rewriterLibrary);
	const library = createHash('sha256')
		.update(await readFile('dist/rewriterLib.js'))
		.digest('hex')
		.slice(0, 16);
	await Promise.all(bundles(library).map((options) => build(options)));
}
