// Scramjet (MercuryWorkshop/scramjet main bb5a8550, 3.0.0-alpha), from the
// tarballs its "Continuous Build" GitHub release (tag `latest`) held for that
// commit on 2026-11-23: @mercuryworkshop/scramjet and
// @mercuryworkshop/scramjet-controller. The tag is recreated on every release
// build of main, so setup keeps a copy of both in <contenders>/.cache/scramjet
// and takes them from there first. Set up the way its demo
// (packages/demo) and its deployable template (packages/create-proxy-app with
// packages/bootstrap) do: the demo's sw.js at / importing the controller's
// service worker, scramjet.js and controller.api.js as classic scripts, one
// Controller in the host page holding the transport, a Frame on the iframe
// with the HttpCachePlugin both of them install, and frame.go(url) to
// navigate. Transport: @mercuryworkshop/epoxy-transport at the version the
// repo's pnpm catalog pins, over the shared holyWisp. The scramjet config is
// the Controller's own default (the template's), not the demo's debug flags.
// scramjet-utils (the cache plugin) is not in the release and its npm build
// expects older scramjet versions, so setup bundles packages/utils/src at
// bb5a8550 with esbuild the way the repo's rspack config does.
// The pins, downloads, esbuild options, transport options and notes come from
// bench/configs/scramjet.json; host/sw.js is the demo's file, verbatim.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { configScript, headers, loadConfig, withWisp } from '../config.mjs';

export const id = 'scramjet';

const CONFIG = loadConfig(id);

export const rows = CONFIG.rows;

const HOST = fileURLToPath(new URL('./host/', import.meta.url));

const REPO = new URL(CONFIG.repo).pathname.slice(1);
const SHA = CONFIG.sha;
const RELEASE = CONFIG.release.download;
const TARBALLS = Object.fromEntries(
	Object.entries(CONFIG.release.tarballs).map(([name, { file }]) => [
		name,
		file,
	]),
);
// pnpm-workspace.yaml catalog at bb5a8550 (and semver from its lockfile)
const NPM = CONFIG.npm;

const pkgDir = (ctx) => join(ctx.dir, 'pkg');
// outside <contenders>/scramjet, so the pinned tarballs outlive a clean setup
// and the release tag moving on
const cacheDir = (ctx) =>
	join(ctx.contendersDir ?? dirname(ctx.dir), '.cache', id);
const modules = (ctx) => join(pkgDir(ctx), 'node_modules/@mercuryworkshop');
const utilsBuild = (ctx) => join(pkgDir(ctx), 'build/scramjet-utils.js');
const stateFile = (ctx) => join(pkgDir(ctx), 'setup.json');

const sha256 = (file) =>
	createHash('sha256').update(readFileSync(file)).digest('hex');

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function download(url, file) {
	const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** the release's metadata: which commit it says it was built from (CI leaves
 * the body empty when the build is started by hand), asset digests */
