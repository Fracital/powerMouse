// The transport worker (dist/transportWorker.js): a dedicated Worker the
// controller starts when it was given a TransportDescriptor. It imports the
// transport module, constructs it and serves it to every RemoteTransport
// whose port the controller sends over (the service worker's, each page's,
// the host's own). Off the host page's thread, a proxied frame that spins
// its main thread on a synchronous XHR no longer blocks the transport that
// has to answer it. The WebSocket handshake cookies stay the controller's:
// the worker asks for them over its control channel.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { constructTransport, resolveHttp3 } from './construct';
import { H3_WORKER_NAME, serveH3 } from './http3/h3Thread';
import { jarChanged, serveJar } from './jarServer';
import {
	KEEPALIVE_MS,
	TRANSPORT_WORKER_RPC,
	TransportModule,
	WorkerBound,
	WorkerToController,
} from './messages';
import { RpcHelper } from './rpc';
import serveTransport, { warmTransport } from './serveTransport';
import { transportLog, watchTransportNotes } from './transportLog';
import { watchCarrier } from './wispWebTransport';

declare const self: DedicatedWorkerGlobalScope;

function construct(descriptor: TransportModule): Promise<ProxyTransport> {
	return constructTransport(
		resolveHttp3(
			{
				...descriptor,
				module: new URL(descriptor.module, location.href).href,
			},
			location.href,
		),
		// stomp-h3 runs in a worker of its own, started from this script
		location.href,
	);
}

/** epoxy's DNS-over-HTTPS endpoint for ECH configs (`ech_dns`), when the descriptor names one */
function resolverOf(descriptor: TransportModule): string | undefined {
	const options = descriptor.options?.[0] as { ech_dns?: unknown } | undefined;
	return typeof options?.ech_dns === 'string' ? options.ech_dns : undefined;
}

// the transport worker starts itself again for stomp-h3 (http3/h3Thread.ts)
if (self.name === H3_WORKER_NAME) serveH3(self);
else transportWorker();

function transportWorker() {
	let transport: ProxyTransport | undefined;
	/** settles once the first transport exists; serve() waits for it */
	let first!: () => void;
	const ready = new Promise<void>((resolve) => (first = resolve));

	const rpc = new RpcHelper<WorkerBound, WorkerToController>(
		{
			debugTransport: async (on) => {
				transportLog.on = on;
			},
			init: async (descriptor) => {
				transport = await construct(descriptor);
				warmTransport(transport, resolverOf(descriptor));
				first();
			},
			setTransport: async (descriptor) => {
				transport = await construct(descriptor);
				warmTransport(transport, resolverOf(descriptor));
			},
			serve: async (port) => {
				await ready;
				serveTransport(
					port,
					() => transport!,
					async (url, headers) =>
						rpc.call('decorate', { url: url.href, headers }),
					async (url, origin) => rpc.call('admit', { url: url.href, origin }),
				);
			},
			serveDecorated: async ({ port, decorate }) => {
				await ready;
				// the handshake headers are asked of whoever sent the port (a
				// slot's controller)
				const asked = new RpcHelper<Record<never, never>, WorkerToController>(
					{},
					TRANSPORT_WORKER_RPC,
					(data, transfer) => decorate.postMessage(data, transfer),
				);
				decorate.addEventListener('message', (event) =>
					asked.receive(event.data),
				);
				decorate.start();
				serveTransport(
					port,
					() => transport!,
					async (url, headers) =>
						asked.call('decorate', { url: url.href, headers }),
					async (url, origin) => asked.call('admit', { url: url.href, origin }),
				);
			},
			serveJar: async (port) => serveJar(port),
			jarChanged: async (domain) => jarChanged(domain),
		},
		TRANSPORT_WORKER_RPC,
		(data, transfer) => self.postMessage(data, transfer),
	);

	self.addEventListener('message', (event) => rpc.receive(event.data));

	// the controller shows what the wisp connection rides
	watchCarrier((info) => rpc.call('carrier', info).catch(() => {}));
	// and prints what the transport tells its console (this worker's is not the host's)
	watchTransportNotes((note) =>
		rpc.call('transportNote', note).catch(() => {}),
	);

	// the controller's clock for keeping the service worker running: a timer
	// here is not held back when the tab is hidden, the page's own is
	setInterval(() => {
		rpc.call('tick', undefined).catch(() => {});
	}, KEEPALIVE_MS);
}
