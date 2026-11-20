// The sync relay: POST /stomp/sync-relay performs one HTTP request for a
// proxied page and answers with the whole response as JSON.
//
// It exists for WebKit. While a page there blocks in a synchronous
// XMLHttpRequest, every actor of its process waits for the page's main
// thread: the service worker, the page's workers, their fetches, IndexedDB,
// WebSockets and MessagePorts. A synchronous XHR goes straight to the
// network there (the service worker never sees it), so nothing the page's
// browser runs can answer it, and the host server is the one thing left.
// The inject sends such a request here, as a synchronous XHR of its own.
//
// The host does TLS for these requests itself, so it sees them in the clear.
// What leaves this process still goes through the Wisp relay the browser
// uses (the built-in holyWisp, or STOMP_WISP_URL), never a socket of Node's
// own, so the relay's rules about which hosts may be reached hold here too.
//
// Request (JSON, any content type, at most 16 MiB):
//   { url, method, headers: [[name, value], ...], body?: base64,
//     redirect: 'follow' | 'manual' | 'error' }
// Answer (always 200, no-store):
//   { status, statusText, url, redirected, headers: [[name, value], ...],
//     body: base64, cookies: [[url, setCookie], ...] }
// or { error } for a network error. `headers` are the final response's as
// received, names lower-cased; `body` is decoded (gzip, deflate, br, zstd);
// `cookies` holds every Set-Cookie of every hop with the URL that sent it.
// No cookie is added between hops: the page keeps its own jar.
import { Buffer } from 'node:buffer';
import { request } from 'node:http';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import zlib from 'node:zlib';
import express from 'express';

const LIMIT = 16 * 1024 * 1024;
const TIMEOUT = 25000;
const MAX_REDIRECTS = 20;
// epoxy's packet size: well under holyWisp's message limit
const PACKET = 64 * 1024;
// a Wisp WebSocket with no stream open is closed after this long
const IDLE = 30000;

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const VOLUNTARY = 0x02;
const REASONS = {
	0x01: 'unspecified reason',
	0x03: 'network error',
	0x41: 'invalid stream',
	0x42: 'unreachable host',
	0x43: 'no response',
	0x44: 'connection refused',
	0x47: 'timed out',
	0x48: 'blocked destination',
	0x49: 'throttled',
	0x81: 'client error',
};

function packet(type, id, payload) {
	const bytes = new Uint8Array(5 + payload.length);
	bytes[0] = type;
	new DataView(bytes.buffer).setUint32(1, id, true);
	bytes.set(payload, 5);
	return bytes;
}

/** one Wisp TCP stream as a Duplex */
class WispStream extends Duplex {
	constructor(connection, id, credit) {
		super();
		this.connection = connection;
		this.id = id;
		this.credit = credit;
		this.received = false;
		this.wispClosed = false;
		this.waiting = null;
	}
	_write(chunk, encoding, callback) {
		this.sendFrom(chunk, 0, callback);
	}
	// never more packets than the last CONTINUE allowed
	sendFrom(chunk, offset, callback) {
		while (offset < chunk.length) {
			if (this.wispClosed) return callback(new Error('the Wisp stream closed'));
			if (this.credit <= 0) {
				this.waiting = () => this.sendFrom(chunk, offset, callback);
				return;
			}
			const piece = chunk.subarray(offset, offset + PACKET);
			this.connection.send(packet(DATA, this.id, piece));
			this.credit--;
			offset += piece.length;
		}
		callback();
	}
	_read() {}
	// Wisp has no half close: the request's end leaves the stream open for
	// the response
	_final(callback) {
		callback();
	}
	_destroy(error, callback) {
		if (!this.wispClosed) {
			this.wispClosed = true;
			this.connection.send(packet(CLOSE, this.id, Uint8Array.of(VOLUNTARY)));
		}
		this.connection.streams.delete(this.id);
		this.connection.idleCheck();
		callback(error);
	}
	onData(payload) {
		this.received = true;
		this.push(payload);
	}
	onContinue(credit) {
		this.credit = credit;
		const waiting = this.waiting;
		this.waiting = null;
		waiting?.();
	}
	// the server's CLOSE: a refusal before any data is a network error;
	// after data the HTTP parser judges what arrived
	onClose(reason) {
		this.wispClosed = true;
		this.connection.streams.delete(this.id);
		this.connection.idleCheck();
		if (!this.received && reason !== VOLUNTARY)
			this.destroy(
				new Error(
					`the Wisp relay refused the connection (${REASONS[reason] ?? `reason 0x${reason.toString(16)}`})`,
				),
			);
		else {
			this.push(null);
			this.waiting?.();
		}
	}
}

