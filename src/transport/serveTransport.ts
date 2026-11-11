import type {
	ProxyTransport,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { sendBody } from './bodyPort';
import {
	HANDSHAKE_REFUSED,
	HostToTransport,
	postToPort,
	transferablesOf,
	TRANSPORT_RPC,
	TransportToHost,
	WebSocketMessage,
} from './messages';
import { RpcHelper } from './rpc';

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
}

/** `headers` as `transport` can send them */
export function fitHeaders(
	transport: ProxyTransport,
	headers: RawHeaders,
): RawHeaders {
	// a host calling the transport itself may hand anything the transport
	// takes (an object of fields); the worker always sends pairs
	if (!Array.isArray(headers)) return headers;
	const support = (transport as { fieldSupport?: FieldSupport }).fieldSupport;
	const out: RawHeaders = [];
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (lower === 'accept-encoding') {
			if (support?.acceptEncoding) out.push([name, support.acceptEncoding]);
		} else if (lower === 'priority') {
			if (support?.priority) out.push([name, value]);
		} else out.push([name, value]);
	}
	return out;
}

/** how long a decorate hook may take before the handshake goes out without it */
const DECORATE_TIMEOUT_MS = 2000;

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

/**
 * Serve a ProxyTransport to a `RemoteTransport` on the other end of `port`.
 * `getTransport` is a getter so the host can hot-swap transports. `decorate`
 * may add headers to a WebSocket handshake (the controller adds the cookie
 * jar's Cookie, HttpOnly included, which the page must never hold); a
 * Cookie the page sent itself is dropped first, and a hook that fails or
 * stalls leaves the handshake as it was. A hook that refuses the socket
 * (HANDSHAKE_REFUSED: the built-in blocker's lists block it) fails the
 * connection here, before the transport hears of it.
 * Returns a function that closes the port.
 */
export default function serveTransport(
	port: MessagePort,
	getTransport: () => ProxyTransport,
	decorate?: DecorateHandshake,
): () => void {
	const post = (data: unknown, transfer: Transferable[] = []) =>
		postToPort(port, data, transfer);

	const readyTransport = async () => {
		const transport = getTransport();
		if (!transport.ready) await initOnce(transport);
		return transport;
	};

	const rpc = new RpcHelper<TransportToHost, HostToTransport>(
		{
			request: async ({ remote, method, body, headers }) => {
				const transport = await readyTransport();
				const response = await transport.request(
					new URL(remote),
					method,
					body,
					fitHeaders(transport, headers),
					undefined,
				);
				// a streamed body goes on a port of its own (bodyPort.ts)
				if (response.body instanceof ReadableStream) {
					const pushed = sendBody(response.body);
					return [{ ...response, body: pushed }, [pushed.$stompBodyPort]];
				}
				return [response, transferablesOf(response.body)];
			},
			connect: async ({ url, protocols, requestHeaders, port: socket }) => {
				const transport = await readyTransport();
				requestHeaders = requestHeaders.filter(
					([name]) => name.toLowerCase() !== 'cookie',
				);
				if (decorate)
					try {
						const decorated = await Promise.race([
							decorate(new URL(url), requestHeaders),
							new Promise<null>((resolve) =>
								setTimeout(() => resolve(null), DECORATE_TIMEOUT_MS),
							),
						]);
						if (decorated) requestHeaders = decorated;
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

				let resolve!: (result: TransportToHost['connect'][1]) => void;
				const result = new Promise<TransportToHost['connect'][1]>(
					(res) => (resolve = res),
				);

				const [send, close] = transport.connect(
					new URL(url),
					protocols,
					requestHeaders,
					(protocol, extensions) =>
						resolve({ result: 'success', protocol, extensions }),
					(data) =>
						postToPort(
							socket,
							{ type: 'data', data } satisfies WebSocketMessage,
							transferablesOf(data),
						),
					(code, reason) =>
						postToPort(socket, {
							type: 'close',
							code,
							reason,
						} satisfies WebSocketMessage),
					(error) => resolve({ result: 'failure', error }),
				);

				socket.onmessage = ({ data }: MessageEvent<WebSocketMessage>) => {
					if (data.type === 'data') send(data.data);
					else if (data.type === 'close') close(data.code, data.reason);
				};
				socket.onmessageerror = (event) =>
					console.error('Transport socket port messageerror', event);
				socket.start();

				return [await result, []];
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

	return () => port.close();
}
