import type {
	ProxyTransport,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { pastASCII, utf8Text } from '../byteString';
import { sendBody } from './bodyPort';
import { boundedBody } from './boundedBody';
import { base64url, httpsQuery } from './http3/dnsHttps';
import {
	HANDSHAKE_REFUSED,
	HostToTransport,
	postToPort,
	SOCKET_PARTITION,
	SOCKET_UPGRADE,
	StreamMessage,
	transferablesOf,
	TRANSPORT_GONE,
	TRANSPORT_RPC,
	TransportToHost,
	WebSocketMessage,
} from './messages';
import { NETWORK_PARTITION } from './networkPartition';
import { listenOn } from './ports';
import { REQUEST_QUEUE, SEEN_URGENCY } from './requestQueue';
import {
	changedResponse,
	connectionTimes,
	laterConnection,
	withoutEncodedBytes,
} from './responseFacts';
import { resumableBody } from './resumableBody';
import { RpcHelper } from './rpc';
import { poolOf, reportsVersion, type SocketPass } from './socketPool';
import { acknowledgedSends } from './socketSends';
import {
	connectionLine,
	logTransport,
	rideOf,
	transportLog,
} from './transportLog';
import { serveWebTransport, type AdmitSession } from './webTransportHost';

/**
 * The headers a WebSocket handshake goes out with, given the page's. A hook
 * that rejects with an Error whose message is HANDSHAKE_REFUSED refuses the
 * socket: it fails like a connection the browser itself would not make.
 */
export type DecorateHandshake = (
	url: URL,
	headers: RawHeaders,
) => Promise<RawHeaders>;

/**
 * What a transport says it does with the request fields the service worker
 * sends in Chrome's shape (src/server/headerOrder.ts): the Accept-Encoding
 * it decodes, and whether it keeps Priority to HTTP/2 as Chrome does. Our
 * epoxy build declares both. A transport that does not gets no
 * Accept-Encoding (it sends its own, for what it decodes: libcurl's is
 * deflate, gzip, br, and a zstd answer would fail it) and no Priority
 * (Chrome sends none over HTTP/1.1).
 */
interface FieldSupport {
	acceptEncoding?: string;
	priority?: boolean;
	/** the field it reads a request's network partition from (NETWORK_PARTITION) */
	partition?: string;
	/** each response says which HTTP version it came over (socketPool.ts) */
	httpVersion?: boolean;
}

/**
 * A Cookie field as a transport takes it. The service worker writes the
 * jar's cookies as their bytes, a character each (Headers holds nothing
 * else: src/server/Cookies.ts header()), where every other field a page
 * sends is the text the browser handed the worker, which is the bytes read
 * as UTF-8; a transport sends a value's UTF-8 (epoxy, libcurl), so bytes
 * that are UTF-8 go as the text they spell, or a cookie a server set in
 * UTF-8 went back with every byte past 0x7F as two. Bytes that are not
 * UTF-8 stay as they are: a transport of text has no way to send them.
 */
export const cookieText = (value: string) =>
	(pastASCII(value) && utf8Text(value)) || value;

/** `headers` as `transport` can send them */
export function fitHeaders(
	transport: ProxyTransport,
	headers: RawHeaders,
): RawHeaders {
	// a host calling the transport itself may hand anything the transport
	// takes (an object of fields); the worker always sends pairs
	if (!Array.isArray(headers)) return headers;
	const support = (transport as { fieldSupport?: FieldSupport }).fieldSupport;
	// the worker's word for the partition, for a transport that keeps a pool
	// per partition; never the server's
	const partitioned = support?.partition === NETWORK_PARTITION;
	const out: RawHeaders = [];
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (lower === NETWORK_PARTITION) {
			if (partitioned) out.push([name, value]);
		} else if (lower === REQUEST_QUEUE) {
			// the worker's word for the socket pool here, never the server's
		} else if (lower === 'accept-encoding') {
			if (support?.acceptEncoding) out.push([name, support.acceptEncoding]);
		} else if (lower === 'priority') {
			if (support?.priority) out.push([name, value]);
		} else if (lower === 'cookie') out.push([name, cookieText(value)]);
		else out.push([name, value]);
	}
	return out;
}

