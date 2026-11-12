// powerMouseV1: Fracital/powerMouseV1 at 8fdaf44, the server-side Node
// rewriting proxy (express, node-fetch 2, ws 7; 2020, Node 14 era, with the
// 2026 fix of its public-IP lookup) that STomp replaces. Set up the way its
// README says: `npm install` (here `npm ci` against
// bench/contenders/powermouse-v1/package-lock.json, what `npm install`
// resolved on 2026-11-11; the repo has no lockfile), then `npm start`
// (`node app.js`) with config.json changed to listen where we want: start()
// writes a private copy of the tree's config.json (listenip 127.0.0.1, a free
// port, nothing else changed) into a run directory that is the process's
// working directory, so the clone is never edited.
// The proxy fetches every page from Node (its own transport, not holyWisp),
// run under ctx.node with the harness's DNS shim. Pages are addressed as
// <proxy origin>/<absolute URL>, what its home page form (POST /prox)
// redirects to. A user opens its home page first, which sets the
// session cookie the proxy uses to resolve root-relative requests it did not
// rewrite; the host page does the same before it reports ready.
// Host page and proxy are both addressed as `localhost`: on 127.0.0.1 the
// proxy derives a cookie Domain of ".0.0.1:<port>" from the Host header,
// which today's `cookie` package rejects, so every response is a 500.
// The pin, run setup, config.json changes, the app.js patch, the host name and
// the notes come from bench/configs/powermouse-v1.json.
import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startProcess, waitForHttp } from '../../lib/net.mjs';
import { configScript, fill, headers, loadConfig } from '../config.mjs';

export const id = 'powermouse-v1';

const CONFIG = loadConfig(id);

export const rows = CONFIG.rows;

const HERE = fileURLToPath(new URL('./', import.meta.url));
const HOST = join(HERE, 'host');
const LOCK = join(HERE, 'package-lock.json');

const REPO = CONFIG.repo;
const SHA = CONFIG.sha;
// the name both the host page and the proxy are addressed by (see above)
const HOSTNAME = CONFIG.hostname;

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
		},
	});
}

const nodeVersion = (ctx) =>
	execFileSync(ctx.node, ['--version'], { encoding: 'utf8' }).trim();

function excludeFromClone(ctx, entries) {
	const exclude = join(ctx.dir, '.git/info/exclude');
	if (!existsSync(dirname(exclude))) return;
	let text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
	for (const entry of entries)
		if (!text.split('\n').includes(entry))
			text = `${text.replace(/\n?$/, '\n')}${entry}\n`;
	writeFileSync(exclude, text);
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
	excludeFromClone(ctx, ['/package-lock.json', '/.bench-run/']);
	const lock = join(ctx.dir, 'package-lock.json');
	if (
		existsSync(join(ctx.dir, 'node_modules/express/package.json')) &&
		existsSync(lock) &&
		readFileSync(lock, 'utf8') === readFileSync(LOCK, 'utf8')
	)
		return;
	copyFileSync(LOCK, lock);
	run(ctx, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
		cwd: ctx.dir,
		stdio: 'inherit',
	});
}

function installed(name, root) {
	try {
		return readJSON(join(root, 'node_modules', name, 'package.json')).version;
	} catch {
		return null;
	}
}

export async function describe(ctx) {
	const git = (...args) =>
		execFileSync('git', ['-C', ctx.dir, ...args], { encoding: 'utf8' }).trim();
	const node = nodeVersion(ctx);
	const packages = {
		'powermouse (powerMouseV1)': readJSON(join(ctx.dir, 'package.json'))
			.version,
	};
	for (const name of [
		'express',
		'node-fetch',
		'ws',
		'html-minifier',
		'compression',
		'cookie-parser',
		'cookie',
		'body-parser',
		'mime',
		'serverline',
	])
		packages[name] = installed(name, ctx.dir);
	return {
		repo: REPO,
		ref: CONFIG.ref,
		sha: git('rev-parse', 'HEAD'),
		dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
		packages,
		node,
		transport: fill(CONFIG.transport.summary, { node }),
		config: CONFIG.notes.map((note) => fill(note, { node })),
	};
}

