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
	port: MessagePort | Promise<MessagePort> | RemoteTransport,
): BareCompatibleClient {
	return new BareCompatibleClient(
		port instanceof RemoteTransport ? port : new RemoteTransport(port),
	);
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
	/** the page's realm, whose errors the stand-in throws */
	global: typeof globalThis;
	socket: BareCompatibleWebSocket;
	opened: Promise<void>;
	closeRequest?: { code: number; reason: string };
	closeNow?: (code: number, reason: string) => void;
	/**
	 * a close() while connecting: the connection fails a task later, and
	 * nothing of the transport's socket reaches the page from then on
	 */
	fail?: () => void;
	failing?: boolean;
	/** the close event fired: CLOSED, whatever the transport says */
	closed: boolean;
	binaryType: BinaryType;
	url: string;
	/**
	 * bufferedAmount: the bytes the page sent that have not gone out yet,
	 * and every byte it sent once its close had started, which never goes
	 */
	buffered: number;
	/** settles once the last frame sent has left (or failed) */
	leaving?: Promise<unknown>;
}

/** each WebSocket stand-in's state, for the WebSocketStream stand-in's writes */
const socketStates = new WeakMap<object, SocketState>();

// --- the arguments, as Chrome's bindings convert them ---

const CONSTRUCT = "construct 'WebSocket'";
const SEND = "execute 'send' on 'WebSocket'";
const CLOSE = "execute 'close' on 'WebSocket'";

const isObject = (value: unknown): value is object =>
	(typeof value === 'object' && value !== null) || typeof value === 'function';

/**
 * A conversion the bindings refuse, in their words: the message names the
 * call (`context`), the stack's first line only what was refused (measured)
 */
function refusal(global: typeof globalThis, context: string, text: string) {
	const error = withStack(new global.TypeError(text));
	// (formatted now, from the refusal: a stack is formatted once)
	void error.stack;
	error.message = `Failed to ${context}: ${text}`;
	return error;
}

/** a DOMException of the page's realm with the browser's name and message */
const domError = (
	global: typeof globalThis,
	context: string,
	text: string,
	name: string,
) => withStack(new global.DOMException(`Failed to ${context}: ${text}`, name));

/**
 * The page's value as a primitive, as ToPrimitive makes it with `hint`:
 * what the page's own methods throw is thrown as it is, what the
 * conversion itself refuses carries `context`
 */
function toPrimitive(
	global: typeof globalThis,
	value: unknown,
	hint: 'string' | 'number',
	context: string,
): unknown {
	if (!isObject(value)) return value;
	const given = value as Record<PropertyKey, unknown>;
	const exotic = given[Symbol.toPrimitive];
	if (exotic !== undefined && exotic !== null) {
		if (typeof exotic !== 'function') {
			// (the engine's own words for a method that is none; nothing of
			// the page's runs before it refuses)
			let text = '';
			try {
				const raw: unknown = value;
				void (hint === 'string' ? `${raw as string}` : +(raw as number));
			} catch (error) {
				text = (error as Error).message;
			}
			throw refusal(global, context, text);
		}
		const made: unknown = Reflect.apply(exotic, value, [hint]);
		if (!isObject(made)) return made;
	} else
		for (const name of hint === 'string'
			? ['toString', 'valueOf']
			: ['valueOf', 'toString']) {
			const method = given[name];
			if (typeof method !== 'function') continue;
			const made: unknown = Reflect.apply(method, value, []);
			if (!isObject(made)) return made;
		}
	throw refusal(global, context, 'Cannot convert object to primitive value');
}

/** WebIDL's DOMString of the page's value */
function domString(
	global: typeof globalThis,
	value: unknown,
	context: string,
): string {
	const made = toPrimitive(global, value, 'string', context);
	if (typeof made === 'symbol')
		throw refusal(global, context, 'Cannot convert a Symbol value to a string');
	return `${made as string}`;
}

/** WebIDL's USVString: a surrogate without its pair reads U+FFFD */
const wellFormed = (text: string) =>
	text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		'\uFFFD',
	);