/** the origins each transport that names no HTTP version answered for, told once each (the verbose log) */
const unversionedSeen = new WeakMap<ProxyTransport, Set<string>>();
function unversioned(transport: ProxyTransport, url: URL) {
	let seen = unversionedSeen.get(transport);
	if (!seen) unversionedSeen.set(transport, (seen = new Set()));
	if (seen.has(url.origin)) return;
	seen.add(url.origin);
	logTransport(connectionLine(transport, undefined, url.origin, '', ''));
}

/** how long a decorate hook may take before the handshake goes out without it */
const DECORATE_TIMEOUT_MS = 2000;

/**
 * The URL a socket connects to: the wss: one the decorate hook named
 * (SOCKET_UPGRADE, HSTS), when it is the ws: `url` made secure (the same
 * host, its port, or 443 for 80); else `url` as the page gave it
 */
function upgradedSocketURL(url: string, decorated: RawHeaders): string {
	const named = decorated.find(
		([name]) => name.toLowerCase() === SOCKET_UPGRADE,
	)?.[1];
	if (typeof named !== 'string') return url;
	try {
		const from = new URL(url);
		const to = new URL(named);
		const port = from.port === '80' ? '' : from.port;
		return from.protocol === 'ws:' &&
			to.protocol === 'wss:' &&
			to.hostname === from.hostname &&
			to.port === port &&
			to.pathname === from.pathname &&
			to.search === from.search
			? to.href
			: url;
	} catch (error) {
		return url;
	}
}

/** what epoxy's connect_udp, connect_tcp and connect_tls answer */
interface RawStream {
	read: ReadableStream<Uint8Array>;
	write: WritableStream<Uint8Array>;
	/** a UDP stream's: one datagram, failing that send alone when it is too large */
	send?: (datagram: Uint8Array) => Promise<void>;
}
interface RawClient {
	connect_udp?: (url: string) => Promise<RawStream>;
	connect_tcp?: (url: string) => Promise<RawStream>;
	connect_tls?: (url: string) => Promise<RawStream>;
}

/** the wisp client under the wrappers (RevivingTransport, Http3Transport expose `client` and `base`) */
function rawClient(transport: ProxyTransport): RawClient | null {
	let current: unknown = transport;
	for (let depth = 0; depth < 4 && current; depth++) {
		const client = (current as { client?: unknown }).client;
		if (client && typeof client === 'object') return client as RawClient;
		current = (current as { base?: unknown }).base;
	}
	return null;
}

const bracket = (host: string) => (host.includes(':') ? `[${host}]` : host);

/** how long a closing stream waits for its last sends */
const CLOSE_FLUSH_MS = 2000;

/**
 * Serve a raw stream (opened by `opening`) on `port`: each datagram or chunk
 * read is posted as a StreamMessage, each one posted is written, a close
 * from either side closes both. Answers the rpc result once the stream is
 * open or refused.
 */
async function openStream(
	port: MessagePort,
	opening: Promise<RawStream>,
	/** the verbose log's line once it is open (transportLog.ts), '' when off */
	line: string,
): Promise<[TransportToHost['udp'][1], Transferable[]]> {
	let raw: RawStream;
	try {
		raw = await opening;
		if (line) logTransport(line);
	} catch (error) {
		port.close();
		return [
			{ result: 'failure', error: String((error as Error)?.message || error) },
			[],
		];
	}
	let closed = false;
	/** sends that have not settled, and the close that waits for them */
	let sending = 0;
	let finish: (() => void) | null = null;
	const writer = raw.write.getWriter();
	const close = (reason?: string) => {
		if (closed) return;
		closed = true;
		postToPort(port, { type: 'close', reason } satisfies StreamMessage);
		port.close();
		writer.close().catch(() => {});
	};
	port.onmessage = ({ data }: MessageEvent<StreamMessage>) => {
		if (closed) return;
		if (data.type === 'data') {
			const bytes = new Uint8Array(data.data);
			// a datagram too large fails that send alone (epoxy's send); a
			// failed write on the stream ends it
			const sent = raw.send ? raw.send(bytes) : writer.write(bytes);
			sending++;
			sent
				.catch((error) => {
					if (!raw.send) close(String((error as Error)?.message || error));
				})
				.finally(() => {
					if (--sending === 0) finish?.();
				});
		} else if (data.type === 'close') {
			if (closed) return;
			closed = true;
			port.close();
			// what was sent just before the close still leaves (a WebRTC
			// connection's goodbye is its last datagram): the stream closes
			// once those sends have settled, or after a moment if one never
			// does
			let finished = false;
			finish = () => {
				if (finished) return;
				finished = true;
				writer.close().catch(() => {});
			};
			if (sending === 0) finish();
			else setTimeout(finish, CLOSE_FLUSH_MS);
		}
	};
	port.start();
	(async () => {
		const reader = raw.read.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done || closed) break;
				const copy = new Uint8Array(value).slice();
				postToPort(
					port,
					{ type: 'data', data: copy.buffer } satisfies StreamMessage,
					[copy.buffer],
				);
			}
			close();
		} catch (error) {
			close(String((error as Error)?.message || error));
		}
	})();
	return [{ result: 'success' }, []];
}

