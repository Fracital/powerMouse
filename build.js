import { watch } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, context, formatMessages } from 'esbuild';
import { rimraf } from 'rimraf';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const dev = process.argv.includes('--dev');
// where `npm run dev`'s demo server listens; each finished rebuild is reported
// to it so the page can reload what changed (demo/public/pm/dev.js)
const devPort = parseInt(process.env.PORT || '') || 8080;

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
		'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
	},
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
	},
	{
		entryPoints: { injectWorker: 'src/inject/worker/entry.ts' },
		format: 'iife',
		inject: [snapshot],
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
		entryPoints: { SearchBuilder: 'src/bootstrapper/entry.ts' },
		format: 'iife',
	},
].map((options) => ({ ...common, ...options }));

await rimraf('dist');
await mkdir('dist', { recursive: true });
// the controller frame document is static; the deployer may edit its
// allowed-origins meta tag
const FRAME_HTML = 'src/controller/controllerFrame.html';
await copyFile(FRAME_HTML, 'dist/controllerFrame.html');

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
		builds.map((options) =>
			context({ ...options, metafile: true, plugins: [reporter] }),
		),
	);
	await Promise.all(contexts.map((ctx) => ctx.watch()));
	// esbuild only watches what it bundles; the copied document is ours
	watch(FRAME_HTML, async () => {
		await copyFile(FRAME_HTML, 'dist/controllerFrame.html');
		notify(['dist/controllerFrame.html']);
	});
	console.log('Watching for changes...');
} else {
	await Promise.all(builds.map((options) => build(options)));
}
