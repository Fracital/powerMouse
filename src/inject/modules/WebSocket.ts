import type { urlLike } from '../../StompURL';
import type { SocketState, StreamState } from '../bareClient';
import Client from '../Client';
import Module from '../Module';
import { LazyWeakSet } from '../ownCollections';
import { socketParts } from '../socketParts';
import MixedContentModule from './MixedContent';
import ProxyModule, { classConstant, onEventTarget } from './Proxy';

export default class WebSocketModule extends Module<Client> {
	apply() {
		const client = this.client;
		const realm = client.global;
		const proxyModule = client.getModule(ProxyModule)!;
		const instances = new LazyWeakSet();
		const { origin } = client.url.url;
		const NativeWebSocket = realm.WebSocket;
		const { CONNECTING, OPEN, CLOSING, CLOSED } = NativeWebSocket;

		const mixedContent = client.getModule(MixedContentModule);
		// what an instance does is a deferred part of the document bundle
		// (../socketParts.ts), made as a page constructs its first socket,
		// before anything of the browser's is called: without it the
		// construction throws
		const parts = () => socketParts.standIns!();

		class MockWebSocket extends EventTarget {
			#s: SocketState;
			constructor(...args: [url: urlLike, protocol?: string | string[]]) {
				super();
				this.#s = parts().open(
					client,
					NativeWebSocket,
					mixedContent,
					instances,
					origin,
					this,
					args,
				);
			}
			get url() {
				return this.#s.url;
			}
			get protocol() {
				return this.#s.socket.protocol;
			}
			get extensions() {
				return this.#s.socket.extensions;
			}
			get readyState() {
				const state = this.#s;
				if (state.closed) return CLOSED;
				if (state.closeRequest && state.socket.readyState === OPEN)
					return CLOSING;
				return state.socket.readyState;
			}
			get bufferedAmount() {
				return 0;
			}
			get binaryType() {
				return this.#s.binaryType;
			}
			set binaryType(value) {
				if (value === 'blob' || value === 'arraybuffer')
					this.#s.binaryType = value;
			}
			send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
				const state = this.#s;
				parts().send(state, this, data);
			}
			close(code?: number, reason?: string) {
				const state = this.#s;
				parts().close(state, code, reason);
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
		proxyModule.mirrorClass(realm.WebSocket, globalWebSocketProxy, instances);

		// WebSocketStream (Chrome): the same connection through the proxied
		// WebSocket, with the streams API the page expects. Only where the
		// browser has it, so feature detection stays truthful.
		const nativeStream = (
			realm as { WebSocketStream?: new (...args: any[]) => any }
		).WebSocketStream;
		if (typeof nativeStream === 'function') {
			const streamInstances = new LazyWeakSet();
			class MockWebSocketStream {
				#s: StreamState;
				constructor(
					...args: [
						url: urlLike,
						options?: { protocols?: string | string[]; signal?: AbortSignal },
					]
				) {
					this.#s = parts().stream(
						globalWebSocketProxy as unknown as typeof WebSocket,
						streamInstances,
						this,
						args,
					);
				}
				get url() {
					return this.#s.url;
				}
				get opened() {
					return this.#s.opened;
				}
				get closed() {
					return this.#s.closed;
				}
				close(options: { closeCode?: number; reason?: string } = {}) {
					this.#s.socket.close(options.closeCode, options.reason);
				}
			}
			const streamProxy = proxyModule.standInClass(
				MockWebSocketStream,
				nativeStream,
			);
			proxyModule.mirrorClass(nativeStream, streamProxy, streamInstances);
			(realm as { WebSocketStream?: unknown }).WebSocketStream = streamProxy;
		}

		realm.WebSocket = globalWebSocketProxy as unknown as typeof WebSocket;
	}
}
