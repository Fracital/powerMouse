// The offline-html build (`npm run build:offline`): the demo's page
// (demo/public) and STomp (dist/) in one HTML file, build/offline.html,
// which runs from file:, from any static host, with no service worker.
// The page serves the proxy itself (demo/offline/host.mjs): the service
// worker's script runs unchanged in a dedicated worker, and proxied
// documents are written into frames.
//
//   node scripts/build-offline.mjs [--out <file>] [--no-adblock]
//
// The demo's scripts and styles are inlined as they are, its images as
// data: URLs; the bundles, wasm modules and transports the proxy needs go in
// a JSON payload, each gzipped (DecompressionStream decodes them in the
// page). The wisp server defaults to STOMP_OFFLINE_WISP, else the public
// holyWisp relay, in an element at the top of the file's head (WISP_SLOT), which
// the demo's Download button rewrites; the page's Settings (or `?wisp=`)
// changes it too. `npm run build` ends with this; builds dist/ first when it
// is not there. Writes nothing into dist/.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { OFFLINE_WISP, offlineKey } from './offline-key.mjs';
import { offlineNotices } from './offline-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? null : args[at + 1];
};
const out = resolve(root, option('--out') ?? 'build/offline.html');
const adblock = !args.includes('--no-adblock');
const wisp = process.env.STOMP_OFFLINE_WISP || OFFLINE_WISP;
/** the origin the page's worker and documents are on (demo/offline/host.mjs ORIGIN) */
const ORIGIN = 'https://powermouse.invalid';

const dist = join(root, 'dist');
if (!existsSync(join(dist, 'serviceWorker.js'))) {
	console.log('build-offline: no dist/, building it');
	execFileSync(process.execPath, ['build.js'], { cwd: root, stdio: 'inherit' });
}
// what it is made from (scripts/offline-key.mjs), named in its first comment
const key = offlineKey(root, { wisp, adblock });
const require = createRequire(join(root, 'package.json'));
const packageDir = (name) =>
	dirname(require.resolve(`@mercuryworkshop/${name}`));
const epoxy = packageDir('epoxy-transport');
const libcurl = packageDir('libcurl-transport');
const demo = join(root, 'demo/public');

const TYPES = {
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.wasm': 'application/wasm',
	'.json': 'application/json',
	'.html': 'text/html',
	'.gz': 'application/octet-stream',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};
const typeOf = (file) => TYPES[extname(file)] ?? 'application/octet-stream';

/**
 * A module the page maps to its copy: `import.meta.url` is that copy's
 * blob: URL, which no relative URL resolves against, so it reads as the
 * module's own address on ORIGIN (where the page answers its wasm)
 */
const located = (path) => (text) => {
	const count = text.split('import.meta.url').length - 1;
	if (!count) throw new Error(`${path} no longer reads import.meta.url`);
	return text.replaceAll('import.meta.url', JSON.stringify(`${ORIGIN}${path}`));
};

/** what the payload carries: its path in the page, its file, and a change to its text */
const FILES = [
	['/stomp/serviceWorker.js', join(dist, 'serviceWorker.js')],
	['/stomp/injectDocument.js', join(dist, 'injectDocument.js')],
	['/stomp/rewriterLib.js', join(dist, 'rewriterLib.js')],
	['/stomp/core.wasm', join(dist, 'core.wasm')],
	['/stomp/codec.wasm', join(dist, 'codec.wasm')],
	['/stomp/extensionsRuntime.js', join(dist, 'extensionsRuntime.js')],
	// the transport runs in the page here, but the controller's clock still
	// starts from this script (src/controller/index.ts #startClock): with no
	// copy the page left its URL, file:///stomp/transportWorker.js, to the
	// browser, which refuses it (Firefox with a Security Error)
	['/stomp/transportWorker.js', join(dist, 'transportWorker.js')],
	...(adblock
		? [
				['/stomp/blocker.wasm', join(dist, 'blocker.wasm')],
				// gzipped already, and served as it is
				[
					'/stomp/adblock-snapshot.dat.gz',
					join(dist, 'adblock-snapshot.dat.gz'),
				],
				['/stomp/adblock-resources.json', join(dist, 'adblock-resources.json')],
			]
		: []),
	['/epoxy/index.mjs', join(epoxy, 'index.mjs'), located('/epoxy/index.mjs')],
	['/epoxy/epoxy-simd.wasm', join(epoxy, 'epoxy-simd.wasm')],
	[
		'/epoxy/h3/stomp_h3.js',
		join(epoxy, 'h3/stomp_h3.js'),
		located('/epoxy/h3/stomp_h3.js'),
	],
	['/epoxy/h3/stomp_h3_bg.wasm', join(epoxy, 'h3/stomp_h3_bg.wasm')],
	['/libcurl/index.mjs', join(libcurl, 'index.mjs')],
	['/error.html', join(demo, 'error.html')],
];