/**
 * One init() at a time per transport, however many ports and requests find
 * it not ready: init() is not idempotent everywhere (epoxy's loaded its wasm
 * again on each call, and two same-tick calls killed the first client), so
 * every caller waits on the same in-flight promise. A failed init is not
 * kept: the next caller tries again.
 */
const initializing = new WeakMap<ProxyTransport, Promise<void>>();
function initOnce(transport: ProxyTransport): Promise<void> {
	let pending = initializing.get(transport);
	if (!pending) {
		pending = Promise.resolve(transport.init()).finally(() =>
			initializing.delete(transport),
		);
		initializing.set(transport, pending);
	}
	return pending;
}

/** what a transport's wrappers (Http3Transport, RevivingTransport) keep under them: epoxy's client, which opens its wisp connection on demand */
interface WispClient {
	replace_stream_provider?: () => Promise<unknown>;
}

function wispClient(transport: ProxyTransport): WispClient | null {
	const held = transport as { client?: unknown; base?: ProxyTransport };
	if (held.client && typeof held.client === 'object')
		return held.client as WispClient;
	return held.base ? wispClient(held.base) : null;
}

/** whether a transport under the wrappers opens its wisp connection in init() itself (CarrierTransport.opensWisp) */
function opensWisp(transport: ProxyTransport): boolean {
	let current: unknown = transport;
	for (let depth = 0; depth < 6 && current; depth++) {
		if ((current as { opensWisp?: unknown }).opensWisp === true) return true;
		current = (current as { base?: unknown }).base;
	}
	return false;
}

/**
 * Load the transport and open its wisp connection now, before anything asks
 * for them. A transport did both on its first request: the first navigation
 * waited for epoxy's wasm module to load and compile and for the WebSocket
 * to the wisp server and its handshake (40 to 70 ms on loopback, round
 * trips more to a wisp server over the internet). A request that comes
 * meanwhile waits for it as it would for init(), so no request opens a
 * connection of its own beside it; a connection that cannot be opened now
 * is left to the first request, as before. A transport without epoxy's
 * client is only loaded.
 */
export function warmTransport(
	transport: ProxyTransport,
	/** epoxy's `ech_dns`, when it has one: its connection is opened too (warmResolver) */
	resolver?: string,
): void {
	if (transport.ready || initializing.has(transport)) return;
	const pending = Promise.resolve(transport.init())
		// a transport that opened its wisp connection in init() (a carrier
		// on its own WebSocket) is not given another
		.then(() =>
			opensWisp(transport)
				? undefined
				: wispClient(transport)?.replace_stream_provider?.(),
		)
		.then(
			() => {},
			(error) => {
				// not loaded: the next request tries again (initOnce)
				if (!transport.ready) throw error;
			},
		)
		.finally(() => initializing.delete(transport));
	pending.catch(() => {});
	initializing.set(transport, pending);
	// a sharded transport's shards warm it each with its own wisp connection
	if (resolver && !warmsResolver(transport))
		pending.then(() => warmResolver(transport, resolver)).catch(() => {});
}

/** whether a layer under the wrappers warms epoxy's resolver itself (ShardedTransport) */
function warmsResolver(transport: ProxyTransport): boolean {
	let current: unknown = transport;
	for (let depth = 0; depth < 6 && current; depth++) {
		if ((current as { warmsResolver?: unknown }).warmsResolver === true)
			return true;
		current = (current as { base?: unknown }).base;
	}
	return false;
}

