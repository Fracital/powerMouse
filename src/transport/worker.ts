// The transport worker (dist/transportWorker.js): a dedicated Worker the
// controller starts when it was given a TransportDescriptor. It imports the
// transport module, constructs it and serves it to every RemoteTransport
// whose port the controller sends over (the service worker's, each page's,
// the host's own). Off the host page's thread, a proxied frame that spins
// its main thread on a synchronous XHR no longer blocks the transport that
// has to answer it. The WebSocket handshake cookies stay the controller's:
// the worker asks for them over its control channel.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import {
	TRANSPORT_WORKER_RPC,
	TransportModule,
	WorkerBound,
	WorkerToController,
} from './messages';
import { RpcHelper } from './rpc';
import serveTransport from './serveTransport';

declare const self: DedicatedWorkerGlobalScope;

let transport: ProxyTransport | undefined;
/** settles once the first transport exists; serve() waits for it */
let first!: () => void;
const ready = new Promise<void>((resolve) => (first = resolve));

async function construct({
	module,
	options,
}: TransportModule): Promise<ProxyTransport> {
	const { default: Transport } = (await import(
		/* @vite-ignore */ new URL(module, location.href).href
	)) as { default: new (...args: unknown[]) => ProxyTransport };
	if (typeof Transport !== 'function')
		throw new TypeError(`${module} has no default export to construct`);
	return new Transport(...(options || []));
}

const rpc = new RpcHelper<WorkerBound, WorkerToController>(
	{
		init: async (descriptor) => {
			transport = await construct(descriptor);
			first();
		},
		setTransport: async (descriptor) => {
			transport = await construct(descriptor);
		},
		serve: async (port) => {
			await ready;
			serveTransport(
				port,
				() => transport!,
				async (url, headers) =>
					rpc.call('decorate', { url: url.href, headers }),
			);
		},
	},
	TRANSPORT_WORKER_RPC,
	(data, transfer) => self.postMessage(data, transfer),
);

self.addEventListener('message', (event) => rpc.receive(event.data));
