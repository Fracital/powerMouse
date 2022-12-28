import { urlLike } from '../../StompURL';
import Client from '../Client';
import Module from '../Module';
import { CookiesModule } from '../dom/modules/Cookies';
import ProxyModule, {
	classConstant,
	newConstructor,
	onEventTarget,
} from './Proxy';
import { BareHeaders, BareWebSocket } from '@tomphttp/bare-client';

const wsProtocols = ['ws:', 'wss:'];

export default class WebSocketModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const cookiesModule = this.client.getModule(CookiesModule)!;
		const { bare } = this.client;
		const instances = new WeakSet();
		const { origin } = this.client.url.url;
		const { CONNECTING } = this.client.global.WebSocket;

		class MockWebSocket extends EventTarget {
			#socket?: BareWebSocket;
			#ready: Promise<void>;
			#binaryType: BinaryType = 'blob';
			#protocol = '';
			#extensions = '';
			#url = '';
			async #open(url: URL, protocol?: string | string[]) {
				const requestHeaders: BareHeaders = {};
				Reflect.setPrototypeOf(requestHeaders, null);

				requestHeaders['Origin'] = origin;
				requestHeaders['User-Agent'] = navigator.userAgent;

				const cookie = cookiesModule.pageCookies;
				if (cookie !== '') requestHeaders['Cookie'] = cookie;

				this.#socket = await bare.createWebSocket(
					url,
					requestHeaders,
					protocol
				);

				this.#socket.binaryType = this.#binaryType;

				this.#socket.addEventListener('message', (event) => {
					this.dispatchEvent(
						new MessageEvent('message', event as unknown as MessageEventInit)
					);
				});

				this.#socket.addEventListener('open', async (event) => {
					this.dispatchEvent(new Event('open', event));
				});

				this.#socket.addEventListener('error', (event) => {
					this.dispatchEvent(new ErrorEvent('error', event));
				});

				this.#socket.addEventListener('close', (event) => {
					this.dispatchEvent(new Event('close', event));
				});

				const meta = await this.#socket.meta;

				if (meta.headers?.has('sec-websocket-protocol'))
					this.#protocol = meta.headers.get('sec-websocket-protocol')!;

				if (meta.headers?.has('sec-websocket-extensions'))
					this.#extensions = meta.headers.get('sec-websocket-extensions')!;

				let setCookie =
					(meta.rawHeaders && meta.rawHeaders['set-cookie']) || [];
				if (!Array.isArray(setCookie)) setCookie = [];
				// trip the hook
				for (const cookie of setCookie) document.cookie = cookie;
			}
			get url() {
				return this.#url;
			}
			constructor(...args: [url: urlLike, protocol?: string | string[]]) {
				super();

				if (!args.length)
					throw new DOMException(
						`Failed to construct 'WebSocket': 1 argument required, but only 0 present.`
					);

				const [url, protocol] = args;

				let parsed;

				try {
					parsed = new URL(url);
				} catch (err) {
					throw new DOMException(
						`Faiiled to construct 'WebSocket': The URL '${url}' is invalid.`
					);
				}

				if (!wsProtocols.includes(parsed.protocol)) {
					throw new DOMException(
						`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol}' is not allowed.`
					);
				}

				instances.add(this);

				this.#ready = this.#open(parsed, protocol);
			}
			get protocol() {
				return this.#protocol;
			}
			get extensions() {
				return this.#extensions;
			}
			get readyState() {
				if (this.#socket) {
					return this.#socket.readyState;
				} else {
					return CONNECTING;
				}
			}
			get binaryType() {
				return this.#binaryType;
			}
			set binaryType(value) {
				this.#binaryType = value;

				if (this.#socket) {
					this.#socket.binaryType = value;
				}
			}
			send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
				if (!this.#socket) {
					throw new DOMException(
						`Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.`
					);
				}
				this.#socket.send(data);
			}
			close(code?: number, reason?: string) {
				if (typeof code !== 'undefined') {
					if (typeof code !== 'number') {
						code = 0;
					}

					if (code !== 1000 && (code < 3000 || code > 4999)) {
						throw new DOMException(
							`Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999. ${code} is neither.`
						);
					}
				}

				this.#ready.then(() => this.#socket!.close(code, reason));
			}
		}

		const globalWebSocketProxy = newConstructor(MockWebSocket);
		onEventTarget(globalWebSocketProxy.prototype, 'close');
		onEventTarget(globalWebSocketProxy.prototype, 'open');
		onEventTarget(globalWebSocketProxy.prototype, 'message');
		onEventTarget(globalWebSocketProxy.prototype, 'error');
		classConstant(
			globalWebSocketProxy,
			'CONNECTING',
			this.client.global.WebSocket.CONNECTING
		);
		classConstant(
			globalWebSocketProxy,
			'OPEN',
			this.client.global.WebSocket.OPEN
		);
		classConstant(
			globalWebSocketProxy,
			'CLOSING',
			this.client.global.WebSocket.CLOSING
		);
		classConstant(
			globalWebSocketProxy,
			'CLOSED',
			this.client.global.WebSocket.CLOSED
		);
		proxyModule.mirrorClass(
			this.client.global.WebSocket,
			globalWebSocketProxy,
			instances
		);

		this.client.global.WebSocket =
			globalWebSocketProxy as unknown as typeof WebSocket;
	}
}