export async function assets(ctx) {
	return [
		['inject.js', 'client'],
		['windowURL.js', 'client'],
	]
		.map(([name, role]) => ({
			file: join(ctx.dir, 'public/pm-cgi', name),
			url: `/pm-cgi/${name}`,
			role,
		}))
		.filter((entry) => existsSync(entry.file));
}

export async function start(ctx, options = {}) {
	void options;
	const proxyPort = await ctx.freePort();
	// its working directory: config.json, urlData.json (it writes it) and the
	// files it opens by relative path (ssl/, ./server.js for its worker)
	const runDir = join(ctx.dir, '.bench-run', String(proxyPort));
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(runDir, { recursive: true });
	const config = readJSON(join(ctx.dir, 'config.json'));
	Object.assign(config, CONFIG.configJson.set, { port: proxyPort });
	writeFileSync(
		join(runDir, 'config.json'),
		`${JSON.stringify(config, null, '\t')}\n`,
	);
	writeFileSync(join(runDir, 'urlData.json'), '[]');
	symlinkSync(join(ctx.dir, 'ssl'), join(runDir, 'ssl'));
	symlinkSync(join(ctx.dir, 'server.js'), join(runDir, 'server.js'));
	symlinkSync(join(ctx.dir, 'urlManager.js'), join(runDir, 'urlManager.js'));
	// It proxies only hosts whose last label is on the public suffix list it
	// downloads at start, and the reserved .test the harness's fixture origins
	// use (*.bench.test) is not on it: a copy of app.js adds that one suffix,
	// so it can load the fixture pages every other row loads. Real sites see
	// the list unchanged.
	const appSource = readFileSync(join(ctx.dir, 'app.js'), 'utf8');
	const patched = appSource.replace(CONFIG.appPatch.from, CONFIG.appPatch.to);
	if (patched === appSource)
		throw new Error('app.js no longer has the suffix list line to extend');
	writeFileSync(join(runDir, 'app.js'), patched);

	const proxyOrigin = `http://${HOSTNAME}:${proxyPort}`;
	const logFile = join(ctx.logDir, `powermouse-v1-${proxyPort}.log`);
	const proc = startProcess(
		ctx.node,
		['--require', ctx.nodeDnsShim, join(runDir, 'app.js')],
		// PORT would override config.json's port (its Heroku support)
		{ logFile, cwd: runDir, env: CONFIG.run.env },
	);
	const cleanup = async () => {
		await proc.stop();
		rmSync(runDir, { recursive: true, force: true });
	};
	try {
		await Promise.race([
			// startup fetches its public IP and the public suffix list first
			waitForHttp(
				`${proxyOrigin}${CONFIG.run.readyPath}`,
				CONFIG.run.readyTimeoutMs,
			),
			proc.exit.then(({ code, signal }) => {
				throw new Error(
					`powerMouseV1 exited ${code ?? signal}, see ${logFile}`,
				);
			}),
		]);
	} catch (error) {
		await cleanup();
		throw error;
	}

	const app = express();
	app.disable('x-powered-by');
	app.use(headers(CONFIG.headers));
	app.get(
		'/bench-config.js',
		configScript({ proxyOrigin, home: CONFIG.navigation.home }),
	);
	app.use(
		'/',
		express.static(HOST, {
			setHeaders: (res) =>
				res.set('Cache-Control', CONFIG.cacheControl.default),
		}),
	);
	const server = createServer(app);
	try {
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(ctx.port, '127.0.0.1', resolve);
		});
	} catch (error) {
		await cleanup();
		throw error;
	}
	return {
		hostUrl: `http://${HOSTNAME}:${ctx.port}/`,
		origin: `http://${HOSTNAME}:${ctx.port}`,
		proxyOrigin,
		pids: [proc.pid],
		stop: async () => {
			await new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			});
			await cleanup();
		},
	};
}

export const hostDir = HOST;
