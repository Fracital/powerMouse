import {
	TRANSPORT_WORKER_RPC,
	TransportModule,
	WorkerBound,
	WorkerToController,
} from './messages';
import { RpcHelper } from './rpc';
import type { DecorateHandshake } from './serveTransport';
import type { TransportNote } from './transportLog';
import type { AdmitSession } from './webTransportHost';
import type { CarrierInfo } from './wispWebTransport';

/** how long the worker gets to start and import the transport module before the controller gives up on it */
const BOOT_TIMEOUT_MS = 30000;

/**
 * The controller's handle on its transport worker (dist/transportWorker.js,
 * src/transport/worker.ts): a dedicated Worker that imports and constructs
 * the transport and serves it on every port handed over. `decorate` answers
 * the worker's handshake-header requests (the cookie jar stays with the
 * controller); `tick` is called every KEEPALIVE_MS, on the worker's clock,
 * whether or not the worker hosts a transport (a controller that hosts its
 * own starts one for the clock alone).
 */
export default class TransportWorker {
	#worker: Worker;
	#rpc: RpcHelper<WorkerToController, WorkerBound>;
	/** rejects when the worker script could not start (a 404, a parse error) */
	#failed: Promise<never>;
	constructor(
		url: URL,
		decorate: DecorateHandshake,
		tick: () => void,
		admit?: AdmitSession,
		carrier?: (info: CarrierInfo) => void,
		note?: (note: TransportNote) => void,
		/** the worker at `url`, already started (the controller's register()) */
		started?: Worker,
	) {
		// a classic worker (see build.js: emscripten's environment detection)
		this.#worker = started ?? new Worker(url);
		this.#rpc = new RpcHelper<WorkerToController, WorkerBound>(
			{
				decorate: async ({ url, headers }) => [
					await decorate(new URL(url), headers),
					[],
				],
				tick: async () => tick(),
				admit: async ({ url, origin }) => [
					admit ? await admit(new URL(url), origin) : true,
					[],
				],
				carrier: async (info) => carrier?.(info),
				transportNote: async (line) => note?.(line),
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
	/** `failed()` once, when the worker script could not start */
	onFailure(failed: () => void) {
		this.#failed.catch(failed);
	}
	/** the verbose mode (transportLog.ts) on or off in the worker; before init() to have it from the start */
	debugTransport(on: boolean) {
		this.#rpc.call('debugTransport', on).catch(() => {});
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
	/**
	 * hand the worker a port to serve, whose WebSocket handshake headers are
	 * asked over `decorate` instead (the site pool: a slot's controller
	 * answers there)
	 */
	serveDecorated(port: MessagePort, decorate: MessagePort) {
		this.#rpc
			.call('serveDecorated', { port, decorate }, [port, decorate])
			.catch((error) => {
				console.error(
					'Stomp: the transport worker could not serve a port',
					error,
				);
			});
	}
	/** the site pool: hand the worker a slot's worker's cookie jar port (jarServer.ts) */
	serveJar(port: MessagePort) {
		this.#rpc.call('serveJar', port, [port]).catch((error) => {
			console.error('Stomp: the transport worker could not serve a jar', error);
		});
	}
	/** the site pool: the host changed the jar for `domain`; the slots' workers hear */
	jarChanged(domain: string) {
		this.#rpc.call('jarChanged', domain).catch(() => {});
	}
	/** the page is back from the back/forward cache: the worker's wisp WebSocket is gone */
	connectionLost() {
		this.#rpc.call('connectionLost', undefined).catch(() => {});
	}
	/**
	 * the controller's page is going for good: every port the worker serves
	 * says so to its RemoteTransport (a document of another tab, the
	 * service worker), whose calls then fail at once and whose sockets end.
	 * The worker goes with the page a moment later
	 */
	goodbye() {
		this.#rpc.call('goodbye', undefined).catch(() => {});
	}
	/** the carrier host's port (carrierClient.ts); before init() for the first transport to ride it */
	carrierHost(port: MessagePort) {
		this.#rpc.call('carrierHost', port, [port]).catch(() => {});
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