/** one Wisp v1 WebSocket that carries many streams */
class WispConnection {
	constructor(url, onGone) {
		this.streams = new Map();
		this.nextId = 1;
		this.credit = 0;
		this.onGone = onGone;
		this.idleTimer = null;
		this.socket = new WebSocket(url);
		this.socket.binaryType = 'arraybuffer';
		// open once the server's first CONTINUE (stream 0) says its buffer
		this.ready = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.ready.catch(() => {});
		this.socket.addEventListener('message', (event) =>
			this.onMessage(new Uint8Array(event.data)),
		);
		const gone = () => this.gone(new Error('the Wisp relay closed'));
		this.socket.addEventListener('close', gone);
		this.socket.addEventListener('error', gone);
	}
	gone(error) {
		if (this.dead) return;
		this.dead = true;
		clearTimeout(this.idleTimer);
		this.onGone(this);
		this.rejectReady(error);
		for (const stream of this.streams.values()) {
			stream.wispClosed = true;
			stream.destroy(error);
		}
		this.streams.clear();
		try {
			this.socket.close();
		} catch {
			// already closing
		}
	}
	send(bytes) {
		if (!this.dead) this.socket.send(bytes);
	}
	onMessage(bytes) {
		if (bytes.length < 5) return;
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		const type = bytes[0];
		const id = view.getUint32(1, true);
		const payload = bytes.subarray(5);
		if (type === CONTINUE && payload.length >= 4) {
			const credit = view.getUint32(5, true);
			if (id === 0) {
				this.credit = credit;
				this.resolveReady();
			} else this.streams.get(id)?.onContinue(credit);
		} else if (type === DATA)
			this.streams.get(id)?.onData(Buffer.from(payload));
		else if (type === CLOSE) this.streams.get(id)?.onClose(payload[0] ?? 0x01);
		// (an INFO of Wisp v2, or anything else, is not for a v1 client)
	}
	/** a TCP stream to host:port */
	open(host, port) {
		if (this.nextId > 0xffffffff) this.gone(new Error('stream ids used up'));
		const id = this.nextId++;
		const stream = new WispStream(this, id, this.credit);
		this.streams.set(id, stream);
		clearTimeout(this.idleTimer);
		const name = new TextEncoder().encode(host);
		const payload = new Uint8Array(3 + name.length);
		payload[0] = 0x01;
		new DataView(payload.buffer).setUint16(1, port, true);
		payload.set(name, 3);
		this.send(packet(CONNECT, id, payload));
		return stream;
	}
	idleCheck() {
		clearTimeout(this.idleTimer);
		if (this.streams.size || this.dead) return;
		this.idleTimer = setTimeout(
			() => this.gone(new Error('idle')),
			IDLE,
		).unref();
	}
}

/** the Wisp relay at `wispUrl()`: one WebSocket, made again when it closes */
function wispClient(wispUrl) {
	let connection = null;
	return async (host, port, signal) => {
		if (!connection)
			connection = new WispConnection(wispUrl(), (old) => {
				if (connection === old) connection = null;
			});
		const current = connection;
		await Promise.race([
			current.ready,
			new Promise((resolve, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				}),
			),
		]);
		if (current.dead) throw new Error('the Wisp relay closed');
		return current.open(host, port);
	};
}

