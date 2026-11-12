// Ultraviolet (@titaniumnetwork-dev/ultraviolet 3.2.10 from npm, GitHub tag
// v3.2.10-headers), set up the way the official example app
// (titaniumnetwork-dev/Ultraviolet-App a1762248) does: its uv/uv.config.js
// (prefix /uv/service/, xor codec) over the package's dist at /uv/, the stock
// /uv/sw.js registered from the host page, a bare-mux connection whose
// SharedWorker runs @mercuryworkshop/epoxy-transport (the bare-mux 2.x line,
// the exact version the app pins) pointed at the shared holyWisp, the
// cross-origin isolation headers the app's server sends on every response,
// and `__uv$config.prefix + __uv$config.encodeUrl(url)` as the iframe's src.
// The pins, uv.config.js values, transport, headers and notes come from
// bench/configs/ultraviolet.json; uv.config.js is generated from it.
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { configScript, headers, loadConfig, withWisp } from '../config.mjs';

export const id = 'ultraviolet';

const CONFIG = loadConfig(id);

export const rows = CONFIG.rows;

const HOST = fileURLToPath(new URL('./host/', import.meta.url));

// Ultraviolet-App a1762248 package.json + pnpm-lock.yaml
const APP = CONFIG.app;
const NPM = CONFIG.npm;