async function releaseInfo() {
	try {
		const response = await fetch(CONFIG.release.api, {
			headers: {
				accept: 'application/vnd.github+json',
				'user-agent': 'proxy-bench-setup',
			},
			signal: AbortSignal.timeout(30000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const release = await response.json();
		return {
			body: release.body,
			sha: release.body?.match(/commit\/([0-9a-f]{40})/)?.[1] || null,
			publishedAt: release.published_at,
			digests: Object.fromEntries(
				release.assets.map((asset) => [asset.name, asset.digest || null]),
			),
		};
	} catch (error) {
		return { error: error.message };
	}
}

/** packages/utils/src at the pinned commit, from the clone or from GitHub */
async function utilsSource(ctx, target) {
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	let archive;
	try {
		// only a clone of scramjet itself (git -C would find an enclosing repo)
		if (!existsSync(join(ctx.dir, '.git'))) throw new Error('no clone');
		execFileSync('git', ['-C', ctx.dir, 'cat-file', '-e', `${SHA}^{commit}`], {
			stdio: 'ignore',
		});
		archive = join(pkgDir(ctx), 'utils-src.tar');
		execFileSync('git', [
			'-C',
			ctx.dir,
			'archive',
			'-o',
			archive,
			'--prefix=scramjet/',
			SHA,
			'packages/utils',
		]);
	} catch {
		archive = join(pkgDir(ctx), 'scramjet-src.tar.gz');
		await download(
			`https://codeload.github.com/${REPO}/tar.gz/${SHA}`,
			archive,
		);
	}
	execFileSync('tar', [
		'-xf',
		archive,
		'-C',
		target,
		'--strip-components=3',
		'--wildcards',
		'*/packages/utils/*',
	]);
	rmSync(archive);
}

/**
 * The pinned tarball `file` at `path`: already there, else the cached copy,
 * else downloaded from the release. Checked against its sha256 pin, and kept
 * in the cache.
 */
async function tarball(ctx, name, file, path) {
	const pinned = CONFIG.release.tarballs[name].sha256;
	const cached = join(cacheDir(ctx), file);
	const matches = (candidate) =>
		existsSync(candidate) && sha256(candidate) === pinned;
	let source = 'pkg/tarballs';
	if (!matches(path)) {
		rmSync(path, { force: true });
		if (matches(cached)) {
			copyFileSync(cached, path);
			source = cached;
		} else {
			source = RELEASE + file;
			try {
				await download(source, path);
			} catch (error) {
				throw new Error(
					`scramjet: ${file} is not in ${cached} and the release has no copy (${error.message}); the "latest" tag has probably moved on from ${SHA.slice(0, 8)}. ${CONFIG.release.fallback}`,
					{ cause: error },
				);
			}
		}
	}
	const digest = sha256(path);
	if (digest !== pinned) {
		rmSync(path, { force: true });
		throw new Error(
			`scramjet: ${file} from ${source} has sha256:${digest}, bench/configs/scramjet.json pins sha256:${pinned}; the "latest" tag has probably moved on from ${SHA.slice(0, 8)}. ${CONFIG.release.fallback}`,
		);
	}
	if (!matches(cached)) {
		mkdirSync(cacheDir(ctx), { recursive: true });
		copyFileSync(path, cached);
	}
	return { source, cached };
}

export async function setup(ctx) {
	const dir = pkgDir(ctx);
	if (
		existsSync(stateFile(ctx)) &&
		readJSON(stateFile(ctx)).pinnedSha === SHA &&
		existsSync(utilsBuild(ctx)) &&
		existsSync(join(modules(ctx), 'scramjet/dist/scramjet.js'))
	)
		return;
	// another pin's install: start over (the tarballs are in the cache)
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, 'tarballs'), { recursive: true });
	// keep the clone's git status clean
	if (existsSync(join(ctx.dir, '.git/info'))) {
		const exclude = join(ctx.dir, '.git/info/exclude');
		const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
		if (!/^\/pkg\/$/m.test(text))
			writeFileSync(exclude, `${text.replace(/\n?$/, '\n')}/pkg/\n`);
	}

	const release = await releaseInfo();
	const tarballs = {};
	for (const [name, file] of Object.entries(TARBALLS)) {
		const path = join(dir, 'tarballs', file);
		const { source, cached } = await tarball(ctx, name, file, path);
		const digest = `sha256:${sha256(path)}`;
		tarballs[name] = {
			file,
			url: RELEASE + file,
			from: source,
			cached,
			sha256: digest.slice(7),
			matchesRelease: release.digests ? release.digests[file] === digest : null,
		};
	}
	if (release.sha && release.sha !== SHA)
		console.warn(
			`scramjet: the latest release is now built from ${release.sha}, not ${SHA}; using the pinned tarballs`,
		);
	else if (
		release.digests &&
		Object.values(tarballs).some((entry) => !entry.matchesRelease)
	)
		console.warn(
			`scramjet: the latest release no longer holds the pinned ${SHA.slice(0, 8)} tarballs; using the pinned copies`,
		);

	writeFileSync(
		join(dir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'bench-scramjet',
				private: true,
				dependencies: {
					...Object.fromEntries(
						Object.entries(TARBALLS).map(([name, file]) => [
							name,
							`file:tarballs/${file}`,
						]),
					),
					...NPM,
				},
			},
			null,
			'\t',
		)}\n`,
	);
	execFileSync(
		'npm',
		['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'],
		{ cwd: dir, stdio: 'inherit', timeout: 600000 },
	);

	// the build commit both bundles say they were built from
	const builds = {};
	for (const [name, file] of [
		['@mercuryworkshop/scramjet', 'scramjet/dist/scramjet.js'],
		[
			'@mercuryworkshop/scramjet-controller',
			'scramjet-controller/dist/controller.api.js',
		],
	]) {
		const match = readFileSync(join(modules(ctx), file), 'utf8').match(
			/version:"([^"]+)",build:"([0-9a-f]+)",date:"([^"]+)"/,
		);
		builds[name] = match
			? { version: match[1], build: match[2], date: match[3] }
			: null;
		// the sha256 pins already fix the bytes; this catches pins and sha
		// edited out of step
		if (!builds[name] || !SHA.startsWith(builds[name].build))
			throw new Error(
				`scramjet: ${file} says build ${builds[name]?.build}, bench/configs/scramjet.json says ${SHA}`,
			);
	}

	// scramjet-utils at the pinned commit: the rspack IIFE build's shape
	// (scramjet and the controller resolve to their *-external.mjs stubs, which
	// read the globals the classic scripts set; proxy-transports is bundled)
	const utilsDir = join(dir, 'scramjet-utils');
	await utilsSource(ctx, utilsDir);
	const utilsMeta = readJSON(join(utilsDir, 'package.json'));
	const esbuild = await import('esbuild');
	await esbuild.build({
		entryPoints: [join(utilsDir, 'src/index.ts')],
		outfile: utilsBuild(ctx),
		...CONFIG.utils.esbuild,
		nodePaths: [join(dir, 'node_modules')],
		define: {
			VERSION: JSON.stringify(utilsMeta.version),
			COMMITHASH: JSON.stringify(SHA.slice(0, 7)),
			BUILDDATE: JSON.stringify(new Date().toISOString()),
			SCRAMJET_EXPECTED_VERSION: JSON.stringify(
				builds['@mercuryworkshop/scramjet']?.version,
			),
			CONTROLLER_EXPECTED_VERSION: JSON.stringify(
				builds['@mercuryworkshop/scramjet-controller']?.version,
			),
		},
		logLevel: 'warning',
	});

	writeFileSync(
		stateFile(ctx),
		`${JSON.stringify(
			{
				pinnedSha: SHA,
				release,
				tarballs,
				builds,
				utils: {
					version: utilsMeta.version,
					from: SHA,
					esbuild: esbuild.version,
				},
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
	for (const [name, tarball] of Object.entries(state.tarballs))
		packages[name] =
			`${state.builds[name]?.version} (release asset ${tarball.file}, sha256 ${tarball.sha256}, built from ${state.builds[name]?.build})`;
	packages['@mercuryworkshop/scramjet-utils'] =
		`${state.utils.version} (packages/utils/src at ${state.utils.from}, bundled by setup with esbuild ${state.utils.esbuild})`;
	const releaseSha = state.release.sha;
	return {
		repo: CONFIG.repo,
		ref: CONFIG.ref,
		sha: SHA,
		release: {
			tag: CONFIG.release.tag,
			pinned: CONFIG.release.builtBy,
			builtFrom: releaseSha,
			matchesPin: releaseSha ? releaseSha === SHA : null,
			publishedAt: state.release.publishedAt,
			tarballs: state.tarballs,
			builds: state.builds,
		},
		packages,
		transport: CONFIG.transport.summary,
		config: CONFIG.notes,
	};
}

export async function assets(ctx) {
	const sj = modules(ctx);
	const list = [
		{ file: join(HOST, 'sw.js'), url: '/sw.js', role: 'sw' },
		{
			file: join(sj, 'scramjet-controller/dist/controller.sw.js'),
			url: '/controller/controller.sw.js',
			role: 'sw',
		},
		{
			file: join(sj, 'scramjet/dist/scramjet.js'),
			url: '/scramjet/scramjet.js',
			role: 'client',
		},
		{
			file: join(sj, 'scramjet/dist/scramjet.wasm'),
			url: '/scramjet/scramjet.wasm',
			role: 'rewriter',
		},
		{
			file: join(sj, 'scramjet-controller/dist/controller.api.js'),
			url: '/controller/controller.api.js',
			role: 'client',
		},
		{
			file: join(sj, 'scramjet-controller/dist/controller.inject.js'),
			url: '/controller/controller.inject.js',
			role: 'client',
		},
		{ file: utilsBuild(ctx), url: '/utils/scramjet-utils.js', role: 'other' },
		{
			file: join(sj, 'epoxy-transport/dist/index.mjs'),
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
	const sj = modules(ctx);
	const app = express();
	app.disable('x-powered-by');
	// none: the demo's vite server sends no cross-origin isolation headers
	app.use(headers(CONFIG.headers));
	const fresh = {
		setHeaders: (res) => res.set('Cache-Control', CONFIG.cacheControl.default),
	};
	// the demo's vite config copies these dists to /scramjet/ and /controller/
	app.use('/scramjet/', express.static(join(sj, 'scramjet/dist'), fresh));
	app.use(
		'/controller/',
		express.static(join(sj, 'scramjet-controller/dist'), fresh),
	);
	app.use('/utils/', express.static(dirname(utilsBuild(ctx)), fresh));
	app.use('/epoxy/', express.static(join(sj, 'epoxy-transport/dist'), fresh));
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
