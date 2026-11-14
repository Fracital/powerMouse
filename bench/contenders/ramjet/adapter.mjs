// Ramjet (gitlab.com/hackz00/ramjet, a performance fork of Scramjet), from the
// prebuilt release tarballs of v2.0.67-ramjet.2 (commit 452ca00c): the
// ramjet-browser archive (compiled runtime + controller + utils, wasm already
// built) plus @mercuryworkshop/epoxy-transport at the version the repo's pnpm
// catalog pins. Set up the way its demo (packages/demo) and deployable template
// (create-ramjet-app with packages/bootstrap) do: the demo's sw.js at /
// importing the controller's service worker, ramjet.js and controller.api.js as
// classic scripts, one Controller in the host page holding the transport, a
// Frame on the iframe with the HttpCachePlugin, and frame.go(url) to navigate.
//
// Why prebuilt: Ramjet's rewriter is Rust/wasm and this environment has no Rust
// toolchain, so the release artifacts are used as-is (README offers this path).
// They are verified against the release MANIFEST sha256. Ramjet artifacts live
// under ~/.claude/stomp-work/ramjet-bench and are copied into the gitignored
// contender dir; nothing from Ramjet's own build touches the STomp repo.
//
// Transport: epoxy-transport 3.0.2 over the shared holyWisp, identical to the
// scramjet contender, so scramjet-vs-ramjet isolates Ramjet's rewriter/inject/
// cache changes. Ramjet's assisted transport is deliberately NOT used.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { configScript, headers, loadConfig, withWisp } from '../config.mjs';

export const id = 'ramjet';

const CONFIG = loadConfig(id);

export const rows = CONFIG.rows;

const HOST = fileURLToPath(new URL('./host/', import.meta.url));

const SHA = CONFIG.sha;
const ARCHIVE = CONFIG.release.browserArchive;
const NPM = CONFIG.npm;

const expandHome = (p) =>
	p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;

const localDir = () =>
	expandHome(process.env.RAMJET_BENCH_DIR || CONFIG.release.localDir);

const pkgDir = (ctx) => join(ctx.dir, 'pkg');
const distDir = (ctx) => join(ctx.dir, 'dist'); // extracted browser archive
const epoxyDist = (ctx) =>
	join(pkgDir(ctx), 'node_modules/@mercuryworkshop/epoxy-transport/dist');
const stateFile = (ctx) => join(ctx.dir, 'setup.json');

const sha256 = (file) =>
	createHash('sha256').update(readFileSync(file)).digest('hex');

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function download(url, file) {
	const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** the verified browser archive tarball: from ~/.claude/stomp-work, else download */
async function ensureArchive() {
	const dir = localDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, ARCHIVE.file);
	if (!existsSync(path)) await download(ARCHIVE.url, path);
	const digest = sha256(path);
	if (digest !== ARCHIVE.sha256)
		throw new Error(
			`ramjet: ${ARCHIVE.file} has sha256 ${digest}, bench/configs/ramjet.json pins ${ARCHIVE.sha256}`,
		);
	return path;
}

export async function setup(ctx) {
	if (
		existsSync(stateFile(ctx)) &&
		existsSync(join(distDir(ctx), 'ramjet/ramjet.js')) &&
		existsSync(join(epoxyDist(ctx), 'index.mjs'))
	)
		return;
	mkdirSync(ctx.dir, { recursive: true });

	// 1. compiled browser runtime, verified then extracted into dist/
	const archive = await ensureArchive();
	rmSync(distDir(ctx), { recursive: true, force: true });
	mkdirSync(distDir(ctx), { recursive: true });
	execFileSync('tar', ['-xzf', archive, '-C', distDir(ctx)], {
		timeout: 120000,
	});

	// 2. epoxy transport from npm, same pins as the scramjet contender
	const dir = pkgDir(ctx);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'package.json'),
		`${JSON.stringify(
			{ name: 'bench-ramjet', private: true, dependencies: NPM },
			null,
			'\t',
		)}\n`,
	);
	execFileSync(
		'npm',
		['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'],
		{ cwd: dir, stdio: 'inherit', timeout: 600000 },
	);

	// what the runtime reports as its own version/build
	const ramjetJs = readFileSync(join(distDir(ctx), 'ramjet/ramjet.js'), 'utf8');
	const match = ramjetJs.match(
		/version:"([^"]+)",build:"([0-9a-f]+)",date:"([^"]+)"/,
	);
	const build = match
		? { version: match[1], build: match[2], date: match[3] }
		: null;

	writeFileSync(
		stateFile(ctx),
		`${JSON.stringify(
			{
				pinnedSha: SHA,
				browserArchive: { ...ARCHIVE, from: archive },
				build,
				setupAt: new Date().toISOString(),
			},
			null,
			'\t',
		)}\n`,
	);
}