const pkgDir = (ctx) => join(ctx.dir, 'pkg');
const modules = (ctx) => join(pkgDir(ctx), 'node_modules');
const dist = (ctx, name) => join(modules(ctx), name, 'dist');
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** the app's public/uv/uv.config.js, from the config's uvConfig */
function uvConfigSource() {
	const { codec, ...paths } = CONFIG.uvConfig;
	const quote = (value) => {
		if (/['\\\n]/.test(value)) throw new Error(`uvConfig: ${value}`);
		return `'${value}'`;
	};
	const codecName = /^\w+$/.test(codec) ? codec : quote(codec);
	const { prefix, ...files } = paths;
	return [
		"// Ultraviolet-App's public/uv/uv.config.js (it overwrites the stock config)",
		'',
		'self.__uv$config = {',
		`\tprefix: ${quote(prefix)},`,
		`\tencodeUrl: Ultraviolet.codec.${codecName}.encode,`,
		`\tdecodeUrl: Ultraviolet.codec.${codecName}.decode,`,
		...Object.entries(files).map(
			([key, value]) => `\t${key}: ${quote(value)},`,
		),
		'};',
		'',
	].join('\n');
}

/** writes the generated host files under pkg/generated/; returns that dir */
function generated(ctx) {
	const dir = join(pkgDir(ctx), 'generated');
	const file = join(dir, CONFIG.uvConfig.config);
	mkdirSync(dirname(file), { recursive: true });
	const source = uvConfigSource();
	if (!existsSync(file) || readFileSync(file, 'utf8') !== source)
		writeFileSync(file, source);
	return dir;
}

/** throws unless the installed packages have the integrity the config pins */
function checkIntegrity(ctx) {
	const lock = readJSON(join(modules(ctx), '.package-lock.json'));
	for (const [name, integrity] of Object.entries(CONFIG.integrity)) {
		const entry = Object.entries(lock.packages).find(([path]) =>
			path.endsWith(`node_modules/${name}`),
		)?.[1];
		if (entry?.integrity !== integrity)
			throw new Error(
				`ultraviolet: ${name} installed with ${entry?.integrity}, bench/configs/ultraviolet.json pins ${integrity}`,
			);
	}
}

export async function setup(ctx) {
	const dir = pkgDir(ctx);
	const done = Object.keys(NPM).every((name) => {
		try {
			return (
				readJSON(join(modules(ctx), name, 'package.json')).version === NPM[name]
			);
		} catch {
			return false;
		}
	});
	if (done) return;
	mkdirSync(dir, { recursive: true });
	// keep the clone's git status clean
	if (existsSync(join(ctx.dir, '.git/info'))) {
		const exclude = join(ctx.dir, '.git/info/exclude');
		const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
		if (!/^\/pkg\/$/m.test(text))
			writeFileSync(exclude, `${text.replace(/\n?$/, '\n')}/pkg/\n`);
	}
	writeFileSync(
		join(dir, 'package.json'),
		`${JSON.stringify(
			{ name: 'bench-ultraviolet', private: true, dependencies: NPM },
			null,
			'\t',
		)}\n`,
	);
	execFileSync(
		'npm',
		['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'],
		{ cwd: dir, stdio: 'inherit', timeout: 600000 },
	);
	checkIntegrity(ctx);
}

function installed(ctx) {
	const lock = readJSON(join(modules(ctx), '.package-lock.json'));
	const packages = {};
	for (const [path, entry] of Object.entries(lock.packages)) {
		const name = path.replace(/^(.*\/)?node_modules\//, '');
		if (/^@(mercuryworkshop|titaniumnetwork-dev)\//.test(name))
			packages[path.includes('/node_modules/', 13) ? path : name] =
				`${entry.version} (${entry.integrity})`;
	}
	return packages;
}

export async function describe(ctx) {
	const packages = installed(ctx);
	const uv = readJSON(
		join(modules(ctx), '@titaniumnetwork-dev/ultraviolet/package.json'),
	);
	return {
		repo: 'https://github.com/titaniumnetwork-dev/Ultraviolet',
		ref: CONFIG.ref,
		sha: `npm @titaniumnetwork-dev/ultraviolet@${uv.version} ${packages['@titaniumnetwork-dev/ultraviolet']?.match(/\((.*)\)/)?.[1]}`,
		app: APP,
		packages,
		transport: CONFIG.transport.summary,
		config: CONFIG.notes,
	};
}

export async function assets(ctx) {
	const uv = dist(ctx, '@titaniumnetwork-dev/ultraviolet');
	const list = [
		{ file: join(uv, 'sw.js'), url: '/uv/sw.js', role: 'sw' },
		{ file: join(uv, 'uv.sw.js'), url: '/uv/uv.sw.js', role: 'sw' },
		{
			file: join(uv, 'uv.bundle.js'),
			url: '/uv/uv.bundle.js',
			role: 'rewriter',
		},
		{
			file: join(generated(ctx), CONFIG.uvConfig.config),
			url: CONFIG.uvConfig.config,
			role: 'other',
		},
		{
			file: join(uv, 'uv.handler.js'),
			url: '/uv/uv.handler.js',
			role: 'client',
		},
		{ file: join(uv, 'uv.client.js'), url: '/uv/uv.client.js', role: 'client' },
		{
			file: join(dist(ctx, '@mercuryworkshop/bare-mux'), 'index.js'),
			url: '/baremux/index.js',
			role: 'transport',
		},
		{
			file: join(dist(ctx, '@mercuryworkshop/bare-mux'), 'worker.js'),
			url: '/baremux/worker.js',
			role: 'transport',
		},
		{
			file: join(dist(ctx, '@mercuryworkshop/epoxy-transport'), 'index.mjs'),
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
	const app = express();
	app.disable('x-powered-by');
	// the app's server sets these on every response
	app.use(headers(CONFIG.headers));
	const fresh = {
		setHeaders: (res) => res.set('Cache-Control', CONFIG.cacheControl.default),
	};
	const { transport } = CONFIG;
	app.get(
		'/bench-config.js',
		configScript({
			wisp: ctx.wispUrl,
			serviceWorker: CONFIG.serviceWorker.path,
			mux: transport.mux,
			transport: transport.module,
			transportOptions: withWisp(transport.options, ctx.wispUrl),
		}),
	);
	// the app's order: its public/ first (uv/uv.config.js shadows the stock one)
	app.use(express.static(generated(ctx), fresh));
	app.use(express.static(HOST, fresh));
	app.use(
		'/uv/',
		express.static(dist(ctx, '@titaniumnetwork-dev/ultraviolet'), fresh),
	);
	app.use(
		'/epoxy/',
		express.static(dist(ctx, '@mercuryworkshop/epoxy-transport'), fresh),
	);
	app.use(
		'/baremux/',
		express.static(dist(ctx, '@mercuryworkshop/bare-mux'), fresh),
	);
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
