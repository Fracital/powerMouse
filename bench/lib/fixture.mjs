// The local fixture server, reached as http://<name>.bench.test:<port>/ (any
// name under .bench.test is the same server; the names make origins). It
// serves bench/fixtures/ as static files, plus the dynamic routes that a
// fixture area exports from bench/fixtures/<area>/routes.mjs:
//   export function handle(req, res, ctx) -> true when it answered
//   export function upgrade(req, socket, head, ctx) -> true when it took the socket
// Every request is appended to `log` ({ t, method, host, url, headers }).
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

export const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.woff2': 'font/woff2',
};

export function sendFile(res, file, headers = {}) {
	res.writeHead(200, {
		'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
		'Content-Length': statSync(file).size,
		'Cache-Control': 'no-store',
		...headers,
	});
	createReadStream(file).pipe(res);
}

/** starts the server; ctx is handed to the routes (cacheDir, scripts, ports...) */
export async function startFixture({ port, ctx = {} }) {
	const areas = [];
	for (const area of readdirSync(ROOT)) {
		const routes = join(ROOT, area, 'routes.mjs');
		if (existsSync(routes)) areas.push(await import(routes));
	}
	const log = [];
	let bytesOut = 0;
	const server = createServer(async (req, res) => {
		// every body byte this server sends, for the bytes-per-load figures
		const write = res.write;
		const end = res.end;
		res.write = function (chunk, ...rest) {
			if (chunk && typeof chunk !== 'function')
				bytesOut += Buffer.byteLength(chunk);
			return write.call(this, chunk, ...rest);
		};
		res.end = function (chunk, ...rest) {
			if (chunk && typeof chunk !== 'function')
				bytesOut += Buffer.byteLength(chunk);
			return end.call(this, chunk, ...rest);
		};
		log.push({
			t: Date.now(),
			method: req.method,
			host: req.headers.host,
			url: req.url,
			headers: req.headers,
		});
		try {
			for (const area of areas)
				if (area.handle && (await area.handle(req, res, ctx))) return;
			const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
			let file = normalize(join(ROOT, path));
			if (!file.startsWith(ROOT)) {
				res.writeHead(403).end();
				return;
			}
			if (existsSync(file) && statSync(file).isDirectory())
				file = join(file, 'index.html');
			if (!existsSync(file) || file.endsWith('routes.mjs')) {
				res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
				return;
			}
			sendFile(res, file);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500);
			res.end(String(error));
		}
	});
	server.on('upgrade', (req, socket, head) => {
		log.push({
			t: Date.now(),
			method: 'UPGRADE',
			host: req.headers.host,
			url: req.url,
			headers: req.headers,
		});
		for (const area of areas)
			if (area.upgrade && area.upgrade(req, socket, head, ctx)) return;
		socket.destroy();
	});
	await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
	return {
		port,
		log,
		bytesOut: () => bytesOut,
		url: (name = 'a', path = '/') => `http://${name}.bench.test:${port}${path}`,
		stop: () => new Promise((resolve) => server.close(resolve)),
	};
}
