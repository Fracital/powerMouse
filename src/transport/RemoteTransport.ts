import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import {
	HostToTransport,
	postToPort,
	transferablesOf,
	TRANSPORT_RPC,
	TransportToHost,
	WebSocketMessage,
} from './messages';
import { RpcHelper } from './rpc';

/**
 * A ProxyTransport whose implementation lives on the other end of a MessagePort.
 * The other end is served by `serveTransport()`.
 */
export default class RemoteTransport implements ProxyTransport {
	ready = false;
	private readyPromise: Promise<void>;
	private readyResolve!: () => void;
	private rpc: RpcHelper<HostToTransport, TransportToHost>;
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
			port.addEventListener('message', (event) => this.rpc.receive(event.data));
			port.addEventListener('messageerror', (event) =>
				console.error('RemoteTransport port messageerror', event),
			);
			port.start();
			return port;
		});
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
		return this.rpc.call(
			'request',
			{ remote: remote.href, method, body, headers },
			transferablesOf(body),
		);
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
		const channel = new MessageChannel();
		const port = channel.port1;

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
				{ url: url.href, protocols, requestHeaders, port: channel.port2 },
				[channel.port2],
			)
			.then((response) => {
				if (response.result === 'success') {
					onopen(response.protocol, response.extensions);
					opened = true;
					for (const data of pending.splice(0)) deliver(data);
				} else onerror(response.error);
			})
			.catch((error) => onerror(String(error)));

		port.onmessage = ({ data }: MessageEvent<WebSocketMessage>) => {
			if (opened) deliver(data);
			else pending.push(data);
		};
		port.onmessageerror = () => onerror('Message error in transport port');
		port.start();

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
