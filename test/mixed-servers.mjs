// The mixed-content suite's two sites, both on 127.0.0.1 (Chrome maps
// their names there with --host-resolver-rules, the demo's test transport,
// demo/public/test/mixed-transport.mjs, does the same):
//
// - mixed.test speaks TLS, with a self-signed certificate made at start
//   (Chrome takes it with --ignore-certificate-errors), and plain http on
//   the same port. The test transport reaches it in plain http for an
//   https URL, since epoxy takes no self-signed certificate: the page's
//   URL, which is what mixed content is decided by, is https either way.
// - plain.mixed.test speaks plain http only: an https load there (an
//   upgraded one) fails, natively and through the transport alike.
//
// Both serve test/pages and a few subresources, and log every request
// they get, so a suite can tell a load the browser blocked (it never
// arrives) from one it upgraded (it arrives at mixed.test) or let through.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHTTP } from 'node:http';
import { createServer as createHTTPS } from 'node:https';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const pagesDir = fileURLToPath(new URL('./pages/', import.meta.url));

/** a self-signed certificate for `name` (mixed.test), from the openssl CLI */
export function certificate(name = 'mixed.test') {
	const dir = mkdtempSync(join(tmpdir(), 'stomp-mixed-'));
	try {
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'2',
				'-subj',
				`/CN=${name}`,
				'-addext',
				`subjectAltName=DNS:${name}`,
			],
			{ stdio: 'ignore' },
		);
		return {
			key: readFileSync(join(dir, 'key.pem')),
			cert: readFileSync(join(dir, 'cert.pem')),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// a 1x1 PNG
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64',
);

/** a tenth of a second of silence as a WAV */
function wav() {
	const samples = 800;
	const buffer = Buffer.alloc(44 + samples * 2);
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + samples * 2, 4);
	buffer.write('WAVEfmt ', 8);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(8000, 24);
	buffer.writeUInt32LE(16000, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(samples * 2, 40);
	return buffer;
}
const WAV = wav();

const FILES = {
	'/img.png': ['image/png', PNG],
	'/tone.wav': ['audio/wav', WAV],
	'/s.js': ['text/javascript', 'self.__mixedScript = true;'],
	'/s.css': ['text/css', 'body { --mixed: 1; }'],
	'/import.css': ['text/css', '#imp { color: rgb(1, 2, 3); }'],
	'/import-up.css': ['text/css', '#imp-up { color: rgb(1, 2, 3); }'],
	'/data.txt': ['text/plain', 'mixed data'],
	'/t.vtt': ['text/vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nmixed\n'],
	'/frame.html': [
		'text/html; charset=utf-8',
		'<!doctype html><title>insecure frame</title><p>insecure frame</p>',
	],
};

/**
 * One listener for two servers: a connection that opens with a TLS record
 * goes to `secure`, anything else to its plain twin
 */
export function tlsOrPlain(secure, plain) {
	return createNet((socket) => {
		socket.on('error', () => {});
		// peeked without flowing: the server it goes to reads it again
		socket.once('readable', () => {
			const chunk = socket.read();
			if (!chunk) return socket.destroy();
			socket.unshift(chunk);
			(chunk[0] === 0x16 ? secure : plain).emit('connection', socket);
		});
	});
}

/**
 * Start both sites on free ports. `log` lists every request as
 * `{ server, path, c, method }` (`server` is `mixed` or `plain`, `c` the
 * case tag a fixture puts in the query, `method` `WebSocket` for a
 * handshake); `ports` are { https: mixed.test's, http: plain.mixed.test's }.
 */
export async function startMixedServers() {
	const log = [];
	const handler = (server) => (req, res) => {
		const url = new URL(req.url, 'http://mixed.test/');
		log.push({
			server,
			path: url.pathname,
			c: url.searchParams.get('c'),
			method: req.method,
		});
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('cache-control', 'no-store');
		if (url.pathname === '/events') {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end('data: hello\n\n');
			return;
		}
		if (url.pathname === '/beacon') {
			req.resume();
			res.end();
			return;
		}
		if (url.pathname.startsWith('/pages/')) {
			const name = url.pathname.slice('/pages/'.length);
			if (!/^[\w.-]+$/.test(name)) {
				res.writeHead(404).end();
				return;
			}
			let body;
			try {
				body = readFileSync(pagesDir + name, 'utf8');
			} catch (error) {
				res.writeHead(404).end();
				return;
			}
			const headers = {
				'content-type': name.endsWith('.js')
					? 'text/javascript; charset=utf-8'
					: 'text/html; charset=utf-8',
			};
			if (url.searchParams.has('uir'))
				headers['content-security-policy'] = 'upgrade-insecure-requests';
			// (which Chrome ignores in a report-only policy)
			if (url.searchParams.has('uirro'))
				headers['content-security-policy-report-only'] =
					'upgrade-insecure-requests';
			if (url.searchParams.has('bamc'))
				headers['content-security-policy'] = 'block-all-mixed-content';
			if (url.searchParams.has('uirmeta'))
				body = body.replace(
					'<!--META-->',
					'<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests" />',
				);
			res.writeHead(200, headers);
			res.end(body);
			return;
		}
		const file = FILES[url.pathname];
		if (!file) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'content-type': file[0] });
		res.end(file[1]);
	};
	const secure = createHTTPS(certificate(), handler('mixed'));
	const secureInPlain = createHTTP(handler('mixed'));
	const plain = createHTTP(handler('plain'));
	for (const [server, name] of [
		[secure, 'mixed'],
		[secureInPlain, 'mixed'],
		[plain, 'plain'],
	]) {
		const sockets = new WebSocketServer({ server });
		sockets.on('connection', (socket, req) => {
			const url = new URL(req.url, 'http://mixed.test/');
			log.push({
				server: name,
				path: url.pathname,
				c: url.searchParams.get('c'),
				method: 'WebSocket',
			});
			socket.close();
		});
	}
	// a TLS hello at the plain server (an upgraded load there) is no request
	plain.on('clientError', (error, socket) => socket.destroy());
	// mixed.test: TLS and plain http on one port
	const both = tlsOrPlain(secure, secureInPlain);
	const listen = (server) =>
		new Promise((resolve) =>
			server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
		);
	const ports = { https: await listen(both), http: await listen(plain) };
	return {
		log,
		ports,
		close() {
			for (const server of [secure, secureInPlain, plain])
				server.closeAllConnections?.();
			both.close();
			plain.close();
		},
	};
}
