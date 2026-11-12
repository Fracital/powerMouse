// STomp, this repository's checkout (its dist/, so run `npm run build`
// first), set up the way its demo is (demo/README.md, demo/public/pm/main.js).
// Everything about the setup (service worker, controller options, transport,
// headers, rows, what each row downloads) comes from bench/configs/stomp.json:
// the same-origin StompController the demo runs when opened on 127.0.0.1, the
// service worker at /stomp/ with that scope, the xor codec, its HTTP cache
// and emulated service workers on, the epoxy build package.json pins as a
// transport descriptor (run in the transport worker) with HTTP/3 on and
// Cloudflare DoH for ECH, and the cross-origin isolation headers the demo
// server sends by default. The rows differ only in the rewriter backend and
// the content blocker, which is on by default.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { configScript, headers, loadConfig, withWisp } from '../config.mjs';

export const id = 'stomp';

const CONFIG = loadConfig(id);

export const rows = CONFIG.rows;

const HOST = fileURLToPath(new URL('./host/', import.meta.url));

const transportPackage = CONFIG.transport.package;
// where the host serves the transport package's dist/ (/epoxy/)
const TRANSPORT_PATH = CONFIG.transport.module.replace(/[^/]*$/, '');
const transportDir = (repoRoot) =>
	join(repoRoot, 'node_modules', transportPackage, 'dist');

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** the row's options as the controller sees them (defaults filled in) */
const effective = (options = {}) => ({
	rewriter: options.rewriter === 'wasm' ? 'wasm' : 'js',
	adblock: options.adblock !== false,
});

export async function setup(ctx) {
	statSync(join(ctx.repoRoot, CONFIG.build.check));
	const pkg = readJSON(join(ctx.repoRoot, 'package.json'));
	for (const [name, spec] of Object.entries(CONFIG.packages)) {
		const pinned =
			pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
		if (pinned !== spec)
			throw new Error(
				`package.json pins ${name} at ${pinned}, bench/configs/stomp.json says ${spec}`,
			);
	}
}

export async function describe(ctx) {
	const git = (...args) =>
		execFileSync('git', ['-C', ctx.repoRoot, ...args], {
			encoding: 'utf8',
		}).trim();
	const pkg = readJSON(join(ctx.repoRoot, 'package.json'));
	const epoxy = readJSON(
		join(ctx.repoRoot, 'node_modules', transportPackage, 'package.json'),
	);
	const dirty = git('status', '--porcelain', '--', 'src', 'dist').length > 0;
	return {
		repo: CONFIG.repo,
		ref: git('rev-parse', '--abbrev-ref', 'HEAD'),
		sha: git('rev-parse', 'HEAD'),
		dirty,
		packages: {
			'@sysce/stomp': pkg.version,
			[transportPackage]: `${epoxy.version} (${pkg.dependencies?.[transportPackage] ?? pkg.devDependencies?.[transportPackage]})`,
		},
		transport: CONFIG.transport.summary,
		config: CONFIG.notes,
	};
}

/** what the row's browser downloads for the proxy machinery (configs: assets) */
export async function assets(ctx, options = {}) {
	const rules = CONFIG.assets;
	const row = effective(options);
	const dist = join(ctx.repoRoot, 'dist');
	const directory = CONFIG.controller.directory;
	const list = [];
	for (const name of readdirSync(dist).sort()) {
		if (!['.js', '.mjs', '.wasm', '.html'].includes(extname(name))) continue;
		if (name in rules.exclude) continue;
		const only = rules.only[name];
		if (
			only &&
			!Object.entries(only).every(([key, value]) => row[key] === value)
		)
			continue;
		list.push({
			file: join(dist, name),
			url: `${directory}${name}`,
			role: rules.roles[name] ?? rules.roles['*'],
		});
	}
	const transport = transportDir(ctx.repoRoot);
	const transportFiles = [
		...rules.transport.always,
		...(CONFIG.transport.http3 ? rules.transport.http3 : []),
	];
	for (const name of transportFiles)
		list.push({
			file: join(transport, name),
			url: `${TRANSPORT_PATH}${name}`,
			role: 'transport',
		});
	return list.filter((entry) => {
		try {
			return statSync(entry.file).isFile();
		} catch {
			return false;
		}
	});
}

export async function start(ctx, options = {}) {
	const dist = join(ctx.repoRoot, 'dist');
	const { cacheControl } = CONFIG;
	const app = express();
	app.disable('x-powered-by');
	// the demo server's default cross-origin isolation headers
	app.use(headers(CONFIG.headers));
	const fresh = {
		setHeaders: (res) => res.set('Cache-Control', cacheControl.default),
	};
	// the demo serves the rewriter library immutable when asked for by hash
	let libraryHash = '';
	try {
		libraryHash = createHash('sha256')
			.update(readFileSync(join(dist, 'rewriterLib.js')))
			.digest('hex')
			.slice(0, 16);
	} catch {
		// no library in this build
	}
	app.use(
		CONFIG.controller.directory,
		express.static(dist, {
			setHeaders: (res, path) =>
				res.set(
					'Cache-Control',
					basename(path) === 'rewriterLib.js' &&
						res.req.originalUrl.endsWith(`?${libraryHash}`)
						? cacheControl.rewriterLibByHash
						: cacheControl.default,
				),
		}),
	);
	app.use(TRANSPORT_PATH, express.static(transportDir(ctx.repoRoot), fresh));
	const row = effective(options);
	const { controller, transport } = CONFIG;
	app.get(
		'/bench-config.js',
		configScript({
			wisp: ctx.wispUrl,
			rewriter: row.rewriter === 'wasm' ? 'wasm' : '',
			adblock: row.adblock,
			frameAllow: CONFIG.frameAllow,
			// StompController's options but the service worker registration
			controller: {
				transport: {
					module: transport.module,
					options: withWisp(transport.options, ctx.wispUrl),
					...(transport.http3 && { http3: true }),
				},
				directory: controller.directory,
				codec: controller.codec,
				cache: controller.cache,
				serviceWorkers: controller.serviceWorkers,
				...(row.rewriter === 'wasm' && { rewriter: 'wasm' }),
				...(row.adblock ? {} : { adblock: false }),
			},
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
