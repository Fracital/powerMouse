import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
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
/** the light library's text (`worker`: a worker's), built on its own */
async function lightLibrary(worker, define) {
	const result = await build({
		...common,
		define,
		entryPoints: [
			worker ? 'src/rewriterLightWorker.ts' : 'src/rewriterLightDocument.ts',
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
				const { text, inputs } = await lightLibrary(worker, {
					...pluginBuild.initialOptions.define,
					'process.env.STOMP_CODEC_WASM': 'undefined',
				});
				return {
					contents: `export default function rewriterLib(__stompRealm) {\n${text}\nreturn __stompLib.api;\n}\n`,
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
 * carries it (a frame uses its top's and evaluates none). The file is one
 * statement that assigns the factory to a name (src/version.ts LIGHT_FACTORY),
 * and is read two ways. A proxied top's shell loads it as a script before the
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
	entryPoints: { rewriterLib: 'src/rewriterLightDocument.ts' },
	format: 'iife',
	globalName: '__stompLib',
	inject: [resolve('src/libGlobals.ts')],
	banner: { js: `${LIGHT_FACTORY}=function(__stompRealm){` },
	footer: { js: 'return __stompLib.api;};' },
	plugins: [noSourceMaps],
};

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
		plugins: [rewriterLib],
	},
	{
		entryPoints: { injectDocumentFull: 'src/inject/dom/entry.ts' },
		format: 'iife',
		inject: [snapshot, domSnapshot],
		plugins: [rewriterLib],
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
		// uses them: the file is one function's body, `__stompRtc` a name of
		// that function's, and its globals are the bundle's
		// (src/inject/dom/rtcStackGlobals.ts)
		entryPoints: { rtcStack: 'src/inject/dom/rtcStackEntry.ts' },
		format: 'iife',
		globalName: '__stompRtc',
		inject: [resolve('src/inject/dom/rtcStackGlobals.ts')],
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
		},
		plugins: [noSourceMaps, ...(options.plugins ?? [])],
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
	// the rewriter's generation (src/version.ts REWRITE_GENERATION): everything
	// a rewrite's output depends on that is not already in the cache key per
	// entry (the URL, the script type, the config, the codec key, the
	// partition). That is the rewriter itself: the wasm core, the codec module
	// whose sealing the output carries, and the light rewriter library. A
	// deploy that changes none of these keeps the same generation, so a
	// revisit after it is answered from the rewrite cache; one that changes any
	// of them gets a new generation, and the last build's output is never
	// served under it.
	const generation = createHash('sha256')
		.update(await readFile('assets/core.wasm'))
		.update(await readFile('assets/codec.wasm'))
		.update(await readFile('dist/rewriterLib.js'))
		.digest('hex')
		.slice(0, 16);
	await Promise.all(
		bundles(library, generation).map((options) => build(options)),
	);
}
