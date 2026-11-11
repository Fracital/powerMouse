import type {
	BareCompatibleWebSocket,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { partitionSite } from '../../partition';
import { urlLike } from '../../StompURL';
import { SOCKET_PARTITION } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { failsToParse, withStack } from '../nativeErrors';
import MixedContentModule from './MixedContent';
import ProxyModule, { classConstant, onEventTarget } from './Proxy';

const wsProtocols = ['ws:', 'wss:'];
/** how long a close the page started waits for the transport's word */
const CLOSE_ANSWER_MS = 500;

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
			#closeNow?: (code: number, reason: string) => void;
			/** the close event fired: CLOSED, whatever the transport says */
			#closed = false;
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

				// mixed content: no worker sees a WebSocket, so the page's own
				// URL decides here. Chrome refuses ws: from an https page before
				// connecting, and upgrades it under upgrade-insecure-requests
				const mixed = client
					.getModule(MixedContentModule)
					?.verdict(parsed, 'websocket');
				if (mixed?.action === 'block') {
					client
						.getModule(MixedContentModule)!
						.report([{ kind: 'websocket', url: parsed.href }]);
					throw withStack(
						new client.global.DOMException(
							"Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.",
							'SecurityError',
						),
					);
				}
				if (mixed?.action === 'upgrade') parsed = mixed.url;

				instances.add(this);

				this.#url = parsed.toString();

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

				// one close event, as the browser fires it
				let closed = false;
				const dispatchClose = (code: number, reason: string) => {
					if (closed) return;
					closed = true;
					this.#closed = true;
					this.dispatchEvent(
						new CloseEvent('close', { code, reason, wasClean: code !== 1006 }),
					);
				};
				this.#closeNow = dispatchClose;

				// a connection that fails (refused, a TLS handshake that ends, one
				// a content blocker refuses) gets an error and then a close with
				// 1006 natively, one after the other in the same task and both
				// reading CLOSED; the transport reports the error only
				this.#socket.addEventListener('error', () => {
					this.dispatchEvent(new Event('error'));
					dispatchClose(1006, '');
				});

				this.#socket.addEventListener('close', (event) => {
					let { code, reason } = event as CloseEvent;

					// transports don't relay the close handshake; when the page
					// initiated the close, report what it asked for like a browser
					// (1005, no status, for a close() without a code)
					if (this.#closeRequest) ({ code, reason } = this.#closeRequest);
					// a close frame without a status reads 1005 natively (the
					// transport passes the server's status and reason on, and a
					// transport that has neither reports nothing)
					else if (!code) code = 1005;

					dispatchClose(code, reason);
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
				if (this.#closed) return CLOSED;
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
				// no code is a close frame without a status, which the server
				// echoes and the page reads as 1005; the transport is given 1000,
				// since it takes no empty close
				this.#closeRequest = { code: code ?? 1005, reason: reason ?? '' };

				// the transport connection may not exist yet
				this.#opened.then(() => {
					if (this.#socket.readyState !== OPEN) return;
					const { code, reason } = this.#closeRequest!;
					this.#socket.close(code === 1005 ? 1000 : code, reason);
					// epoxy reports no close for a close that carries anything but
					// 1000 and no reason (measured): the page's close event comes
					// once the server had time to answer, as the browser's would
					setTimeout(() => this.#closeNow?.(code, reason), CLOSE_ANSWER_MS);
				});
			}
		}

		const globalWebSocketProxy = proxyModule.standInClass(
			MockWebSocket,
			NativeWebSocket,
		);
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
			const streamProxy = proxyModule.standInClass(
				MockWebSocketStream,
				nativeStream,
			);
			proxyModule.mirrorClass(nativeStream, streamProxy, streamInstances);
			(this.client.global as { WebSocketStream?: unknown }).WebSocketStream =
				streamProxy;
		}

		this.client.global.WebSocket =
			globalWebSocketProxy as unknown as typeof WebSocket;
	}
}
