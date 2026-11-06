import type {
	BareCompatibleWebSocket,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { urlLike } from '../../StompURL';
import Client from '../Client';
import { CookiesModule } from '../dom/modules/Cookies';
import Module from '../Module';
import ProxyModule, {
	classConstant,
	newConstructor,
	onEventTarget,
} from './Proxy';

const wsProtocols = ['ws:', 'wss:'];

export default class WebSocketModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const cookiesModule = this.client.getModule(CookiesModule);
		const client = this.client;
		const instances = new WeakSet();
		const { origin } = this.client.url.url;
		const { CONNECTING, OPEN, CLOSING, CLOSED } = this.client.global.WebSocket;

		class MockWebSocket extends EventTarget {
			#socket: BareCompatibleWebSocket;
			#opened: Promise<void>;
			#closeRequest?: { code: number; reason: string };
			#binaryType: BinaryType = 'blob';
			#url = '';
			constructor(...args: [url: urlLike, protocol?: string | string[]]) {
				super();

				if (!args.length)
					throw new DOMException(
						`Failed to construct 'WebSocket': 1 argument required, but only 0 present.`,
					);

				const [url, protocol] = args;

				let parsed: URL;

				try {
					parsed = new URL(url);
				} catch {
					throw new DOMException(
						`Failed to construct 'WebSocket': The URL '${url}' is invalid.`,
					);
				}

				if (!wsProtocols.includes(parsed.protocol)) {
					throw new DOMException(
						`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol}' is not allowed.`,
					);
				}

				instances.add(this);

				this.#url = parsed.toString();

				const requestHeaders: RawHeaders = [
					['Origin', origin],
					['User-Agent', navigator.userAgent],
				];

				const cookie = cookiesModule?.pageCookies;
				if (cookie) requestHeaders.push(['Cookie', cookie]);

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

		this.client.global.WebSocket =
			globalWebSocketProxy as unknown as typeof WebSocket;
	}
}
