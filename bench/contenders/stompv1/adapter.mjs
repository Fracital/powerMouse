// stompV1: Fracital/stompV1 at 7ee94c2 (one commit after tag v2.0.0, which
// only adds `webSocketImpl` to the client's WebSocket hook), the TOMP-model
// service worker proxy that STomp replaces. Built the way its README says
// (`npm install`, here `npm ci` against its own lockfile, then
// `npm run build`: webpack, production) under ctx.node.
// Set up the way its frontend did. The frontend its README links
// (github.com/sysce/tomp-demo) no longer exists anywhere we could reach, so
// the setup follows the frontends built on it, which all agree:
// /stomp/bootstrapper.js, `new StompBoot({ bare_server: '/bare/',
// directory: '/stomp/', loglevel: LOG_ERROR, codec: CODEC_XOR })`, and
// navigation to `boot.html(searchBuilder.query(input))`.
// Transport: its own Bare server (@tomphttp/bare-server-node 2.0.0, the
// release current at stompV1 v2.0.0 and the first whose v3 protocol the
// pinned @tomphttp/bare-client 2.x speaks), mounted at /bare/ on the same
// origin as the frontend, the way Bare servers are deployed. The whole
// frontend server is one child process under ctx.node with the harness's DNS
// shim, so the Bare server's fetches leave from Node (not through holyWisp)
// and reach *.bench.test fixtures.
// The pins, build, Bare server options, StompBoot config and notes come from
// bench/configs/stompv1.json; pkg/package-lock.json pins the Bare server's
// dependencies (its pkg/package.json is generated from the config).
import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProcess, waitForHttp } from '../../lib/net.mjs';
import { fill, loadConfig } from '../config.mjs';

export const id = 'stompv1';

const CONFIG = loadConfig(id);

export const rows = CONFIG.rows;

const HERE = fileURLToPath(new URL('./', import.meta.url));
const HOST = join(HERE, 'host');
const SERVER = join(HERE, 'server.mjs');

const REPO = CONFIG.repo;
const SHA = CONFIG.sha;
const { bareServer } = CONFIG;

const pkgDir = (ctx) => join(ctx.dir, 'pkg');
const dist = (ctx) => join(ctx.dir, 'dist');
const stamp = (ctx) => join(dist(ctx), '.bench-build.json');
const bareModule = (ctx) =>
	join(pkgDir(ctx), 'node_modules', bareServer.package);

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** npm and git run with ctx.node first on PATH, so npm's own `node` is it */
function run(ctx, command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: 'utf8',
		stdio: options.stdio || 'pipe',
		cwd: options.cwd,
		timeout: options.timeout || 600000,
		env: {
			...process.env,
			PATH: `${dirname(ctx.node)}${delimiter}${process.env.PATH}`,
			...options.env,
		},
	});
}

/** pkg/package.json: the Bare server at the version the config pins */
const bareManifest = () =>
	`${JSON.stringify(
		{
			name: 'bench-stompv1',
			private: true,
			dependencies: { [bareServer.package]: bareServer.version },
		},
		null,
		'\t',
	)}\n`;

const nodeVersion = (ctx) =>
	execFileSync(ctx.node, ['--version'], { encoding: 'utf8' }).trim();

function excludeFromClone(ctx, entry) {
	const exclude = join(ctx.dir, '.git/info/exclude');
	if (!existsSync(dirname(exclude))) return;
	const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
	if (!text.split('\n').includes(entry))
		writeFileSync(exclude, `${text.replace(/\n?$/, '\n')}${entry}\n`);
}

