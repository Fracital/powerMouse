import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import { isPortBody, receiveBody } from './bodyPort';
import {
	HostToTransport,
	postToPort,
	transferablesOf,
	TRANSPORT_RPC,
	TransportToHost,
	WebSocketMessage,
} from './messages';
import { closePort, onPort, privateChannel } from './ports';
import { RpcHelper } from './rpc';

/**
 * A ProxyTransport whose implementation lives on the other end of a MessagePort.
 * The other end is served by `serveTransport()`.
 */
export default class RemoteTransport implements ProxyTransport {
	ready = false;
	private readyPromise: Promise<void>;
	private readyResolve!: () => void;
	protected rpc: RpcHelper<HostToTransport, TransportToHost>;
	private port: Promise<MessagePort>;
	constructor(port: MessagePort | Promise<MessagePort>) {
		this.readyPromise = new Promise((resolve) => (this.readyResolve = resolve));

		this.rpc = new RpcHelper<HostToTransport, TransportToHost>(
			{
				ready: async () => {
					this.readyResolve();
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
			onPort(port, 'message', (data) => this.rpc.receive(data));
			onPort(port, 'messageerror', () =>
				console.error('RemoteTransport port messageerror'),
			);
			// the serving side is gone (its tab closed, its worker died): a
			// request on this port would never be answered, so every pending
			// and later one fails at once instead of waiting out the timeout
			onPort(port, 'close', () =>
				this.rpc.abort('Stomp: the transport port closed'),
			);
			return port;
		});
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
		return { ...rest, body: isPortBody(sent) ? receiveBody(sent) : sent };
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
		(data: WebSocketDataType) => void,
		(code: number, reason: string) => void,
	] {
		const [port, theirs] = privateChannel();

		// frames travel on their own port and can overtake the connect
		// response on the rpc port; hold them until onopen has run
		let opened = false;
		const pending: WebSocketMessage[] = [];
		const deliver = (data: WebSocketMessage) => {
			if (data.type === 'data') onmessage(data.data);
			else if (data.type === 'close') onclose(data.code, data.reason);
		};

		this.rpc
			.call(
				'connect',
				{ url: url.href, protocols, requestHeaders, port: theirs },
				[theirs],
			)
			.then((response) => {
				if (response.result === 'success') {
					onopen(response.protocol, response.extensions);
					opened = true;
					for (const data of pending.splice(0)) deliver(data);
				} else onerror(response.error);
			})
			.catch((error) => onerror(String(error)));

		onPort(port, 'message', (data) => {
			if (opened) deliver(data as WebSocketMessage);
			else pending.push(data as WebSocketMessage);
		});
		onPort(port, 'messageerror', () =>
			onerror('Message error in transport port'),
		);

		return [
			(data) =>
				postToPort(
					port,
					{ type: 'data', data } satisfies WebSocketMessage,
					transferablesOf(data),
				),
			(code, reason) =>
				postToPort(port, {
					type: 'close',
					code,
					reason,
				} satisfies WebSocketMessage),
		];
	}
}
