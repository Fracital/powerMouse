// Epoxy's SIMD128 build (epoxy-simd.wasm, EpoxyTransport 0062) is only
// faster: when it cannot be had, the transport opens on epoxy.wasm. SystemYA
// vendors the package under stamped names and shipped epoxy.wasm but not
// epoxy-simd.wasm; the SIMD fetch got a 404, every init() failed and no
// request went out (2026-11-20) until EpoxyTransport 0063 took epoxy.wasm
// when the SIMD module does not load.
//
// The pinned build's dist/ is served from a server of its own, with
// epoxy-simd.wasm there, answering 404, answering 200 with an HTML page (a
// host's fallback route), or dropping the connection (as a fetch refused by
// a policy fails), for the transport in the worker and in the page. Each
// time a request through it answers, which opens a Wisp stream, and the
// server saw epoxy.wasm asked for only when epoxy-simd.wasm did not load.
// A Chrome whose V8 has no SSE4.1 (`--no-enable-sse4-1`, as on a "Common
// KVM processor") refuses SIMD128: there the module asks for epoxy.wasm
// alone.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const TIMEOUT_MS = 10000;
const SIMD = 'epoxy-simd.wasm';
const BASE = 'epoxy.wasm';
const dist = fileURLToPath(
	new URL(
		'../../node_modules/@mercuryworkshop/epoxy-transport/dist/',
		import.meta.url,
	),
);
// the dist/ served is node_modules'; a checkout whose install is older than
// package-lock.json serves a build without the fallback, and every check
// below then fails on a wasm magic word, which names nothing
const PACKAGE = 'node_modules/@mercuryworkshop/epoxy-transport';
const lockEntry = (file) =>
	readFile(new URL(file, import.meta.url), 'utf8').then(
		(text) => JSON.parse(text).packages?.[PACKAGE],
		() => undefined,
	);
const pinned = await lockEntry('../../package-lock.json');
const installed = await lockEntry('../../node_modules/.package-lock.json');
ok(
	'the installed epoxy-transport is the one package-lock.json pins',
	pinned !== undefined &&
		installed?.resolved === pinned.resolved &&
		installed?.integrity === pinned.integrity,
	`installed ${installed?.resolved ?? 'none'}, pinned ${pinned?.resolved} (npm ci)`,
);

const TYPES = {
	'.mjs': 'text/javascript',
	'.js': 'text/javascript',
	'.wasm': 'application/wasm',
};
const CORS = {
	'access-control-allow-origin': '*',
	'cache-control': 'no-store',
};

/** what epoxy-simd.wasm is answered with, by the first path segment */
const SIMD_ANSWERS = {
	served: null,
	missing: (res) => res.writeHead(404, CORS).end('Not Found'),
	html: (res) =>
		res
			.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8' })
			.end('<!doctype html><title>Home</title><div id="app"></div>'),
	refused: (res) => res.socket.destroy(),
};

/** the wasm files each run asked for, in order */
const asked = new Map();
const files = createServer(async (req, res) => {
	const [, run, ...rest] = new URL(req.url, 'http://x').pathname.split('/');
	const path = normalize(rest.join('/'));
	const [answers] = run.split('.');
	if (!(answers in SIMD_ANSWERS) || path.startsWith('..')) {
		res.writeHead(404, CORS).end();
		return;
	}
	if (path.endsWith('.wasm')) {
		if (!asked.has(run)) asked.set(run, []);
		asked.get(run).push(path);
	}
	if (path === SIMD && SIMD_ANSWERS[answers]) {
		SIMD_ANSWERS[answers](res);
		return;
	}
	try {
		const body = await readFile(join(dist, path));
		res
			.writeHead(200, {
				...CORS,
				'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
			})
			.end(body);
	} catch {
		res.writeHead(404, CORS).end();
	}
});
await new Promise((resolve) => files.listen(0, '127.0.0.1', resolve));
// another origin than the page's, as a host's CDN is
const filesBase = `http://localhost:${files.address().port}/`;

const errors = [];

/** a controller on the build under `run`; a request through it */
async function open(browser, run, host) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	try {
		return await page.evaluate(
			async ({ module, host, fixture, timeoutMs }) => {
				const { StompController } = await import('/stomp/controller.mjs');
				const registration = await StompController.register('/stomp/');
				const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
				const controller = new StompController({
					serviceworker: registration,
					transport: { module, options: [{ wisp }], host },
					directory: '/stomp/',
					codec: 'xor',
				});
				const hung = new Promise((resolve) =>
					setTimeout(() => resolve('HUNG'), timeoutMs),
				);
				const answer = (async () => {
					await controller.wait();
					if (!controller.transport.ready) await controller.transport.init();
					const response = await controller.transport.request(
						new URL(`${fixture}pages/walk-1.html?simd`),
						'GET',
						null,
						[],
						undefined,
					);
					const text = await new Response(response.body).text();
					return `status ${response.status}${text.includes('WALK 1') ? ', WALK 1' : ''}`;
				})().catch((error) => `failed: ${String(error).slice(0, 200)}`);
				return await Promise.race([answer, hung]);
			},
			{
				module: `${filesBase}${run}/index.mjs`,
				host,
				fixture: FIXTURE,
				timeoutMs: TIMEOUT_MS,
			},
		);
	} finally {
		await context.close();
	}
}

const ANSWERED = 'status 200, WALK 1';
let browser = await launch();
for (const answers of Object.keys(SIMD_ANSWERS)) {
	for (const host of ['worker', 'page']) {
		const run = `${answers}.${host}`;
		const result = await open(browser, run, host);
		// Chrome sends a request again once when its connection is dropped
		// before an answer: one fetch, so a repeat counts once
		const wasm = (asked.get(run) ?? []).filter(
			(path, i, all) => answers !== 'refused' || path !== all[i - 1],
		);
		const name = `epoxy-simd.wasm ${answers}, transport in the ${host}`;
		ok(`${name}: a request answers`, result === ANSWERED, result);
		ok(
			`${name}: ${answers === 'served' ? 'only epoxy-simd.wasm is asked for' : 'epoxy.wasm is asked for after it'}`,
			JSON.stringify(wasm) ===
				JSON.stringify(answers === 'served' ? [SIMD] : [SIMD, BASE]),
			JSON.stringify(wasm),
		);
	}
}
await browser.close();

// V8 refuses SIMD128 without SSE4.1; WebAssembly.validate says so
browser = await launch(['--js-flags=--no-enable-sse4-1']);
{
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	const simd = await page.evaluate(() =>
		WebAssembly.validate(
			new Uint8Array([
				0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
				1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
			]),
		),
	);
	ok('without SSE4.1 the engine refuses SIMD128', simd === false, simd);
	await context.close();
}
for (const host of ['worker', 'page']) {
	const run = `served.nosse41-${host}`;
	const result = await open(browser, run, host);
	const wasm = asked.get(run) ?? [];
	const name = `no SIMD128, transport in the ${host}`;
	ok(`${name}: a request answers`, result === ANSWERED, result);
	ok(
		`${name}: only epoxy.wasm is asked for`,
		JSON.stringify(wasm) === JSON.stringify([BASE]),
		JSON.stringify(wasm),
	);
}

files.close();
await done(browser, errors);