// hop-by-hop headers, and those this side writes itself
const DROPPED = new Set([
	'connection',
	'keep-alive',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
	'host',
	'content-length',
]);
// what a redirect that turns into a GET no longer sends (fetch's
// request-body-header names)
const BODY_HEADERS = new Set([
	'content-type',
	'content-encoding',
	'content-language',
	'content-location',
]);
const NORMALIZED = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
const TOKEN = /^[!#$%&'*+.^_`|~\w-]+$/;

/** undo the content codings, last applied first */
function decode(body, coding) {
	const codings = (coding ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name && name !== 'identity');
	const options = { maxOutputLength: LIMIT };
	for (const name of codings.reverse()) {
		if (name === 'gzip' || name === 'x-gzip')
			body = zlib.gunzipSync(body, {
				...options,
				finishFlush: zlib.constants.Z_SYNC_FLUSH,
			});
		else if (name === 'deflate') {
			// zlib-wrapped, as the standard says, or the raw deflate some send
			try {
				body = zlib.inflateSync(body, options);
			} catch {
				body = zlib.inflateRawSync(body, options);
			}
		} else if (name === 'br') body = zlib.brotliDecompressSync(body, options);
		else if (name === 'zstd' && zlib.zstdDecompressSync)
			body = zlib.zstdDecompressSync(body, options);
		// an unknown coding is handed on as it came, as fetch does
		else return body;
	}
	return body;
}

/** one HTTP/1.1 exchange over a Wisp stream */
async function exchange(open, url, method, headers, body, signal) {
	const secure = url.protocol === 'https:';
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const port = Number(url.port) || (secure ? 443 : 80);
	const stream = await open(host, port, signal);
	if (signal.aborted) {
		stream.destroy();
		throw signal.reason;
	}
	const socket = secure
		? tlsConnect({
				socket: stream,
				// (an IP literal is no server name)
				...(!/^[\d.]+$|:/.test(host) && { servername: host }),
				ALPNProtocols: ['http/1.1'],
				rejectUnauthorized: true,
			})
		: stream;
	return new Promise((resolve, reject) => {
		const fail = (error) => {
			socket.destroy();
			stream.destroy();
			reject(error);
		};
		const outgoing = request(
			{
				method,
				path: url.pathname + url.search,
				// a length as a browser sends it (node would chunk the body), and
				// a browser's keep-alive (the stream is closed after the answer)
				headers: [
					['host', url.host],
					['connection', 'keep-alive'],
					...headers,
					...(body
						? [['content-length', String(body.length)]]
						: method === 'POST' || method === 'PUT'
							? [['content-length', '0']]
							: []),
				].flat(),
				createConnection: () => socket,
				setHost: false,
				// as lenient as a browser's parser, with headers as long as
				// Chrome takes
				insecureHTTPParser: true,
				maxHeaderSize: 256 * 1024,
				signal,
			},
			(response) => {
				const chunks = [];
				let size = 0;
				response.on('data', (chunk) => {
					size += chunk.length;
					if (size > LIMIT) fail(new Error('the response is over 16 MiB'));
					else chunks.push(chunk);
				});
				response.on('end', () => {
					socket.destroy();
					stream.destroy();
					resolve({ response, body: Buffer.concat(chunks) });
				});
				response.on('error', fail);
			},
		);
		outgoing.on('error', fail);
		socket.on('error', fail);
		// (a refusal under TLS reaches the TLS socket only as a hang)
		if (socket !== stream) stream.on('error', fail);
		outgoing.end(body ?? undefined);
	});
}

/** the request a page asked for, followed as fetch would */
async function relay(open, asked, signal) {
	let url = new URL(asked.url);
	let method = asked.method;
	let body = asked.body;
	let headers = asked.headers;
	const cookies = [];
	const urls = [url.href];
	for (;;) {
		const { response, body: raw } = await exchange(
			open,
			url,
			method,
			headers,
			body,
			signal,
		);
		const raws = response.rawHeaders;
		const answer = [];
		for (let i = 0; i + 1 < raws.length; i += 2) {
			const name = raws[i].toLowerCase();
			answer.push([name, raws[i + 1]]);
			if (name === 'set-cookie') cookies.push([url.href, raws[i + 1]]);
		}
		const status = response.statusCode;
		if ([301, 302, 303, 307, 308].includes(status)) {
			if (asked.redirect === 'error')
				throw new Error('a redirect, which the request refuses');
			const location = response.headers.location;
			if (asked.redirect === 'follow' && location !== undefined) {
				let next;
				try {
					next = new URL(location, url);
				} catch {
					throw new Error('a redirect to an invalid URL');
				}
				if (next.protocol !== 'http:' && next.protocol !== 'https:')
					throw new Error(`a redirect to a ${next.protocol} URL`);
				if (urls.length > MAX_REDIRECTS) throw new Error('too many redirects');
				// a POST that a 301 or 302 moves, and any 303, become a GET
				if (
					((status === 301 || status === 302) && method === 'POST') ||
					(status === 303 && method !== 'GET' && method !== 'HEAD')
				) {
					method = 'GET';
					body = null;
					headers = headers.filter(
						([name]) => !BODY_HEADERS.has(name.toLowerCase()),
					);
				}
				// the page's cookies and credentials were for its origin
				if (next.origin !== url.origin)
					headers = headers.filter(
						([name]) =>
							!['cookie', 'authorization'].includes(name.toLowerCase()),
					);
				url = next;
				urls.push(url.href);
				continue;
			}
		}
		return {
			status,
			statusText: response.statusMessage ?? '',
			url: url.href,
			redirected: urls.length > 1,
			headers: answer,
			body: decode(raw, response.headers['content-encoding']).toString(
				'base64',
			),
			cookies,
		};
	}
}

/** the request in the JSON a page sent, checked */
function parse(text) {
	const asked = JSON.parse(text);
	const url = new URL(asked?.url);
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new Error('not an http: or https: URL');
	let method = typeof asked.method === 'string' ? asked.method : 'GET';
	if (NORMALIZED.includes(method.toUpperCase())) method = method.toUpperCase();
	if (!TOKEN.test(method)) throw new Error('an invalid method');
	if (!Array.isArray(asked.headers ?? []))
		throw new Error('headers is not a list');
	const headers = [];
	let encoding = false;
	for (const pair of asked.headers ?? []) {
		const [name, value] = Array.isArray(pair) ? pair : [];
		if (typeof name !== 'string' || typeof value !== 'string')
			throw new Error('a header is not a pair of strings');
		const lower = name.toLowerCase();
		if (DROPPED.has(lower) || lower.startsWith('proxy-')) continue;
		if (lower === 'accept-encoding') encoding = true;
		headers.push([name, value]);
	}
	if (!encoding) headers.push(['accept-encoding', 'gzip, deflate, br']);
	const body =
		typeof asked.body === 'string' && method !== 'GET' && method !== 'HEAD'
			? Buffer.from(asked.body, 'base64')
			: null;
	const redirect = ['follow', 'manual', 'error'].includes(asked.redirect)
		? asked.redirect
		: 'follow';
	return { url: url.href, method, headers, body, redirect };
}

/**
 * the route's handlers: `wispUrl()` names the Wisp relay to go through when
 * a request comes (the built-in holyWisp's port can change on a restart)
 */
export function syncRelay(wispUrl) {
	const open = wispClient(wispUrl);
	const answer = (res, json) => {
		res.set('Cache-Control', 'no-store');
		res.status(200).json(json);
	};
	return [
		express.text({ type: () => true, limit: LIMIT }),
		async (req, res) => {
			let asked;
			try {
				asked = parse(typeof req.body === 'string' ? req.body : '');
			} catch (error) {
				return answer(res, { error: `a bad request: ${error.message}` });
			}
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(new Error('timed out')),
				TIMEOUT,
			);
			// the page went away: so does its request
			res.on('close', () => controller.abort(new Error('the page left')));
			try {
				answer(res, await relay(open, asked, controller.signal));
			} catch (error) {
				if (!res.headersSent)
					answer(res, {
						error: controller.signal.aborted
							? String(controller.signal.reason?.message ?? 'aborted')
							: error.message || String(error),
					});
			} finally {
				clearTimeout(timer);
			}
		},
		// a body the parser refused (over 16 MiB, a bad charset)
		(error, req, res, _next) =>
			answer(res, { error: `a bad request: ${error.message}` }),
	];
}

