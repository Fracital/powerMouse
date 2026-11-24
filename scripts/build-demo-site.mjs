#!/usr/bin/env node
// The public demo's site, protected (`npm run build:demo-site`): everything
// demo/server.js serves from files, copied into one directory and run
// through estrogen (@sysce/estrogen, the post-build obfuscator), then held
// to the leak gate (scripts/demo-leak-gate.mjs). The server serves it in
// place of the checkout's files when STOMP_DEMO_SITE names it.
//
// Only the demo. dist/ and the published package stay as they are: the
// hosts that embed powerMouse run their own obfuscator on their own output.
// offline.html is such a build too (the demo and STomp in one file, saved
// and run elsewhere), and is not part of this site.
//
// The site's roots, each as the server mounts it:
//   public/    demo/public (the page, its scripts, controllerFrame's host
//              page, Tor mode's client modules)
//   runtime/   dist/, without its source maps and type declarations (the
//              service worker, the inject bundles, the controller), served at
//              every service-worker scope
//   transport/, fallback/  the transports' dist directories
//   tor/       tor-js's package (Tor mode's client and arti's wasm)
//   examples/  the embedding examples
//
// Usage: node scripts/build-demo-site.mjs [--out <dir>] [--skip-gate]
//        [--plant <text>]
// --plant writes <text> into a served file after estrogen ran, to show the
// gate fails the build on a leak.
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? null : args[at + 1];
};
const out = resolve(option('--out') ?? join(root, 'build/demo-site'));
const plant = option('--plant');

const dist = join(root, 'dist');
if (!existsSync(join(dist, 'serviceWorker.js'))) {
	console.error('build-demo-site: no dist/serviceWorker.js; run npm run build');
	process.exit(1);
}
const packageDir = (specifier, up = 1) => {
	let dir = dirname(fileURLToPath(import.meta.resolve(specifier)));
	for (let i = 0; i < up; i++) dir = dirname(dir);
	return dir;
};
const roots = {
	public: join(root, 'demo/public'),
	runtime: dist,
	transport: packageDir('@mercuryworkshop/epoxy-transport', 0),
	fallback: packageDir('@mercuryworkshop/libcurl-transport', 0),
	tor: packageDir('tor-js', 2),
	examples: join(root, 'examples'),
};
/** what of a root the page loads: no source map or type declaration */
const served = (name) => (path) => {
	const inside = relative(roots[name], path);
	if (/\.map$|\.d\.ts$/.test(inside)) return false;
	return name !== 'runtime' || !/^types(\/|$)/.test(inside);
};

// (the copy before estrogen stays beside it, as <out>.native: the gate holds
// each script against it, and a rebuild starts from it)
const native = `${out}.native`;
rmSync(out, { recursive: true, force: true });
rmSync(native, { recursive: true, force: true });
mkdirSync(native, { recursive: true });
for (const [name, from] of Object.entries(roots)) {
	if (!existsSync(from)) {
		console.error(`build-demo-site: ${name} is missing (${from})`);
		process.exit(1);
	}
	cpSync(from, join(native, name), {
		recursive: true,
		dereference: true,
		filter: served(name),
	});
}