export async function setup(ctx) {
	if (!existsSync(join(ctx.dir, '.git'))) {
		mkdirSync(dirname(ctx.dir), { recursive: true });
		run(ctx, 'git', ['clone', '--quiet', REPO, ctx.dir], { stdio: 'inherit' });
	}
	const head = () =>
		run(ctx, 'git', ['-C', ctx.dir, 'rev-parse', 'HEAD']).trim();
	if (head() !== SHA) {
		try {
			run(ctx, 'git', ['-C', ctx.dir, 'cat-file', '-e', `${SHA}^{commit}`]);
		} catch {
			run(ctx, 'git', ['-C', ctx.dir, 'fetch', '--quiet', 'origin']);
		}
		run(ctx, 'git', ['-C', ctx.dir, 'checkout', '--quiet', '--detach', SHA]);
	}
	excludeFromClone(ctx, '/pkg/');

	// the README's build: install, then `npm run build` (webpack, production)
	const node = nodeVersion(ctx);
	const built = existsSync(stamp(ctx)) ? readJSON(stamp(ctx)) : null;
	if (
		!built ||
		built.sha !== SHA ||
		built.node !== node ||
		!existsSync(join(dist(ctx), 'worker.js'))
	) {
		run(ctx, 'npm', ['ci', '--no-audit', '--no-fund'], {
			cwd: ctx.dir,
			stdio: 'inherit',
		});
		run(ctx, 'npm', ['run', 'build'], { cwd: ctx.dir, stdio: 'inherit' });
		writeFileSync(
			stamp(ctx),
			`${JSON.stringify({ sha: SHA, node, at: new Date().toISOString() })}\n`,
		);
	}

	// the Bare server, at the exact versions of pkg/package-lock.json
	const dir = pkgDir(ctx);
	const lock = join(HERE, 'pkg/package-lock.json');
	const installedLock = join(dir, 'package-lock.json');
	const manifest = join(dir, 'package.json');
	if (
		!existsSync(join(bareModule(ctx), 'package.json')) ||
		!existsSync(installedLock) ||
		readFileSync(installedLock, 'utf8') !== readFileSync(lock, 'utf8') ||
		!existsSync(manifest) ||
		readFileSync(manifest, 'utf8') !== bareManifest()
	) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(manifest, bareManifest());
		copyFileSync(lock, installedLock);
		run(ctx, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
			cwd: dir,
			stdio: 'inherit',
		});
	}
}

function installed(root, name) {
	try {
		return readJSON(join(root, 'node_modules', name, 'package.json')).version;
	} catch {
		return null;
	}
}

export async function describe(ctx) {
	const git = (...args) =>
		execFileSync('git', ['-C', ctx.dir, ...args], { encoding: 'utf8' }).trim();
	const sha = git('rev-parse', 'HEAD');
	const node = nodeVersion(ctx);
	const pkg = readJSON(join(ctx.dir, 'package.json'));
	const packages = { '@sysce/stomp (stompV1)': pkg.version };
	for (const name of [
		'@tomphttp/bare-client',
		'meriyah',
		'parse5',
		'css-tree',
		'webpack',
	])
		packages[name] = installed(ctx.dir, name);
	for (const name of [bareServer.package, 'ws'])
		packages[name] = installed(pkgDir(ctx), name);
	const built = existsSync(stamp(ctx)) ? readJSON(stamp(ctx)) : {};
	return {
		repo: REPO,
		ref: CONFIG.ref,
		sha,
		dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
		packages,
		node,
		transport: fill(CONFIG.transport.summary, {
			bareServerVersion: packages[bareServer.package],
			node,
		}),
		config: CONFIG.notes.map((note) =>
			fill(note, { buildNode: built.node || node }),
		),
	};
}

export async function assets(ctx) {
	return [
		['bootstrapper.js', 'client'],
		['worker.js', 'sw'],
		['client.js', 'client'],
	]
		.map(([name, role]) => ({
			file: join(dist(ctx), name),
			url: `/stomp/${name}`,
			role,
		}))
		.filter((entry) => existsSync(entry.file));
}

export async function start(ctx, options = {}) {
	void options;
	const logFile = join(ctx.logDir, `stompv1-${ctx.port}.log`);
	const proc = startProcess(ctx.node, ['--require', ctx.nodeDnsShim, SERVER], {
		logFile,
		cwd: ctx.dir,
		env: {
			BENCH_PORT: String(ctx.port),
			BENCH_DIST: dist(ctx),
			BENCH_HOST: HOST,
			BENCH_BARE: join(bareModule(ctx), 'dist/createServer.js'),
		},
	});
	const origin = `http://127.0.0.1:${ctx.port}`;
	try {
		await Promise.race([
			waitForHttp(`${origin}${bareServer.mount}`, 30000),
			proc.exit.then(({ code, signal }) => {
				throw new Error(
					`stompv1 server exited ${code ?? signal}, see ${logFile}`,
				);
			}),
		]);
	} catch (error) {
		await proc.stop();
		throw error;
	}
	return {
		hostUrl: `${origin}/`,
		origin,
		pids: [proc.pid],
		stop: () => proc.stop(),
	};
}

export const hostDir = HOST;
