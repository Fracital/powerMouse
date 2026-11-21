import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import { isPortBody, receiveCounted } from './bodyPort';
import {
	HostToTransport,
	postToPort,
	transferablesOf,
	TRANSPORT_GONE,
	TRANSPORT_RPC,
	TransportToHost,
	WebSocketMessage,
} from './messages';
import { closePort, listenOn, onPort, privateChannel } from './ports';
import { RpcHelper } from './rpc';

/**
 * Chrome closes a document's WebSockets (1001) as it goes: it navigated
 * away, its frame was removed. A worker never hears a document go (Chrome
 * 157 fires no MessagePort close event unless MessagePortCloseEvent is on),
 * so the document's sockets are closed on its pagehide; else each stayed
 * open in the transport, its upstream connection and Wisp stream with it,
 * for as long as the server kept it.
 */
const openSockets = new Set<() => void>();
let hearsHide = false;
function closedOnHide(close: () => void) {
	openSockets.add(close);
	if (hearsHide || typeof document === 'undefined') return;
	hearsHide = true;
	listenOn(globalThis, 'pagehide', (event) => {
		if (event.isTrusted) for (const close of openSockets) close();
	});
}

/**
 * A ProxyTransport whose implementation lives on the other end of a MessagePort.
 * The other end is served by `serveTransport()`.
 */
export default class RemoteTransport implements ProxyTransport {
	/**
	 * hears the worker's name for an image's request that waits for a
	 * connection (REQUEST_QUEUE): the service worker tells its document
	 */
	static waiting: ((id: string) => void) | null = null;
	ready = false;
	private readyPromise: Promise<void>;
	private readyResolve!: () => void;
	protected rpc: RpcHelper<HostToTransport, TransportToHost>;
	private port: Promise<MessagePort>;
	/** what ends each socket open over this transport, once its serving side is gone */
	private sockets = new Set<() => void>();
	constructor(port: MessagePort | Promise<MessagePort>) {
		this.readyPromise = new Promise((resolve) => (this.readyResolve = resolve));

		this.rpc = new RpcHelper<HostToTransport, TransportToHost>(
			{
				ready: async () => {
					this.readyResolve();
				},
				waiting: async (id) => {
					RemoteTransport.waiting?.(id);
				},
			},
			TRANSPORT_RPC,
			(data, transfer) => {
				this.port.then((port) => postToPort(port, data, transfer));
			},
		);

		this.port = Promise.resolve(port).then((port) => {
			// listened to with the browser's own methods, trusted messages
			// only: in a page's realm, the page may have replaced them by now
			// (src/transport/ports.ts)
			onPort(port, 'message', (data) => {
				if (typeof data === 'object' && data !== null && TRANSPORT_GONE in data)
					this.gone(port);
				else this.rpc.receive(data);
			});
			onPort(port, 'messageerror', () =>
				console.error('RemoteTransport port messageerror'),
			);
			// (a Chrome with MessagePortCloseEvent on says it too)
			onPort(port, 'close', () => this.gone(port));
			return port;
		});
	}
	/**
	 * The serving side is gone (its tab closed or navigated, its worker
	 * went, it let go of this port; it says so with TRANSPORT_GONE, as
	 * Chrome 157 fires no close event): a request on this port would never
	 * be answered, so every pending and later one fails at once, and each
	 * socket ends as one whose connection dropped (1006)
	 */
	private gone(port: MessagePort) {
		this.rpc.abort('Stomp: the transport port closed');
		for (const end of [...this.sockets]) end();
		closePort(port);
	}
	/** fail every pending and later call with `reason` and close the port (the host side replaced it) */
	close(reason: string) {
		this.rpc.abort(reason);
		this.port.then((port) => closePort(port));
	}
	async init() {
		await this.readyPromise;
		this.ready = true;
	}
	/** have the transport served on `port` as well, as on this one (TransportToHost serve) */
	serve(port: MessagePort) {
		this.rpc.call('serve', port, [port]).catch(() => {});
	}
	/** cancel or raise the request named `id` while it waits for a connection (socketPool.ts) */
	requeue(id: string, op: 'cancel' | 'raise') {
		this.rpc.call('requeue', { id, op }).catch(() => {});
	}
	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		// AbortSignal can't cross a MessagePort
		_signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		const response = await this.rpc.call(
			'request',
			{ remote: remote.href, method, body, headers },
			transferablesOf(body),
		);
		const { body: sent, ...rest } = response;
		// (with the transport's count of the bytes it came as: responseFacts.ts)
		return isPortBody(sent)
			? { ...rest, ...receiveCounted(sent) }
			: { ...rest, body: sent };
	}
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void,
	): [
		/** settles once the frame has left (bufferedAmount) */
		(data: WebSocketDataType) => Promise<void> | void,
		(code: number, reason: string) => void,
	] {
		const [port, theirs] = privateChannel();
		const closeSocket = (code: number, reason: string) => {
			openSockets.delete(goes);
			postToPort(port, {
				type: 'close',
				code,
				reason,
			} satisfies WebSocketMessage);
		};
		const goes = () => closeSocket(1001, '');
		closedOnHide(goes);
		// frames travel on their own port and can overtake the connect
		// response on the rpc port; hold them until onopen has run
		let opened = false;
		let over = false;
		/** the socket is done with: true the first time only */
		const finish = () => {
			if (over) return false;
			over = true;
			openSockets.delete(goes);
			this.sockets.delete(dropped);
			return true;
		};
		/** the socket's last word to the page: the serving side's close, or that it went */
		const ended = (code: number, reason: string) => {
			if (!finish()) return;
			closePort(port);
			onclose(code, reason);
		};
		const failed = (error: string) => {
			if (finish()) onerror(error);
		};
		const dropped = () =>
			opened ? ended(1006, '') : failed('Stomp: the transport port closed');
		this.sockets.add(dropped);
		const pending: WebSocketMessage[] = [];
		// each frame's send settles once the serving side says it has left
		// (socketSends.ts): the page's bufferedAmount. A serving side that
		// says nothing of it (acks unset) settles each at once
		let acks = false;
		const leaving: (() => void)[] = [];
		const deliver = (data: WebSocketMessage) => {
			if (over) return;
			if (data.type === 'data') onmessage(data.data);
			else if (data.type === 'sent') leaving.shift()?.();
			else if (data.type === 'close') ended(data.code, data.reason);
		};

		this.rpc
			.call(
				'connect',
				{ url: url.href, protocols, requestHeaders, port: theirs },
				[theirs],
			)
			.then((response) => {
				if (over) return;
				if (response.result === 'success') {
					acks = response.acks === true;
					onopen(response.protocol, response.extensions);
					opened = true;
					for (const data of pending.splice(0)) deliver(data);
				} else failed(response.error);
			})
			.catch((error) => failed(String(error)));

		onPort(port, 'message', (data) => {
			if (opened) deliver(data as WebSocketMessage);
			else pending.push(data as WebSocketMessage);
		});
		onPort(port, 'messageerror', () =>
			onerror('Message error in transport port'),
		);

		return [
			(data) => {
				postToPort(
					port,
					{ type: 'data', data } satisfies WebSocketMessage,
					transferablesOf(data),
				);
				// (a frame of a socket that ended never leaves)
				if (acks && !over)
					return new Promise<void>((resolve) => leaving.push(resolve));
			},
			closeSocket,
		];
	}
}
