// Wisp's carrier (TransportDescriptor.webTransport, wispWebTransport.ts)
// with the epoxy build a host serves, not only the one STomp pins: SystemYA
// configures STomp with `webTransport: true`, `http3: { module }` and a wisp
// relay on another host than its page, and serves Fracital's epoxy build
// e2a70d6 (devDependency epoxy-transport-e2a70d6), which has no
// epoxy-tls 0075. There every page hung on both carriers once a transport
// handed epoxy the carrier as its function transport: that build's sink
// waited on the stream's promises while holding wisp-mux's lock, so a TLS
// handshake with any request beside it held every stream of the connection
// (example.com, GitHub and Wikipedia, 4.2.0-nightly.202611190550). The
// carrier's sink settles its writer's promises as they are returned
// (src/transport/promptSink.ts), which every build writes through without
// waiting.
//
// For each build (that one, and the pinned one), in the transport worker and
// in the page, over the session (test/wisp-wt.mjs in front of the demo's
// holyWisp) and over the WebSocket (the relay's UDP blocked): a TLS request
// to a host the wisp server refuses, a plain request and a frame's
// navigation, started together, answer (the TLS one failing), and a
// request answers after them.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, launch, ok, PORT, PROXY } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';

const TIMEOUT_MS = 8000;
const CARRIER_MS = 1500;

// the builds' dist/ directories, served with CORS (the transport worker and
// the page import the module from here, stomp-h3 and epoxy.wasm beside it)
const BUILDS = {
	pinned: '@mercuryworkshop/epoxy-transport',
	e2a70d6: 'epoxy-transport-e2a70d6',
};
const dist = (pkg) =>
	fileURLToPath(new URL(`../../node_modules/${pkg}/dist/`, import.meta.url));
const TYPES = {
	'.mjs': 'text/javascript',
	'.js': 'text/javascript',
	'.wasm': 'application/wasm',
};
const files = createServer(async (req, res) => {
	const [, build, ...rest] = new URL(req.url, 'http://x').pathname.split('/');
	const path = normalize(rest.join('/'));
	if (!(build in BUILDS) || path.startsWith('..')) {
		res.writeHead(404).end();
		return;
	}
	try {
		const body = await readFile(join(dist(BUILDS[build]), path));
		res
			.writeHead(200, {
				'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
				'access-control-allow-origin': '*',
				'cache-control': 'no-store',
			})
			.end(body);
	} catch {
		res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
	}
});
await new Promise((resolve) => files.listen(0, '127.0.0.1', resolve));
// another host than the page's (127.0.0.1), as SystemYA's relay is
const filesBase = `http://localhost:${files.address().port}/`;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const wisp = relay.wisp.replace('127.0.0.1', 'localhost');

const browser = await launch();
const errors = [];

for (const build of Object.keys(BUILDS)) {
	for (const host of ['worker', 'page']) {
		for (const carrier of ['webtransport', 'websocket']) {
			relay.udpBlocked = carrier === 'websocket';
			const context = await browser.newContext();
			const page = await context.newPage();
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(`${PROXY}stomp/controllerFrame.html`);
			const result = await page.evaluate(
				async ({ module, h3, wisp, host, fixture, carrierMs, timeoutMs }) => {
					const { StompController } = await import('/stomp/controller.mjs');
					const registration = await StompController.register('/stomp/');
					const controller = new StompController({
						serviceworker: registration,
						transport: {
							module,
							options: [{ wisp }],
							host,
							http3: { module: h3 },
							webTransport: { timeoutMs: carrierMs },
						},
						directory: '/stomp/',
						codec: 'xor',
					});
					await controller.wait();
					if (!controller.transport.ready) await controller.transport.init();
					for (let i = 0; i < 60 && !controller.carrier; i++)
						await new Promise((resolve) => setTimeout(resolve, 50));
					const element = document.createElement('iframe');
					document.body.append(element);
					const frame = controller.createFrame(element);
					const hung = () =>
						new Promise((resolve) =>
							setTimeout(() => resolve('HUNG'), timeoutMs),
						);
					const settle = (promise) =>
						Promise.race([promise, hung()]).catch(() => 'failed');
					const get = (url) =>
						settle(
							controller.transport
								.request(new URL(url), 'GET', null, [], undefined)
								.then(async (r) => {
									await new Response(r.body).arrayBuffer();
									return `status ${r.status}`;
								}),
						);
					const together = await Promise.all([
						get('https://a.refused.invalid/'),
						get(`${fixture}pages/walk-2.html?beside-tls`),
						settle(
							frame
								.go(`${fixture}pages/walk-1.html`)
								.then(() => element.contentDocument?.title ?? 'no document'),
						),
					]);
					const after = await get(`${fixture}pages/walk-3.html?after-tls`);
					return {
						carrier: controller.carrier?.carrier ?? null,
						together,
						after,
					};
				},
				{
					module: `${filesBase}${build}/index.mjs`,
					h3: `${filesBase}${build}/h3/stomp_h3.js`,
					wisp,
					host,
					fixture: FIXTURE,
					carrierMs: CARRIER_MS,
					timeoutMs: TIMEOUT_MS,
				},
			);
			const name = `epoxy ${build}, transport in the ${host}, over the ${carrier}`;
			ok(`${name}: rides it`, result.carrier === carrier, result.carrier);
			ok(
				`${name}: a refused TLS request, a plain one and a navigation started together answer`,
				JSON.stringify(result.together) ===
					JSON.stringify(['failed', 'status 200', 'WALK 1']),
				JSON.stringify(result.together),
			);
			ok(
				`${name}: a request after them answers`,
				result.after === 'status 200',
				result.after,
			);
			await context.close();
		}
	}
}

relay.udpBlocked = false;
await relay.close();
files.close();
await done(browser, errors);
