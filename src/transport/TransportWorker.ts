import {
	TRANSPORT_WORKER_RPC,
	TransportModule,
	WorkerBound,
	WorkerToController,
} from './messages';
import { RpcHelper } from './rpc';
import type { DecorateHandshake } from './serveTransport';

/** how long the worker gets to start and import the transport module before the controller gives up on it */
const BOOT_TIMEOUT_MS = 30000;

/**
 * The controller's handle on its transport worker (dist/transportWorker.js,
 * src/transport/worker.ts): a dedicated Worker that imports and constructs
 * the transport and serves it on every port handed over. `decorate` answers
 * the worker's handshake-header requests (the cookie jar stays with the
 * controller).
 */
export default class TransportWorker {
	#worker: Worker;
	#rpc: RpcHelper<WorkerToController, WorkerBound>;
	/** rejects when the worker script could not start (a 404, a parse error) */
	#failed: Promise<never>;
	constructor(url: URL, decorate: DecorateHandshake) {
		// a classic worker (see build.js: emscripten's environment detection)
		this.#worker = new Worker(url);
		this.#rpc = new RpcHelper<WorkerToController, WorkerBound>(
			{
				decorate: async ({ url, headers }) => [
					await decorate(new URL(url), headers),
					[],
				],
			},
			TRANSPORT_WORKER_RPC,
			(data, transfer) => this.#worker.postMessage(data, transfer),
		);
		this.#worker.addEventListener('message', (event) =>
			this.#rpc.receive(event.data),
		);
		this.#failed = new Promise((_, reject) =>
			this.#worker.addEventListener('error', (event) =>
				reject(
					new Error(
						(event as ErrorEvent).message ||
							`the transport worker at ${url.href} could not start`,
					),
				),
			),
		);
		// nothing awaits a failure after boot; it is reported through init()
		this.#failed.catch(() => {});
	}
	/**
	 * Import the module and construct the transport in the worker. Rejects
	 * when the worker cannot start, the module cannot be imported there, the
	 * constructor throws, or nothing answers within BOOT_TIMEOUT_MS.
	 */
	init(descriptor: TransportModule): Promise<void> {
		return Promise.race([
			this.#rpc.call('init', descriptor),
			this.#failed,
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`the transport worker did not start within ${BOOT_TIMEOUT_MS} ms`,
							),
						),
					BOOT_TIMEOUT_MS,
				),
			),
		]);
	}
	/** replace the transport; in-flight requests finish on the old one */
	setTransport(descriptor: TransportModule): Promise<void> {
		return this.#rpc.call('setTransport', descriptor);
	}
	/** hand the worker a port to serve the transport on (the other end holds a RemoteTransport) */
	servePort(port: MessagePort) {
		this.#rpc.call('serve', port, [port]).catch((error) => {
			console.error(
				'Stomp: the transport worker could not serve a port',
				error,
			);
		});
	}
	/** a new port the worker serves, for a RemoteTransport on this side */
	serve(): MessagePort {
		const channel = new MessageChannel();
		this.servePort(channel.port2);
		return channel.port1;
	}
	terminate() {
		this.#rpc.abort('Transport worker terminated');
		this.#worker.terminate();
	}
}
