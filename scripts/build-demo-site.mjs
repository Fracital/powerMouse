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
//   stomp/     dist/, without its source maps and type declarations (the
//              service worker, the inject bundles, the controller), served at
//              every service-worker scope
//   epoxy/, libcurl/  the transports' dist directories
//   tor-js/    tor-js's package (Tor mode's client and arti's wasm)
//   examples/  the embedding examples
//
// Usage: node scripts/build-demo-site.mjs [--out <dir>] [--skip-gate]
//        [--plant <text>]
// --plant writes <text> into a served file after estrogen ran, to show the
// gate fails the build on a leak.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
	stomp: dist,
	epoxy: packageDir('@mercuryworkshop/epoxy-transport', 0),
	libcurl: packageDir('@mercuryworkshop/libcurl-transport', 0),
	'tor-js': packageDir('tor-js', 2),
	examples: join(root, 'examples'),
};
/** what of a root the page loads: no source map or type declaration */
const served = (name) => (path) => {
	const inside = relative(roots[name], path);
	if (/\.map$|\.d\.ts$/.test(inside)) return false;
	return name !== 'stomp' || !/^types(\/|$)/.test(inside);
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
const run = (...more) =>
	spawnSync(estrogen, ['--canary', canaries, ...more, out], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
	});
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