function installed(ctx) {
	const lock = readJSON(join(pkgDir(ctx), 'node_modules/.package-lock.json'));
	const packages = {};
	for (const [path, entry] of Object.entries(lock.packages)) {
		const name = path.replace(/^node_modules\//, '');
		if (name.startsWith('@mercuryworkshop/'))
			packages[name] = entry.integrity
				? `${entry.version} (${entry.integrity})`
				: entry.version;
	}
	return packages;
}

export async function describe(ctx) {
	const state = readJSON(stateFile(ctx));
	const packages = installed(ctx);
	packages['@ramjet/core'] =
		`${state.build?.version} (release browser archive ${state.browserArchive.file}, sha256 ${state.browserArchive.sha256}, built from ${state.build?.build})`;
	return {
		repo: CONFIG.repo,
		ref: CONFIG.ref,
		sha: SHA,
		release: {
			tag: CONFIG.release.tag,
			archive: state.browserArchive,
			build: state.build,
		},
		packages,
		transport: CONFIG.transport.summary,
		config: CONFIG.notes,
	};
}

export async function assets(ctx) {
	const d = distDir(ctx);
	const list = [
		{ file: join(HOST, 'sw.js'), url: '/sw.js', role: 'sw' },
		{
			file: join(d, 'controller/controller.sw.js'),
			url: '/controller/controller.sw.js',
			role: 'sw',
		},
		{
			file: join(d, 'ramjet/ramjet.js'),
			url: '/ramjet/ramjet.js',
			role: 'client',
		},
		{
			file: join(d, 'ramjet/ramjet.wasm'),
			url: '/ramjet/ramjet.wasm',
			role: 'rewriter',
		},
		{
			file: join(d, 'ramjet/ramjet-utils.js'),
			url: '/ramjet/ramjet-utils.js',
			role: 'other',
		},
		{
			file: join(d, 'controller/controller.api.js'),
			url: '/controller/controller.api.js',
			role: 'client',
		},
		{
			file: join(d, 'controller/controller.inject.js'),
			url: '/controller/controller.inject.js',
			role: 'client',
		},
		{
			file: join(epoxyDist(ctx), 'index.mjs'),
			url: '/epoxy/index.mjs',
			role: 'transport',
		},
	];
	return list.filter((entry) => {
		try {
			return statSync(entry.file).isFile();
		} catch {
			return false;
		}
	});
}

export async function start(ctx) {
	const d = distDir(ctx);
	const app = express();
	app.disable('x-powered-by');
	app.use(headers(CONFIG.headers));
	const fresh = {
		setHeaders: (res) => res.set('Cache-Control', CONFIG.cacheControl.default),
	};
	app.use('/ramjet/', express.static(join(d, 'ramjet'), fresh));
	app.use('/controller/', express.static(join(d, 'controller'), fresh));
	app.use('/epoxy/', express.static(epoxyDist(ctx), fresh));
	app.get(
		'/bench-config.js',
		configScript({
			wisp: ctx.wispUrl,
			serviceWorker: CONFIG.serviceWorker.path,
			transportOptions: withWisp(CONFIG.transport.options, ctx.wispUrl),
			plugins: CONFIG.controller.plugins,
		}),
	);
	app.use('/', express.static(HOST, fresh));
	const server = createServer(app);
	await new Promise((resolve) => server.listen(ctx.port, '127.0.0.1', resolve));
	return {
		hostUrl: `http://127.0.0.1:${ctx.port}/`,
		origin: `http://127.0.0.1:${ctx.port}`,
		pids: [process.pid],
		inProcess: true,
		stop: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			}),
	};
}

export const hostDir = dirname(HOST);