// Held loads: GET and POST /stomp/sync-relay/held/<token>. A script a
// WebKit page writes into a frame no service worker controls must run in
// place, and its copy cannot come while the page waits on it, so the
// inject gives the element this address: the frame's parser waits on the
// network (the page's thread runs on), the inject has the worker make the
// copy and posts it here, and the load is answered with it. A copy is kept
// a while after it came, for a second load of it (a preload's); a load
// that waits longer than that is answered 504, and an empty post (the copy
// failed) answers 404, so the load fails as the native one would.
const HELD_MS = 30000;
const HELD_TOKEN = /^[a-z0-9]{8,64}$/;
const HELD_MOST = 512;

export function heldLoads() {
	/** token -> { body, type } once it came, or { waiting: [res] } before */
	const held = new Map();
	const drop = (token) => setTimeout(() => held.delete(token), HELD_MS);
	const send = (res, entry) => {
		res.set('Cache-Control', 'no-store');
		if (!entry.body) return res.status(404).end();
		res.set('Content-Type', entry.type).end(entry.body);
	};
	return [
		express.raw({ type: () => true, limit: LIMIT }),
		(req, res) => {
			const token = req.params.token;
			if (!HELD_TOKEN.test(token)) return res.status(404).end();
			const entry = held.get(token);
			if (req.method === 'POST') {
				const body =
					Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
				const came = {
					body,
					type: req.get('content-type') || 'text/javascript',
				};
				if (entry && !entry.waiting) return res.status(409).end();
				if (!entry && held.size >= HELD_MOST) return res.status(503).end();
				held.set(token, came);
				for (const waiting of entry?.waiting ?? []) send(waiting, came);
				drop(token);
				return res.status(204).end();
			}
			if (req.method !== 'GET' && req.method !== 'HEAD')
				return res.status(405).end();
			if (entry && !entry.waiting) return send(res, entry);
			if (!entry) {
				if (held.size >= HELD_MOST) return res.status(503).end();
				held.set(token, { waiting: [] });
				drop(token);
			}
			const waiting = held.get(token).waiting;
			waiting.push(res);
			const timer = setTimeout(() => {
				const at = waiting.indexOf(res);
				if (at !== -1) waiting.splice(at, 1);
				if (!res.headersSent) res.status(504).end();
			}, HELD_MS);
			res.on('close', () => {
				clearTimeout(timer);
				const at = waiting.indexOf(res);
				if (at !== -1) waiting.splice(at, 1);
			});
		},
	];
}