/** the transport under the wrappers (Http3Transport, RevivingTransport): epoxy's own */
function innermost(transport: ProxyTransport): ProxyTransport {
	const base = (transport as { base?: ProxyTransport }).base;
	return base && typeof base.request === 'function'
		? innermost(base)
		: transport;
}

/**
 * Open the connection to the DNS-over-HTTPS server epoxy asks for a host's
 * ECH config (`ech_dns`, docs/fingerprint.md) with one query of its own
 * name, which epoxy never asks. Epoxy asks before the TLS handshake of
 * each new host, and the first navigation's site waited for a TCP and TLS
 * handshake with the resolver before its own (60 to 100 ms of its first
 * byte); after this its query is one round trip on a connection already
 * open. Sent on epoxy's own client, whose pool the lookups use, not
 * through HTTP/3; nothing waits for it.
 */
async function warmResolver(transport: ProxyTransport, resolver: string) {
	const url = new URL(resolver);
	url.searchParams.set('dns', base64url(httpsQuery(url.hostname)));
	const response = await innermost(transport).request(
		url,
		'GET',
		null,
		[['accept', 'application/dns-message']],
		undefined,
	);
	// read to its end, so the stream is done with
	await new Response(response.body as BodyInit).arrayBuffer();
}

/**
 * What each port this realm serves does as it stops serving (`goodbye`),
 * found by the port, which is held weakly: a port the browser let go of
 * (its other end went) is not kept for it. Chrome 157 fires no MessagePort
 * close event, so the RemoteTransport on the other end would never hear
 * this side go: a request there waited for good, a socket stayed open.
 */
const goodbyes = new WeakMap<MessagePort, () => void>();
const served = new Set<WeakRef<MessagePort>>();
let servedSincePrune = 0;
let hearsHide = false;

function keepServed(port: MessagePort, goodbye: () => void) {
	goodbyes.set(port, goodbye);
	served.add(new WeakRef(port));
	if (++servedSincePrune >= 64) {
		servedSincePrune = 0;
		for (const ref of served) if (!ref.deref()) served.delete(ref);
	}
	// a page that serves (the controller's, hosting its transport): its
	// ports go with it when it goes for good. A page in the back/forward
	// cache may come back and serve them again
	if (hearsHide || typeof document === 'undefined') return;
	hearsHide = true;
	listenOn(globalThis, 'pagehide', (event) => {
		if (event.isTrusted && !(event as PageTransitionEvent).persisted)
			goodbyeAll();
	});
}

/**
 * Every port this realm serves stops: its sockets close (1001, as the
 * browser closes a document's when its tab goes) and the RemoteTransport on
 * the other end hears TRANSPORT_GONE. The transport worker's controller
 * calls it as its page goes for good; a page that serves calls it itself.
 */
export function goodbyeAll() {
	for (const ref of served) {
		const port = ref.deref();
		if (port) goodbyes.get(port)?.();
	}
	served.clear();
}

/**
 * Serve a ProxyTransport to a `RemoteTransport` on the other end of `port`.
 * `getTransport` is a getter so the host can hot-swap transports. `decorate`
 * may add headers to a WebSocket handshake (the controller adds the cookie
 * jar's Cookie, HttpOnly included, which the page must never hold); a
 * Cookie the page sent itself is dropped first, and a hook that fails or
 * stalls leaves the handshake as it was. A hook that refuses the socket
 * (HANDSHAKE_REFUSED: the built-in blocker's lists block it) fails the
 * connection here, before the transport hears of it.
 * Returns a function that stops serving: the other end hears TRANSPORT_GONE
 * and the port closes.
 */
