import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
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
 * Serve a ProxyTransport to a `RemoteTransport` on the other end of `port`.
 * `getTransport` is a getter so the host can hot-swap transports.
 * Returns a function that closes the port.
 */
export default function serveTransport(
	port: MessagePort,
	getTransport: () => ProxyTransport,
): () => void {
	const post = (data: unknown, transfer: Transferable[] = []) =>
		postToPort(port, data, transfer);

	const readyTransport = async () => {
		const transport = getTransport();
		if (!transport.ready) await transport.init();
		return transport;
	};

	const rpc = new RpcHelper<TransportToHost, HostToTransport>(
		{
			request: async ({ remote, method, body, headers }) => {
				const transport = await readyTransport();
				const response = await transport.request(
					new URL(remote),
					method,
					body,
					headers,
					undefined,
				);
				return [response, transferablesOf(response.body)];
			},
			connect: async ({ url, protocols, requestHeaders, port: socket }) => {
				const transport = await readyTransport();

				let resolve!: (result: TransportToHost['connect'][1]) => void;
				const result = new Promise<TransportToHost['connect'][1]>(
					(res) => (resolve = res),
				);

				const [send, close] = transport.connect(
					new URL(url),
					protocols,
					requestHeaders,
					(protocol, extensions) =>
						resolve({ result: 'success', protocol, extensions }),
					(data) =>
						postToPort(
							socket,
							{ type: 'data', data } satisfies WebSocketMessage,
							transferablesOf(data),
						),
					(code, reason) =>
						postToPort(socket, {
							type: 'close',
							code,
							reason,
						} satisfies WebSocketMessage),
					(error) => resolve({ result: 'failure', error }),
				);

				socket.onmessage = ({ data }: MessageEvent<WebSocketMessage>) => {
					if (data.type === 'data') send(data.data);
					else if (data.type === 'close') close(data.code, data.reason);
				};
				socket.onmessageerror = (event) =>
					console.error('Transport socket port messageerror', event);
				socket.start();

				return [await result, []];
			},
		},
		TRANSPORT_RPC,
		post,
	);

	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.addEventListener('messageerror', (event) =>
		console.error('Transport port messageerror', event),
	);
	port.start();

	rpc.call('ready', undefined);

	return () => port.close();
}