const payload = {};
let raw = 0;
for (const [path, file, change] of FILES) {
	let bytes = await readFile(file);
	if (change) bytes = Buffer.from(change(bytes.toString('utf8')));
	raw += bytes.length;
	const keep = file.endsWith('.gz');
	payload[path] = [
		typeOf(file),
		keep ? 'raw' : 'gzip',
		(keep ? bytes : gzipSync(bytes, { level: 9 })).toString('base64'),
	];
}

/** a classic script's text, safe inside a <script> element */
const scriptText = (text) =>
	text.replaceAll('</script', '\\x3C/script').replaceAll('<!--', '\\x3C!--');
const inlineScript = (text, attributes = '') =>
	`<script${attributes}>${scriptText(text)}</script>`;

async function bundle(entry, define = {}) {
	const result = await build({
		entryPoints: [join(root, entry)],
		bundle: true,
		format: 'iife',
		target: 'es2022',
		write: false,
		minify: true,
		legalComments: 'none',
		define,
	});
	return result.outputFiles[0].text;
}
const prelude = await bundle('demo/offline/worker.mjs');
// what /api/status and /api/commits answer (demo/server.js): the build, and
// this checkout's latest commits as the server reads them
const builtFrom = JSON.parse(await readFile(join(dist, 'build.json'), 'utf8'));
const REPO = 'Fracital/powerMouse';
let commits = null;
try {
	const log = execFileSync(
		'git',
		['-C', root, 'log', '-30', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'],
		{ encoding: 'utf8' },
	);
	const avatarOf = (email) => {
		const noreply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
		if (noreply)
			return `https://avatars.githubusercontent.com/u/${noreply[1]}?v=4`;
		return email
			? `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}`
			: null;
	};
	commits = {
		repo: REPO,
		url: `https://github.com/${REPO}`,
		commits: log
			.split('\x1e')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [sha, author, email, date, message] = line.split('\x1f');
				return {
					sha: sha.slice(0, 7),
					url: `https://github.com/${REPO}/commit/${sha}`,
					message,
					author,
					avatar: avatarOf(email),
					date,
				};
			}),
	};
} catch {
	// not a checkout: the home page says so
}
const boot = await bundle('demo/offline/boot.mjs', {
	__PM_PRELUDE__: JSON.stringify(prelude),
	__PM_BUILD__: JSON.stringify(builtFrom),
	__PM_COMMITS__: JSON.stringify(commits),
	__PM_ADBLOCK__: String(adblock),
});

// the demo's own files as data: URLs, wherever they are named
const dataURL = async (file) =>
	`data:${typeOf(file)};base64,${(await readFile(file)).toString('base64')}`;
const named = new Map();
const publicFile = (path) =>
	path.startsWith('/fonts/montserrat/')
		? join(
				dirname(require.resolve('@fontsource/montserrat/package.json')),
				'files',
				path.slice('/fonts/montserrat/'.length),
			)
		: join(demo, path);
async function withDataURLs(text) {
	const paths = new Set(
		text.match(
			/\/(?:pm\/(?:icons\/)?[\w.-]+\.(?:png|svg)|fonts\/montserrat\/[\w.-]+\.woff2|favicon\.ico)/g,
		) ?? [],
	);
	for (const path of paths) {
		const file = publicFile(path);
		if (!existsSync(file)) continue;
		if (!named.has(path)) named.set(path, await dataURL(file));
		text = text.replaceAll(path, named.get(path));
	}
	return text;
}
const read = (file) => readFile(file, 'utf8');
const css = async (file) =>
	`<style>${await withDataURLs(await read(file))}</style>`;