export default function serveTransport(
	port: MessagePort,
	getTransport: () => ProxyTransport,
	decorate?: DecorateHandshake,
	/** asked before a page's WebTransport session opens (the built-in blocker) */
	admit?: AdmitSession,
): () => void {
	const post = (data: unknown, transfer: Transferable[] = []) =>
		postToPort(port, data, transfer);
	/** what closes each socket open on this port, for goodbye */
	const sockets = new Set<() => void>();
	let gone = false;
	const goodbye = () => {
		if (gone) return;
		gone = true;
		for (const end of [...sockets]) end();
		post({ [TRANSPORT_GONE]: true });
		port.close();
	};
	keepServed(port, goodbye);

	const readyTransport = async () => {
		const transport = getTransport();
		// (a transport warmTransport is still connecting is ready already)
		if (!transport.ready || initializing.has(transport))
			await initOnce(transport);
		return transport;
	};

	const rpc = new RpcHelper<TransportToHost, HostToTransport>(
		{
			serve: async (served) => {
				serveTransport(served, getTransport, decorate, admit);
				return [undefined, []];
			},
			requeue: async ({ id, op }) => {
				const pool = poolOf(getTransport()).http;
				if (op === 'cancel') pool.cancel(id);
				else pool.raise(id, SEEN_URGENCY);
				return [undefined, []];
			},
			request: async ({ remote, method, body, headers }) => {
				const arrived = performance.now();
				const transport = await readyTransport();
				const url = new URL(remote);
				const sent = fitHeaders(transport, headers);
				// it waits for a connection as Chrome's requests wait for a
				// socket (socketPool.ts), and holds it until its body ends
				const ticket = reportsVersion(transport)
					? await poolOf(transport).http.take(url, headers, (id) =>
							rpc.call('waiting', id).catch(() => {}),
						)
					: null;
				let response;
				const called = performance.now();
				try {
					response = await transport.request(
						url,
						method,
						body,
						sent,
						undefined,
					);
				} catch (error) {
					ticket?.failed();
					throw error;
				}
				if (ticket) response = ticket.answered(response);
				else if (transportLog.on) unversioned(transport, url);
				// the connection's times are from the transport's call: from
				// the request's arrival they take in its wait for a connection,
				// as Chrome's do (responseFacts.ts)
				const connection = connectionTimes(
					(response as { connection?: unknown }).connection,
				);
				if (connection)
					response = changedResponse(response, {
						connection: laterConnection(connection, called - arrived),
					} as Partial<typeof response>);
				// (a function, which crosses with the body's end)
				const [plain, encodedBytes] = withoutEncodedBytes(response);
				// a streamed body goes on a port of its own (bodyPort.ts), a
				// large one the reader falls behind on is let go and resumed
				// by range (resumableBody.ts), and one that cannot be, on a
				// connection that does not hold it back, is reset if its
				// reader stops (boundedBody.ts)
				if (plain.body instanceof ReadableStream) {
					const pushed = sendBody(
						boundedBody(
							response,
							resumableBody(transport, url, method, sent, response),
						),
						true,
						encodedBytes,
					);
					return [{ ...plain, body: pushed }, [pushed.$stompBodyPort]];
				}
				return [plain, transferablesOf(plain.body)];
			},
			connect: async ({ url, protocols, requestHeaders, port: socket }) => {
				const transport = await readyTransport();
				// (the URL HSTS makes of it is the hook's word alone)
				const given = requestHeaders.filter(([name]) => {
					const lower = name.toLowerCase();
					return lower !== 'cookie' && lower !== SOCKET_UPGRADE;
				});
				// the inject's word for the hook, never the server's
				const outgoing = (headers: RawHeaders) =>
					headers.flatMap(([name, value]): RawHeaders => {
						const lower = name.toLowerCase();
						if (lower === SOCKET_PARTITION || lower === SOCKET_UPGRADE)
							return [];
						return [[name, lower === 'cookie' ? cookieText(value) : value]];
					});
				requestHeaders = outgoing(given);
				if (decorate)
					try {
						const decorated = await Promise.race([
							decorate(new URL(url), given),
							new Promise<null>((resolve) =>
								setTimeout(() => resolve(null), DECORATE_TIMEOUT_MS),
							),
						]);
						if (decorated) {
							requestHeaders = outgoing(decorated);
							url = upgradedSocketURL(url, decorated);
						}
					} catch (error) {
						// an explicit refusal: the page's socket gets the failure a
						// connection the browser refused to make gets (error, then
						// close with 1006), and nothing is opened on the transport
						if (error instanceof Error && error.message === HANDSHAKE_REFUSED) {
							socket.close();
							return [{ result: 'failure', error: 'refused' }, []];
						}
						// anything else: the handshake goes out without the extra headers
					}

				// Chrome's limits (socketPool.ts): one handshake at a time to a
				// host and port, and past 255 sockets a new one fails
				const pass: SocketPass | null = await poolOf(transport).ws.admit(
					new URL(url),
				);
				if (!pass) {
					socket.close();
					return [{ result: 'failure', error: 'too many WebSockets' }, []];
				}

				let resolve!: (result: TransportToHost['connect'][1]) => void;
				const result = new Promise<TransportToHost['connect'][1]>(
					(res) => (resolve = res),
				);

				let over = false;
				const [send, close] = transport.connect(
					new URL(url),
					protocols,
					requestHeaders,
					(protocol, extensions) => {
						pass.connected();
						if (transportLog.on)
							logTransport(
								`WebSocket to ${url}: HTTP/1.1 Upgrade over ${url.startsWith('wss:') ? 'TLS over ' : ''}a Wisp TCP stream, ${rideOf(transport, false)}`,
							);
						resolve({ result: 'success', protocol, extensions, acks: true });
					},
					(data) =>
						postToPort(
							socket,
							{ type: 'data', data } satisfies WebSocketMessage,
							transferablesOf(data),
						),
					(code, reason) => {
						over = true;
						sockets.delete(end);
						pass.connected();
						pass.closed();
						postToPort(socket, {
							type: 'close',
							code,
							reason,
						} satisfies WebSocketMessage);
						// the last word (the page reads what was posted before
						// the port closed): the channel goes, or this worker
						// keeps it for the page's life
						socket.onmessage = null;
						socket.close();
					},
					(error) => {
						over = true;
						sockets.delete(end);
						pass.connected();
						pass.closed();
						resolve({ result: 'failure', error });
					},
				);

				// (the port stops serving: the socket closes as a document's does
				// when its tab goes)
				function end() {
					sockets.delete(end);
					pass!.closed();
					close(1001, '');
					socket.onmessage = null;
					socket.close();
				}
				if (!over) sockets.add(end);
				// the page is told when each frame has left (its bufferedAmount)
				const sendFrame = acknowledgedSends(send, () =>
					postToPort(socket, { type: 'sent' } satisfies WebSocketMessage),
				);
				socket.onmessage = ({ data }: MessageEvent<WebSocketMessage>) => {
					if (data.type === 'data') sendFrame(data.data);
					else if (data.type === 'close') {
						sockets.delete(end);
						pass.closed();
						close(data.code, data.reason);
					}
				};
				socket.onmessageerror = (event) =>
					console.error('Transport socket port messageerror', event);
				socket.start();

				return [await result, []];
			},
			webtransport: async (session) =>
				serveWebTransport(await readyTransport(), session, admit),
			udp: async ({ host, port: remotePort, stream }) => {
				const transport = await readyTransport();
				const client = rawClient(transport);
				if (!client?.connect_udp)
					return [{ result: 'failure', error: 'no UDP on this transport' }, []];
				return openStream(
					stream,
					client.connect_udp(`udp://${bracket(host)}:${remotePort}`),
					transportLog.on
						? `UDP to ${bracket(host)}:${remotePort} (WebRTC): a Wisp UDP stream, ${rideOf(transport, true)}`
						: '',
				);
			},
			tcp: async ({ host, port: remotePort, tls, stream }) => {
				const transport = await readyTransport();
				const client = rawClient(transport);
				const connect = tls ? client?.connect_tls : client?.connect_tcp;
				if (!connect)
					return [{ result: 'failure', error: 'no TCP on this transport' }, []];
				return openStream(
					stream,
					Reflect.apply(connect, client, [
						`${tls ? 'tls' : 'tcp'}://${bracket(host)}:${remotePort}`,
					]),
					transportLog.on
						? `${tls ? 'TLS' : 'TCP'} to ${bracket(host)}:${remotePort} (WebRTC): ${tls ? 'TLS over ' : ''}a Wisp TCP stream, ${rideOf(transport, false)}`
						: '',
				);
			},
		},
		TRANSPORT_RPC,
		post,
	);

	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.addEventListener('messageerror', (event) =>
		console.error('Transport port messageerror', event),
	);
	port.start();

	rpc.call('ready', undefined);

	return goodbye;
}