/**
 * WebIDL's `[Clamp] unsigned short` of the page's value, as Chrome makes
 * it: NaN is 0, and a fraction is cut off, never rounded (measured: 999.5
 * is 999, 4999.5 is 4999)
 */
function clampedShort(
	global: typeof globalThis,
	value: unknown,
	context: string,
): number {
	const made = toPrimitive(global, value, 'number', context);
	if (typeof made === 'symbol' || typeof made === 'bigint')
		throw refusal(
			global,
			context,
			`Cannot convert a ${typeof made === 'symbol' ? 'Symbol' : 'BigInt'} value to a number`,
		);
	const number = +(made as number);
	if (!(number > 0)) return 0;
	if (number >= 0xffff) return 0xffff;
	return Math.trunc(number);
}

/** a subprotocol's characters: a token's (RFC 7230), no separator */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A subprotocol as Chrome's message writes it: a character outside the
 * printable ASCII as `\uXXXX`, a backslash doubled
 */
const subprotocolText = (protocol: string) =>
	protocol.replace(/[^\x20-\x7e]|\\/g, (char) =>
		char === '\\'
			? '\\\\'
			: `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
	);

/**
 * The constructor's `protocols`, as the bindings convert it: none
 * (undefined) is no subprotocol, an object with an iterator a sequence of
 * strings, anything else one string
 */
function subprotocols(global: typeof globalThis, value: unknown): string[] {
	if (value === undefined) return [];
	if (!isObject(value)) return [domString(global, value, CONSTRUCT)];
	const method = (value as Record<PropertyKey, unknown>)[Symbol.iterator];
	if (method === undefined || method === null)
		return [domString(global, value, CONSTRUCT)];
	if (typeof method !== 'function')
		throw refusal(global, CONSTRUCT, '@@iterator must be a callable.');
	const list: string[] = [];
	const items = {
		[Symbol.iterator]: () =>
			Reflect.apply(method, value, []) as Iterator<unknown>,
	};
	for (const item of items) list.push(domString(global, item, CONSTRUCT));
	return list;
}

/**
 * Chrome's refusal of a list of subprotocols (a SyntaxError): every one
 * is checked to be a token before any is checked to be the only one of
 * its name
 */
function subprotocolError(
	global: typeof globalThis,
	protocols: string[],
): Error | null {
	for (const protocol of protocols)
		if (!TOKEN.test(protocol))
			return domError(
				global,
				CONSTRUCT,
				`The subprotocol '${subprotocolText(protocol)}' is invalid.`,
				'SyntaxError',
			);
	const seen = new Set<string>();
	for (const protocol of protocols) {
		if (seen.has(protocol))
			return domError(
				global,
				CONSTRUCT,
				`The subprotocol '${subprotocolText(protocol)}' is duplicated.`,
				'SyntaxError',
			);
		seen.add(protocol);
	}
	return null;
}

const toTag = Object.prototype.toString;
/**
 * What send() sends of `data`, as the browser converts its argument: a
 * Blob, a buffer or a view as it is (of any realm: a frame's page hands its
 * own), anything else as its USVString (null goes as "null", a lone
 * surrogate as U+FFFD)
 */
function sendable(
	global: typeof globalThis,
	data: unknown,
): string | ArrayBufferLike | Blob | ArrayBufferView {
	if (typeof data === 'string') return wellFormed(data);
	if (ArrayBuffer.isView(data)) return data;
	const tag = Reflect.apply(toTag, data, []) as string;
	if (
		tag === '[object ArrayBuffer]' ||
		tag === '[object SharedArrayBuffer]' ||
		tag === '[object Blob]' ||
		tag === '[object File]'
	)
		return data as ArrayBufferLike | Blob;
	return wellFormed(domString(global, data, SEND));
}

/** the bytes send() puts on the wire for `data` (sendable's; a string goes as UTF-8) */
function sentBytes(
	data: string | ArrayBufferLike | Blob | ArrayBufferView,
): number {
	if (typeof data === 'string') return new TextEncoder().encode(data).length;
	if ('size' in data) return data.size;
	return data.byteLength;
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
	const global = client.global as typeof globalThis;
	// the arguments as the bindings convert them, both before anything is
	// checked: the URL a USVString, the subprotocols a string or a sequence
	const url = wellFormed(domString(global, args[0], CONSTRUCT));
	const protocols = subprotocols(global, args[1]);

	// a URL the browser refuses (one that does not parse, another scheme,
	// a fragment) gets the browser's own error from the native
	// constructor, which throws before it connects anywhere
	let parsed: URL | null = null;
	if (!failsToParse(client, url)) parsed = new URL(url, client.baseHref);
	if (
		!parsed ||
		![...wsProtocols, 'http:', 'https:'].includes(parsed.protocol) ||
		parsed.href.includes('#')
	) {
		// (never connects: the browser threw)
		Reflect.construct(NativeWebSocket, [url]).close();
		throw domError(
			global,
			CONSTRUCT,
			`The URL '${url}' is invalid.`,
			'SyntaxError',
		);
	}

	// relative URLs resolve against the page, http(s) means ws(s)
	if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
	else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';

	// mixed content: no worker sees a WebSocket, so the page's own
	// URL decides here. Chrome upgrades ws: from an https page under
	// upgrade-insecure-requests first, and refuses it once the
	// subprotocols are checked (below)
	const mixed = mixedContent?.verdict(parsed, 'websocket');
	if (mixed?.action === 'upgrade') parsed = mixed.url;

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
	const workerRefused =
		refused === null && (policed.connectVerdict?.(parsed) ?? false);

	// a socket a policy refuses fails before its subprotocols are looked
	// at (measured); any other throws Chrome's SyntaxError for one that is
	// no token or is there twice, then its SecurityError for mixed content
	if (refused === null && !workerRefused) {
		const invalid = subprotocolError(global, protocols);
		if (invalid) throw invalid;
		if (mixed?.action === 'block') {
			mixedContent!.report([{ kind: 'websocket', url: parsed.href }]);
			throw domError(
				global,
				CONSTRUCT,
				'An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.',
				'SecurityError',
			);
		}
	}

	instances.add(target);

	// the socket's events and the data they carry are of its own realm,
	// natively: a frame whose window its parent's bundle hooked (it touched
	// the frame before it loaded) has a client of another realm than its
	// own, whose objects the page would tell apart
	const realm =
		client.global === (globalThis as unknown)
			? null
			: (client.global as typeof globalThis);
	const OwnEvent = realm?.Event ?? Event;

	const state = {
		global,
		closed: false,
		binaryType: 'blob',
		url: parsed.toString(),
		buffered: 0,
	} as SocketState;
	socketStates.set(target, state);

	// no Cookie here: the controller adds the jar's (HttpOnly included)
	// to the handshake, so the page never holds it
	const identity = client.userAgentIdentity;
	const sfString = (value: string) =>
		`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	const requestHeaders: RawHeaders = [
		['Origin', origin],
		['User-Agent', identity?.userAgent ?? navigator.userAgent],
		...(identity
			? ([
					[
						'Sec-CH-UA',
						identity.brands
							.map(
								({ brand, version }) =>
									`${sfString(brand)};v=${sfString(version)}`,
							)
							.join(', '),
					],
					['Sec-CH-UA-Mobile', identity.mobile ? '?1' : '?0'],
					['Sec-CH-UA-Platform', sfString(identity.uaPlatform)],
				] as RawHeaders)
			: []),
	];
	// a context in a partition: the controller reads it for the jar
	// (its Partitioned cookies, and SameSite as another site's)
	const partitionKey = partitionSite(client.partition);
	if (partitionKey !== null)
		requestHeaders.push([SOCKET_PARTITION, partitionKey]);

	// client.bare is created lazily; a failure there (no transport)
	// surfaces as an error event like a refused connection would.
	const socket = (state.socket =
		refused !== null
			? (Reflect.construct(NativeWebSocket, [
					refused,
				]) as unknown as BareCompatibleWebSocket)
			: workerRefused
				? refusedSocket()
				: client.bare.createWebSocket(parsed, protocols, requestHeaders));

	state.opened = new Promise<void>((resolve) => {
		socket.addEventListener('open', () => resolve(), {
			once: true,
		});
		socket.addEventListener('error', () => resolve(), {
			once: true,
		});
	});

	socket.addEventListener('open', () => {
		// (a socket the page closed while it connected never opens)
		if (state.failing) return;
		target.dispatchEvent(new OwnEvent('open'));
	});

	socket.addEventListener('message', async (event) => {
		// natively a message that arrives once the page's close has started
		// (the closing handshake under way) or the socket closed is dropped
		if (state.closeRequest || state.closed) return;
		let data = (event as MessageEvent).data;

		// transports deliver binary frames as ArrayBuffer or Blob;
		// present them according to binaryType
		if (typeof data !== 'string') {
			if (state.binaryType === 'blob' && (realm || !(data instanceof Blob))) {
				data = new (realm?.Blob ?? Blob)([data]);
			} else if (state.binaryType === 'arraybuffer') {
				if (data instanceof Blob) data = await data.arrayBuffer();
				if (realm) {
					const bytes = new Uint8Array(data as ArrayBuffer);
					const own = new realm.ArrayBuffer(bytes.byteLength);
					new realm.Uint8Array(own).set(bytes);
					data = own;
				}
			}
		}

		if (state.closeRequest || state.closed) return;
		// the origin of the socket's URL, as natively (not the URL)
		target.dispatchEvent(
			new (realm?.MessageEvent ?? MessageEvent)('message', {
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
			new (realm?.CloseEvent ?? CloseEvent)('close', {
				code,
				reason,
				wasClean: code !== 1006,
			}),
		);
	};
	state.closeNow = dispatchClose;

	// a close() while connecting fails the connection, as Chrome fails it
	// (measured): a task later an error and then a close with 1006, not
	// clean, both reading CLOSED. The transport's socket is closed once it
	// opens (close, below), and none of its events reaches the page. (A
	// socket a policy refused fails on its own)
	if (refused === null && !workerRefused)
		state.fail = () => {
			state.failing = true;
			setTimeout(() => {
				if (state.closed) return;
				state.closed = true;
				target.dispatchEvent(new OwnEvent('error'));
				dispatchClose(1006, '');
			});
		};

	// a connection that fails (refused, a TLS handshake that ends, one
	// a content blocker refuses) gets an error and then a close with
	// 1006 natively, one after the other in the same task and both
	// reading CLOSED; the transport reports the error only
	socket.addEventListener('error', () => {
		if (state.failing || state.closed) return;
		target.dispatchEvent(new OwnEvent('error'));
		// a socket the policy refused fires no close (measured)
		if (refused === null && !workerRefused) dispatchClose(1006, '');
		else state.closed = true;
	});

	socket.addEventListener('close', (event) => {
		if (state.failing) return;
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

/**
 * the stand-in's send(): what the page sent settles (true) once it has left
 * or (false) failed, and nothing comes back when nothing goes out (the
 * page's close has started); WebSocketStream's writes wait on it
 */
function send(
	state: SocketState,
	target: EventTarget,
	given: unknown,
): Promise<boolean> | undefined {
	// (the argument is converted before the state is looked at)
	const data = sendable(state.global, given);
	if (
		!state.closeRequest &&
		!state.closed &&
		state.socket.readyState === CONNECTING
	)
		throw domError(
			state.global,
			SEND,
			'Still in CONNECTING state.',
			'InvalidStateError',
		);

	// what the page sends counts in bufferedAmount until it has left: the
	// transport's send settles once the frame was written within the wisp
	// stream's flow control (src/transport/socketSends.ts), never while the
	// page's script runs. Once the page's close has started, or the socket closed,
	// nothing more goes out, natively: the bytes stay counted and that is
	// all (through the proxy they went out ahead of the close frame, which
	// the transport is given a microtask later, and a server's answer to
	// them reached the page)
	const size = sentBytes(data);
	state.buffered += size;
	if (state.closeRequest || state.closed) return;

	// the transport takes a buffer over to its worker, which detaches it:
	// the page's own stays as it was, natively, so the transport is given a
	// copy (of a view, of its bytes only)
	const sent =
		!ArrayBuffer.isView(data) && typeof data !== 'string' && !('size' in data)
			? data.slice(0)
			: ArrayBuffer.isView(data)
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
						.buffer
				: data;

	// BareCompatibleWebSocket's send drops what the transport's answers
	// (RemoteTransport's: settled once the frame left), so the transport's
	// is called itself, as that send calls it once the socket is open; the
	// transport may still reject, which the native API would surface as a
	// close/error event
	const socket = state.socket as unknown as {
		_data?: (data: string | ArrayBuffer | Blob) => unknown;
	};
	const payload = sent as string | ArrayBuffer | Blob;
	const leaving =
		typeof socket._data === 'function'
			? new Promise((resolve) => resolve(socket._data!(payload)))
			: state.socket.send(payload);
	const left = leaving.then(
		() => {
			state.buffered -= size;
			return true;
		},
		(error) => {
			console.error(error);
			target.dispatchEvent(new Event('error'));
			return false;
		},
	);
	state.leaving = left;
	return left;
}

/** the stand-in's close() */
function close(state: SocketState, args: unknown[]) {
	const { global } = state;
	// the arguments the page gave, but those undefined at the end, as
	// Chrome's bindings count them (close(undefined, reason) has a code
	// of 0, measured): the code a [Clamp] unsigned short, the reason a
	// USVString, both converted before either is checked
	let count = args.length;
	while (count && args[count - 1] === undefined) count--;
	const code = count > 0 ? clampedShort(global, args[0], CLOSE) : undefined;
	const reason = count > 1 ? wellFormed(domString(global, args[1], CLOSE)) : '';
	if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
		throw domError(
			global,
			CLOSE,
			`The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
			'InvalidAccessError',
		);
	if (new TextEncoder().encode(reason).length > 123)
		throw domError(
			global,
			CLOSE,
			'The close reason must not be greater than 123 UTF-8 bytes.',
			'SyntaxError',
		);

	// closing or closed: nothing more (a socket a policy refused is
	// closed from the start)
	if (state.closeRequest || state.closed || state.socket.readyState === CLOSED)
		return;
	// no code is a close frame without a status, which the server
	// echoes and the page reads as 1005; the transport is given 1000,
	// since it takes no empty close
	state.closeRequest = { code: code ?? 1005, reason };
	if (state.socket.readyState === CONNECTING) state.fail?.();

	// the transport connection may not exist yet
	state.opened.then(() => {
		if (state.socket.readyState !== OPEN) return;
		// (one the page closed while it connected only goes)
		if (state.failing) return void state.socket.close(1000, '');
		const { code, reason } = state.closeRequest!;
		state.socket.close(code === 1005 ? 1000 : code, reason);
		// epoxy reports no close for a close that carries anything but
		// 1000 and no reason (measured): the page's close event comes
		// once the server had time to answer, as the browser's would. The
		// close frame goes after what the page sent before it, so the time
		// starts once that has left
		void Promise.resolve(state.leaving).then(() =>
			setTimeout(() => state.closeNow?.(code, reason), CLOSE_ANSWER_MS),
		);
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
				// a write settles once its message has left, as Chrome's
				// settles once its network service took it, so writer.ready
				// and desiredSize (a high water mark of one write) hold a
				// writer back while the transport's stream has no room
				// (bufferedAmount's measure, src/transport/socketSends.ts).
				// The stand-in's own send, not the page's WebSocket's
				// send(), which Chrome's stream never calls. A message still
				// going when the socket ends never leaves, and its write
				// fails then, as the socket's end errors Chrome's writable
				const own = socketStates.get(socket);
				const ended = new Promise<never>((_, reject) => {
					const end = () =>
						reject(networkError('The WebSocket connection was closed.'));
					socket.addEventListener('close', end, { once: true });
					socket.addEventListener('error', end, { once: true });
				});
				ended.catch(() => {});
				const writable = new WritableStream({
					write(chunk) {
						if (!own) return void socket.send(chunk);
						const left = send(own, socket, chunk);
						if (!left) return;
						return Promise.race([
							left.then((ok) => {
								if (!ok) throw networkError('The WebSocket connection failed.');
							}),
							ended,
						]);
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
