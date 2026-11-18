// The Bare-compatible client a realm opens its WebSockets (and carries its
// WebTransport sessions) with, over the controller's transport, and what the
// WebSocket and WebSocketStream stand-ins do once a page constructs one
// (./modules/WebSocket.ts keeps the classes). Most documents open none:
// this file, the transport and the client library are deferred parts of
// the document bundles (src/inject/dom/deferredParts.ts, build.js
// DEFERRED_FILES), about 8 KB of each, evaluated at a document's first
// WebSocket. A worker's bundle carries them itself (./socketParts.ts). Its
// top level reads no global.
import {
	BareCompatibleClient,
	type BareCompatibleWebSocket,
	type RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { partitionSite } from '../partition';
import type { urlLike } from '../StompURL';
import { SOCKET_PARTITION } from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import type Client from './Client';
import type MixedContentModule from './modules/MixedContent';
import { failsToParse, withStack } from './nativeErrors';

export function bareClient(
	port: MessagePort | Promise<MessagePort>,
): BareCompatibleClient {
	return new BareCompatibleClient(new RemoteTransport(port));
}

// WebSocket's readyState values
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
const wsProtocols = ['ws:', 'wss:'];
/** how long a close the page started waits for the transport's word */
const CLOSE_ANSWER_MS = 500;

/** a WebSocket stand-in's state (the class's one field) */
export interface SocketState {
	socket: BareCompatibleWebSocket;
	opened: Promise<void>;
	closeRequest?: { code: number; reason: string };
	closeNow?: (code: number, reason: string) => void;
	/** the close event fired: CLOSED, whatever the transport says */
	closed: boolean;
	binaryType: BinaryType;
	url: string;
}

/**
 * A socket a worker's policy refused: an error a task later, reading
 * CLOSED, and nothing else (no close, measured), as the browser
 * fails one its policy refuses
 */
const refusedSocket = (): BareCompatibleWebSocket => {
	const socket = Object.assign(new EventTarget(), {
		readyState: CONNECTING as number,
		protocol: '',
		extensions: '',
		send: () => Promise.resolve(),
		close: () => {},
	});
	setTimeout(() => {
		socket.readyState = CLOSED;
		socket.dispatchEvent(new Event('error'));
	});
	return socket as unknown as BareCompatibleWebSocket;
};

/**
 * The WebSocket stand-in's construction of `target` (`args` as the page
 * gave them): the socket it opens through the transport, and the state the
 * class keeps
 */
function open(
	client: Client,
	NativeWebSocket: typeof WebSocket,
	mixedContent: MixedContentModule | undefined,
	instances: { add(value: object): unknown },
	origin: string,
	target: EventTarget,
	args: [url: urlLike, protocol?: string | string[]],
): SocketState {
	const [url, protocol] = args;

	// a URL the browser refuses (none, one that does not parse, another
	// scheme, a fragment) gets the browser's own error from the native
	// constructor, which throws before it connects anywhere
	let parsed: URL | null = null;
	if (args.length && !failsToParse(client, String(url)))
		parsed = new URL(String(url), client.baseHref);
	if (
		!parsed ||
		![...wsProtocols, 'http:', 'https:'].includes(parsed.protocol) ||
		parsed.href.includes('#')
	) {
		// (never connects: the browser threw)
		Reflect.construct(NativeWebSocket, args).close();
		throw withStack(
			new client.global.DOMException(
				`Failed to construct 'WebSocket': The URL '${url}' is invalid.`,
				'SyntaxError',
			),
		);
	}

	// relative URLs resolve against the page, http(s) means ws(s)
	if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
	else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';

	// mixed content: no worker sees a WebSocket, so the page's own
	// URL decides here. Chrome refuses ws: from an https page before
	// connecting, and upgrades it under upgrade-insecure-requests
	const mixed = mixedContent?.verdict(parsed, 'websocket');
	if (mixed?.action === 'block') {
		mixedContent!.report([{ kind: 'websocket', url: parsed.href }]);
		throw withStack(
			new client.global.DOMException(
				"Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.",
				'SecurityError',
			),
		);
	}
	if (mixed?.action === 'upgrade') parsed = mixed.url;

	instances.add(target);

	const state = {
		closed: false,
		binaryType: 'blob',
		url: parsed.toString(),
	} as SocketState;

	// no Cookie here: the controller adds the jar's (HttpOnly included)
	// to the handshake, so the page never holds it
	const requestHeaders: RawHeaders = [
		['Origin', origin],
		['User-Agent', navigator.userAgent],
	];
	// a context in a partition: the controller reads it for the jar
	// (its Partitioned cookies, and SameSite as another site's)
	const partitionKey = partitionSite(client.partition);
	if (partitionKey !== null)
		requestHeaders.push([SOCKET_PARTITION, partitionKey]);

	// the page's connect-src (src/csp.ts): no worker sees a
	// WebSocket, so a socket the page's policy refuses is opened to a
	// URL the browser's copy of the policy refuses, and the browser
	// fails it (error, then close 1006) and reports it as natively
	const policed = client as {
		socketRefusal?: (url: URL) => string | null;
		connectVerdict?: (url: URL) => boolean;
	};
	const refused = policed.socketRefusal?.(parsed) ?? null;
	// a worker's own policies (WorkerClient.connectVerdict): the
	// browser applies none of them, so the worker reports the
	// refusal itself and the socket only fails
	const workerRefused = policed.connectVerdict?.(parsed) ?? false;
	// client.bare is created lazily; a failure there (no transport)
	// surfaces as an error event like a refused connection would.
	const socket = (state.socket =
		refused !== null
			? (Reflect.construct(NativeWebSocket, [
					refused,
				]) as unknown as BareCompatibleWebSocket)
			: workerRefused
				? refusedSocket()
				: client.bare.createWebSocket(parsed, protocol, requestHeaders));

	state.opened = new Promise<void>((resolve) => {
		socket.addEventListener('open', () => resolve(), {
			once: true,
		});
		socket.addEventListener('error', () => resolve(), {
			once: true,
		});
	});

	socket.addEventListener('open', () => {
		target.dispatchEvent(new Event('open'));
	});

	socket.addEventListener('message', async (event) => {
		let data = (event as MessageEvent).data;

		// transports deliver binary frames as ArrayBuffer or Blob;
		// present them according to binaryType
		if (typeof data !== 'string') {
			if (state.binaryType === 'blob' && !(data instanceof Blob)) {
				data = new Blob([data]);
			} else if (state.binaryType === 'arraybuffer' && data instanceof Blob) {
				data = await data.arrayBuffer();
			}
		}

		// the origin of the socket's URL, as natively (not the URL)
		target.dispatchEvent(
			new MessageEvent('message', {
				data,
				origin: new URL(state.url).origin,
			}),
		);
	});

	// one close event, as the browser fires it
	let closed = false;
	const dispatchClose = (code: number, reason: string) => {
		if (closed) return;
		closed = true;
		state.closed = true;
		target.dispatchEvent(
			new CloseEvent('close', { code, reason, wasClean: code !== 1006 }),
		);
	};
	state.closeNow = dispatchClose;

	// a connection that fails (refused, a TLS handshake that ends, one
	// a content blocker refuses) gets an error and then a close with
	// 1006 natively, one after the other in the same task and both
	// reading CLOSED; the transport reports the error only
	socket.addEventListener('error', () => {
		target.dispatchEvent(new Event('error'));
		// a socket the policy refused fires no close (measured)
		if (refused === null && !workerRefused) dispatchClose(1006, '');
		else state.closed = true;
	});

	socket.addEventListener('close', (event) => {
		let { code, reason } = event as CloseEvent;

		// transports don't relay the close handshake; when the page
		// initiated the close, report what it asked for like a browser
		// (1005, no status, for a close() without a code)
		if (state.closeRequest) ({ code, reason } = state.closeRequest);
		// a close frame without a status reads 1005 natively (the
		// transport passes the server's status and reason on, and a
		// transport that has neither reports nothing)
		else if (!code) code = 1005;

		dispatchClose(code, reason);
	});
	return state;
}

/** the stand-in's send() */
function send(
	state: SocketState,
	target: EventTarget,
	data: string | ArrayBufferLike | Blob | ArrayBufferView,
) {
	if (state.socket.readyState === CONNECTING) {
		throw withStack(
			new DOMException(
				`Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.`,
			),
		);
	}

	// resolved by then; the transport may still reject, which the
	// native API would surface as a close/error event
	state.socket.send(data as string | ArrayBuffer | Blob).catch((error) => {
		console.error(error);
		target.dispatchEvent(new Event('error'));
	});
}

/** the stand-in's close() */
function close(state: SocketState, code?: number, reason?: string) {
	if (typeof code !== 'undefined') {
		if (typeof code !== 'number') {
			code = 0;
		}

		if (code !== 1000 && (code < 3000 || code > 4999)) {
			throw withStack(
				new DOMException(
					`Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
				),
			);
		}
	}

	if (state.closeRequest) return;
	// no code is a close frame without a status, which the server
	// echoes and the page reads as 1005; the transport is given 1000,
	// since it takes no empty close
	state.closeRequest = { code: code ?? 1005, reason: reason ?? '' };

	// the transport connection may not exist yet
	state.opened.then(() => {
		if (state.socket.readyState !== OPEN) return;
		const { code, reason } = state.closeRequest!;
		state.socket.close(code === 1005 ? 1000 : code, reason);
		// epoxy reports no close for a close that carries anything but
		// 1000 and no reason (measured): the page's close event comes
		// once the server had time to answer, as the browser's would
		setTimeout(() => state.closeNow?.(code, reason), CLOSE_ANSWER_MS);
	});
}

/** a WebSocketStream stand-in's state (the class's one field) */
export interface StreamState {
	socket: WebSocket;
	url: string;
	opened: Promise<{
		readable: ReadableStream;
		writable: WritableStream;
		extensions: string;
		protocol: string;
	}>;
	closed: Promise<{ closeCode: number; reason: string }>;
}

const networkError = (message: string) =>
	withStack(new DOMException(message, 'NetworkError'));

/**
 * The WebSocketStream stand-in's construction of `target`: the same
 * connection through the proxied WebSocket (`Socket`, the page's), with
 * the streams API the page expects
 */
function stream(
	Socket: new (url: urlLike, protocols?: string | string[]) => WebSocket,
	instances: { add(value: object): unknown },
	target: object,
	args: [
		url: urlLike,
		options?: { protocols?: string | string[]; signal?: AbortSignal },
	],
): StreamState {
	if (!args.length)
		throw new TypeError(
			"Failed to construct 'WebSocketStream': 1 argument required, but only 0 present.",
		);
	const [url, options = {}] = args;
	const socket = new Socket(url, options.protocols);
	socket.binaryType = 'arraybuffer';
	const state = { socket, url: socket.url } as StreamState;
	instances.add(target);

	let resolveClosed!: (value: { closeCode: number; reason: string }) => void;
	let rejectClosed!: (reason: unknown) => void;
	state.closed = new Promise((resolve, reject) => {
		resolveClosed = resolve;
		rejectClosed = reject;
	});
	state.opened = new Promise((resolve, reject) => {
		socket.addEventListener(
			'open',
			() => {
				const readable = new ReadableStream({
					start(controller) {
						socket.addEventListener('message', (event) =>
							controller.enqueue((event as MessageEvent).data),
						);
						socket.addEventListener('close', () => {
							try {
								controller.close();
							} catch (error) {
								// already closed or errored
							}
						});
						socket.addEventListener('error', () =>
							controller.error(
								networkError('The WebSocket connection failed.'),
							),
						);
					},
					cancel() {
						socket.close();
					},
				});
				const writable = new WritableStream({
					write(chunk) {
						socket.send(chunk);
					},
					close() {
						socket.close();
					},
					abort() {
						socket.close();
					},
				});
				resolve({
					readable,
					writable,
					extensions: socket.extensions,
					protocol: socket.protocol,
				});
			},
			{ once: true },
		);
		socket.addEventListener(
			'error',
			() => {
				const error = networkError('WebSocketStream: the connection failed.');
				reject(error);
				rejectClosed(error);
			},
			{ once: true },
		);
	});
	socket.addEventListener('close', (event) =>
		resolveClosed({
			closeCode: (event as CloseEvent).code,
			reason: (event as CloseEvent).reason,
		}),
	);
	// a rejection nobody awaits is not an unhandled one
	state.opened.catch(() => {});
	state.closed.catch(() => {});
	options.signal?.addEventListener('abort', () => socket.close(), {
		once: true,
	});
	return state;
}

/** what the stand-ins of ./modules/WebSocket.ts do once a page has one */
export const socketStandIns = { open, send, close, stream };
