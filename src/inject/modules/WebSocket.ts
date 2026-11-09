import type {
	BareCompatibleWebSocket,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { urlLike } from '../../StompURL';
import Client from '../Client';
import Module from '../Module';
import { failsToParse, withStack } from '../nativeErrors';
import ProxyModule, {
	classConstant,
	newConstructor,
	onEventTarget,
} from './Proxy';

const wsProtocols = ['ws:', 'wss:'];

export default class WebSocketModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const client = this.client;
		const instances = new WeakSet();
		const { origin } = this.client.url.url;
		const NativeWebSocket = this.client.global.WebSocket;
		const { CONNECTING, OPEN, CLOSING, CLOSED } = NativeWebSocket;

		class MockWebSocket extends EventTarget {
			#socket: BareCompatibleWebSocket;
			#opened: Promise<void>;
			#closeRequest?: { code: number; reason: string };
			#binaryType: BinaryType = 'blob';
			#url = '';
			constructor(...args: [url: urlLike, protocol?: string | string[]]) {
				super();

				const [url, protocol] = args;

				// a URL the browser refuses (none, one that does not parse, another
				// scheme, a fragment) gets the browser's own error from the native
				// constructor, which throws before it connects anywhere
				let parsed: URL | null = null;
				if (args.length && !failsToParse(client, String(url)))
					parsed = new URL(String(url), client.url.toString());
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

				instances.add(this);

				this.#url = parsed.toString();

				// no Cookie here: the controller adds the jar's (HttpOnly included)
				// to the handshake, so the page never holds it
				const requestHeaders: RawHeaders = [
					['Origin', origin],
					['User-Agent', navigator.userAgent],
				];

				// client.bare is created lazily; a failure there (no transport)
				// surfaces as an error event like a refused connection would.
				this.#socket = client.bare.createWebSocket(
					parsed,
					protocol,
					requestHeaders,
				);

				this.#opened = new Promise<void>((resolve) => {
					this.#socket.addEventListener('open', () => resolve(), {
						once: true,
					});
					this.#socket.addEventListener('error', () => resolve(), {
						once: true,
					});
				});

				this.#socket.addEventListener('open', () => {
					this.dispatchEvent(new Event('open'));
				});

				this.#socket.addEventListener('message', async (event) => {
					let data = (event as MessageEvent).data;

					// transports deliver binary frames as ArrayBuffer or Blob;
					// present them according to binaryType
					if (typeof data !== 'string') {
						if (this.#binaryType === 'blob' && !(data instanceof Blob)) {
							data = new Blob([data]);
						} else if (
							this.#binaryType === 'arraybuffer' &&
							data instanceof Blob
						) {
							data = await data.arrayBuffer();
						}
					}

					this.dispatchEvent(
						new MessageEvent('message', { data, origin: this.#url }),
					);
				});

				this.#socket.addEventListener('error', () => {
					this.dispatchEvent(new Event('error'));
				});

				this.#socket.addEventListener('close', (event) => {
					let { code, reason } = event as CloseEvent;

					// transports don't relay the close handshake; when the page
					// initiated the close, report what it asked for like a browser
					if (this.#closeRequest && !code) {
						({ code, reason } = this.#closeRequest);
					}

					this.dispatchEvent(
						new CloseEvent('close', {
							code,
							reason,
							wasClean: code === 1000 || !!this.#closeRequest,
						}),
					);
				});
			}
			get url() {
				return this.#url;
			}
			get protocol() {
				return this.#socket.protocol;
			}
			get extensions() {
				return this.#socket.extensions;
			}
			get readyState() {
				if (this.#closeRequest && this.#socket.readyState === OPEN)
					return CLOSING;
				return this.#socket.readyState;
			}
			get bufferedAmount() {
				return 0;
			}
			get binaryType() {
				return this.#binaryType;
			}
			set binaryType(value) {
				if (value === 'blob' || value === 'arraybuffer')
					this.#binaryType = value;
			}
			send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
				if (this.#socket.readyState === CONNECTING) {
					throw new DOMException(
						`Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.`,
					);
				}

				// resolved by then; the transport may still reject, which the
				// native API would surface as a close/error event
				this.#socket
					.send(data as string | ArrayBuffer | Blob)
					.catch((error) => {
						console.error(error);
						this.dispatchEvent(new Event('error'));
					});
			}
			close(code?: number, reason?: string) {
				if (typeof code !== 'undefined') {
					if (typeof code !== 'number') {
						code = 0;
					}

					if (code !== 1000 && (code < 3000 || code > 4999)) {
						throw new DOMException(
							`Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
						);
					}
				}

				if (this.#closeRequest) return;
				this.#closeRequest = { code: code ?? 1000, reason: reason ?? '' };

				// the transport connection may not exist yet
				this.#opened.then(() => {
					if (this.#socket.readyState === OPEN)
						this.#socket.close(
							this.#closeRequest!.code,
							this.#closeRequest!.reason,
						);
				});
			}
		}

		const globalWebSocketProxy = newConstructor(MockWebSocket);
		onEventTarget(globalWebSocketProxy.prototype, 'close');
		onEventTarget(globalWebSocketProxy.prototype, 'open');
		onEventTarget(globalWebSocketProxy.prototype, 'message');
		onEventTarget(globalWebSocketProxy.prototype, 'error');
		classConstant(globalWebSocketProxy, 'CONNECTING', CONNECTING);
		classConstant(globalWebSocketProxy, 'OPEN', OPEN);
		classConstant(globalWebSocketProxy, 'CLOSING', CLOSING);
		classConstant(globalWebSocketProxy, 'CLOSED', CLOSED);
		proxyModule.mirrorClass(
			this.client.global.WebSocket,
			globalWebSocketProxy,
			instances,
		);

		// WebSocketStream (Chrome): the same connection through the proxied
		// WebSocket, with the streams API the page expects. Only where the
		// browser has it, so feature detection stays truthful.
		const nativeStream = (
			this.client.global as { WebSocketStream?: new (...args: any[]) => any }
		).WebSocketStream;
		if (typeof nativeStream === 'function') {
			const streamInstances = new WeakSet();
			const networkError = (message: string) =>
				new DOMException(message, 'NetworkError');
			class MockWebSocketStream {
				#socket: MockWebSocket;
				#url: string;
				#opened: Promise<{
					readable: ReadableStream;
					writable: WritableStream;
					extensions: string;
					protocol: string;
				}>;
				#closed: Promise<{ closeCode: number; reason: string }>;
				constructor(
					...args: [
						url: urlLike,
						options?: { protocols?: string | string[]; signal?: AbortSignal },
					]
				) {
					if (!args.length)
						throw new TypeError(
							"Failed to construct 'WebSocketStream': 1 argument required, but only 0 present.",
						);
					const [url, options = {}] = args;
					const socket = new globalWebSocketProxy(
						url,
						options.protocols,
					) as unknown as MockWebSocket;
					socket.binaryType = 'arraybuffer';
					this.#socket = socket;
					this.#url = socket.url;
					streamInstances.add(this);

					let resolveClosed!: (value: {
						closeCode: number;
						reason: string;
					}) => void;
					let rejectClosed!: (reason: unknown) => void;
					this.#closed = new Promise((resolve, reject) => {
						resolveClosed = resolve;
						rejectClosed = reject;
					});
					this.#opened = new Promise((resolve, reject) => {
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
								const error = networkError(
									'WebSocketStream: the connection failed.',
								);
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
					this.#opened.catch(() => {});
					this.#closed.catch(() => {});
					options.signal?.addEventListener('abort', () => socket.close(), {
						once: true,
					});
				}
				get url() {
					return this.#url;
				}
				get opened() {
					return this.#opened;
				}
				get closed() {
					return this.#closed;
				}
				close(options: { closeCode?: number; reason?: string } = {}) {
					this.#socket.close(options.closeCode, options.reason);
				}
			}
			const streamProxy = newConstructor(MockWebSocketStream);
			proxyModule.mirrorClass(nativeStream, streamProxy, streamInstances);
			(this.client.global as { WebSocketStream?: unknown }).WebSocketStream =
				streamProxy;
		}

		this.client.global.WebSocket =
			globalWebSocketProxy as unknown as typeof WebSocket;
	}
}
