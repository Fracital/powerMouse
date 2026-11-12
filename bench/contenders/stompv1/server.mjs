// stompV1's frontend server for the bench, run by adapter.mjs as a child
// process under ctx.node with the harness's DNS shim preloaded: the host page,
// the built bundles at /stomp/ and a Bare server at /bare/ on one origin,
// wired the way bare-server-node's README mounts it on an HTTP server. The
// mount points, Bare server options and the host page's /bench-config.js
// come from bench/configs/stompv1.json.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import express from 'express';
import { configScript, headers, loadConfig } from '../config.mjs';

const { BENCH_PORT, BENCH_DIST, BENCH_HOST, BENCH_BARE } = process.env;
const { createBareServer } = createRequire(import.meta.url)(BENCH_BARE);
const CONFIG = loadConfig('stompv1');

// blockLocal off: the shared holyWisp allows loopback and private addresses too
const bare = createBareServer(
	CONFIG.bareServer.mount,
	CONFIG.bareServer.options,
);

const app = express();
app.disable('x-powered-by');
app.use(headers(CONFIG.headers));
app.get(
	'/bench-config.js',
	configScript({ boot: CONFIG.boot, search: CONFIG.search }),
);
app.use(CONFIG.boot.directory, express.static(BENCH_DIST));
app.use('/', express.static(BENCH_HOST));

const server = createServer();
server.on('request', (req, res) => {
	if (bare.shouldRoute(req)) bare.routeRequest(req, res);
	else app(req, res);
});
server.on('upgrade', (req, socket, head) => {
	if (bare.shouldRoute(req)) bare.routeUpgrade(req, socket, head);
	else socket.end();
});
server.listen(Number(BENCH_PORT), '127.0.0.1', () =>
	console.log(
		`stompV1 frontend + Bare server on http://127.0.0.1:${BENCH_PORT}/`,
	),
);

const close = () => {
	server.closeAllConnections?.();
	server.close(() => {
		bare.close();
		process.exit(0);
	});
	setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