// Fixed names at the file and server boundary. estrogen renames the runtime's
// own names, but it cannot rename a file's path or a route the server matches.
const fileNames = new Map(
	Object.entries({
		'epoxy-simd.wasm': 'simd.wasm',
		'epoxy.wasm': 'transport.wasm',
		'stomp_h3.js': 'h3.js',
		'stomp_h3_bg.wasm': 'h3_bg.wasm',
		'tor_js.js': 'client.js',
		'tor_js_bg.wasm': 'client_bg.wasm',
		'wispServer.mjs': 'relayServer.mjs',
		'fracital.svg': 'organisation.svg',
	}),
);
const pathNames = [
	['epoxy-simd.wasm', 'simd.wasm'],
	['epoxy.wasm', 'transport.wasm'],
	['stomp_h3_bg.wasm', 'h3_bg.wasm'],
	['stomp_h3.js', 'h3.js'],
	['tor_js_bg.wasm', 'client_bg.wasm'],
	['tor_js.js', 'client.js'],
	['wispServer.mjs', 'relayServer.mjs'],
	['fracital.svg', 'organisation.svg'],
	['/stomp-tor/', '/runtime-tor/'],
	['/stomp/', '/runtime/'],
	['/epoxy/', '/transport/'],
	['/libcurl/', '/fallback/'],
	['/tor-js/', '/tor/'],
	['STOMP_CONFIG', 'BROWSER_CONFIG'],
	['STOMP_ASSETS', 'BROWSER_ASSETS'],
	['STOMP_OFFLINE', 'BROWSER_OFFLINE'],
	['CFG.wisp ||', 'CFG.relay ||'],
	[
		'CFG.transports?.[name] || `/${name}/`',
		"CFG.transports?.[{ epoxy: 'primary', libcurl: 'secondary' }[name]] || ({ epoxy: '/transport/', libcurl: '/fallback/' }[name])",
	],
];
function neutralPaths(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const oldPath = join(dir, entry.name);
		const path = join(dir, fileNames.get(entry.name) ?? entry.name);
		if (path !== oldPath) renameSync(oldPath, path);
		if (entry.isDirectory()) {
			neutralPaths(path);
			continue;
		}
		if (!/\.(?:js|mjs|html|css|svg|json|webmanifest)$/.test(path)) continue;
		let text = readFileSync(path, 'utf8');
		for (const [from, to] of pathNames) text = text.replaceAll(from, to);
		writeFileSync(path, text);
	}
}
neutralPaths(native);
// The HTML shell cannot encrypt a link or the manifest's JSON. Keep their
// protected forms neutral; scripts and runtime URLs take estrogen's VM.
const index = join(native, 'public/index.html');
writeFileSync(
	index,
	readFileSync(index, 'utf8')
		.replaceAll('https://github.com/Fracital/powerMouse', 'https://github.com/')
		.replaceAll('powerMouse', 'Browser')
		.replaceAll('Fracital', 'GitHub'),
);
const manifestFile = join(native, 'public/manifest.webmanifest');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
manifest.name = manifest.short_name = 'Browser';
manifest.description = 'A browser in a page';
for (const handler of manifest.protocol_handlers ?? [])
	handler.protocol = 'web+browser';
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, '\t')}\n`);

// Binary assets and certificates have no literal pool. Mask them at rest and
// restore their exact bytes in the code that already reads them, so filter
// rules and test TLS behavior stay unchanged.
const masked = (bytes) => bytes.map((byte) => byte ^ 0xa5);
const snapshot = join(native, 'runtime/adblock-snapshot.dat.gz');
writeFileSync(
	snapshot,
	gzipSync(
		Buffer.concat([
			Buffer.from('masked0\0'),
			masked(gunzipSync(readFileSync(snapshot))),
		]),
	),
);
for (const name of ['turn-ca.pem', 'webtransport-ca.pem']) {
	const file = join(native, 'public/test', name);
	writeFileSync(
		file,
		`masked0\n${masked(readFileSync(file)).toString('base64')}\n`,
	);
}
cpSync(native, out, { recursive: true });

// the demo's canaries, derived from the source (scripts/demo-canaries.mjs);
// estrogen's own proxy and store names already cover STomp's
const canaries = `${out}.canaries.json`;
const derived = spawnSync(
	process.execPath,
	[join(root, 'scripts/demo-canaries.mjs'), canaries],
	{ cwd: root, stdio: 'inherit' },
);
if (derived.status !== 0) process.exit(1);
const estrogen = join(root, 'node_modules/.bin/estrogen');
const config = join(root, 'demo/estrogen.toml');
const run = (...more) =>
	spawnSync(
		estrogen,
		['--canary', canaries, '--config', config, ...more, out],
		{
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 1 << 28,
		},
	);
const started = Date.now();
const built = run('-v');
const report = `${built.stdout}${built.stderr}`;
writeFileSync(`${out}.estrogen.log`, report);
const summary = report
	.split('\n')
	.filter((line) => /file\(s\)/.test(line))
	.pop();
console.log(
	`build-demo-site: estrogen ${summary ?? '(no summary)'} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
// (estrogen fails closed: a file that would leak is left as it was. The
// gate still runs, to list every leak at once, and the build fails either way)
if (built.status !== 0) {
	console.error(
		report
			.split('\n')
			.filter((line) => /^estrogen: |error/i.test(line))
			.join('\n'),
	);
	console.error('build-demo-site: estrogen failed');
}
if (plant) {
	// (served files the page never reads, one per form the gate looks for:
	// leaks it must find)
	const planted = {
		'public/leak-plain.json': JSON.stringify({ planted: plant }),
		'public/leak-base64.css': `a{background:url(data:text/plain;base64,${Buffer.from(`x${plant}x`).toString('base64')})}`,
		'public/leak-url.html': `<a href="/?q=${[...plant].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')}">x</a>`,
	};
	for (const [name, body] of Object.entries(planted))
		writeFileSync(join(out, name), body);
	console.log(
		`build-demo-site: planted ${JSON.stringify(plant)} in ${Object.keys(planted).join(', ')}`,
	);
}
if (args.includes('--skip-gate')) process.exit(built.status === 0 ? 0 : 1);
const gate = spawnSync(
	process.execPath,
	[join(root, 'scripts/demo-leak-gate.mjs'), out, canaries],
	{ cwd: root, stdio: 'inherit' },
);
process.exit(built.status === 0 && gate.status === 0 ? 0 : 1);