let html = await read(join(demo, 'index.html'));
const swap = async (from, to) => {
	if (!html.includes(from)) throw new Error(`index.html no longer has ${from}`);
	html = html.replace(from, () => to);
};
// the wisp server, as JSON in the element after the charset: the one place
// a page saving the file (demo/public/pm/main.js, Download) writes its own
// into
const WISP_SLOT = 'id="pm-wisp"';
await swap(
	'<meta charset="utf-8" />',
	`<meta charset="utf-8" />\n\t\t<script type="application/json" ${WISP_SLOT}>${JSON.stringify(wisp).replaceAll('<', '\\u003c')}</script>`,
);
await swap(
	'<link rel="stylesheet" href="/pm/main.css" />',
	await css(join(demo, 'pm/main.css')),
);
await swap(
	'<link rel="stylesheet" href="/pm/extensions-page.css" />',
	await css(join(demo, 'pm/extensions-page.css')),
);
await swap(
	'<script src="/pm/profile.js"></script>',
	inlineScript(await read(join(demo, 'pm/profile.js'))),
);
await swap(
	'<script src="/pm/theme.js"></script>',
	inlineScript(await read(join(demo, 'pm/theme.js'))),
);
await swap(
	'<script src="/config.js"></script>',
	`<script type="application/json" id="pm-files">${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script>\n${inlineScript(boot)}`,
);
await swap(
	'<script src="/stomp/Controller.js"></script>',
	inlineScript(await read(join(dist, 'Controller.js'))),
);
await swap(
	'<script src="/stomp/SearchBuilder.js"></script>',
	inlineScript(await read(join(dist, 'SearchBuilder.js'))),
);
await swap(
	'<script src="/stomp/omnibox.js" defer data-omnibox></script>',
	inlineScript(await read(join(dist, 'omnibox.js'))),
);
await swap(
	'<script src="/pm/extensions-page.js"></script>',
	inlineScript(
		await withDataURLs(await read(join(demo, 'pm/extensions-page.js'))),
	),
);
await swap(
	'<script src="/pm/main.js"></script>',
	inlineScript(await withDataURLs(await read(join(demo, 'pm/main.js')))),
);
html = await withDataURLs(html);

// the licences: a line at the top, the notices at the end
const notices = offlineNotices({
	root,
	dist,
	bundles: [
		...FILES.map(([, file]) => file)
			.filter((file) => file.startsWith(dist) && file.endsWith('.js'))
			.map((file) => file.slice(dist.length + 1)),
		'Controller.js',
		'SearchBuilder.js',
		'omnibox.js',
	],
	whole: [
		['@mercuryworkshop/epoxy-transport', '/epoxy/'],
		['@mercuryworkshop/libcurl-transport', '/libcurl/index.mjs'],
		['libcurl.js', '/libcurl/index.mjs, inside the libcurl transport'],
		['@fontsource/montserrat', "the Montserrat font in the page's style"],
	],
	commit: builtFrom.commit,
	adblock,
});
await swap(
	'<!doctype html>',
	`<!doctype html>\n<!-- offline.html (key ${key}): powerMouse and STomp, GPL-3.0-only, source at https://github.com/Fracital/powerMouse/tree/${builtFrom.commit}. The licences and notices of every part are at the end of this file. -->`,
);
html = `${html.trimEnd()}\n<!--\n${notices}\n-->\n`;
if (html.split(WISP_SLOT).length !== 2)
	throw new Error(`${WISP_SLOT} has to be named once in the file`);

// (whole or not at all: demo/server.js may be serving the last one)
await mkdir(dirname(out), { recursive: true });
const partial = `${out}.${process.pid}.tmp`;
await writeFile(partial, html);
await rename(partial, out);
const size = (await stat(out)).size;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
console.log(
	`build-offline: ${out} ${mb(size)} (${size} B; payload ${FILES.length} files, ${mb(raw)} before gzip; wisp ${wisp}${adblock ? '' : '; no adblock'})`,
);
