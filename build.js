import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, context } from 'esbuild';
import { rimraf } from 'rimraf';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const dev = process.argv.includes('--dev');

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
await copyFile(
	'src/controller/controllerFrame.html',
	'dist/controllerFrame.html',
);

if (dev) {
	const contexts = await Promise.all(builds.map((options) => context(options)));
	await Promise.all(contexts.map((ctx) => ctx.watch()));
	console.log('Watching for changes...');
} else {
	await Promise.all(builds.map((options) => build(options)));
}
