// stomp-h3 on a thread of its own. Over HTTP/3 a response is a QUIC packet
// per 1.2 KB, and each packet costs the thread that runs stomp-h3 its
// decryption, quinn's bookkeeping, the decoder and the hops between the
// wasm module and JS (about 130 us a packet), where HTTP/2 costs that per
// 16 KB record: in the transport worker, beside every other request of a
// page, a 3.5 MB response over HTTP/3 took four times as long as over
// HTTP/2. The transport worker (src/transport/worker.ts) starts itself again
// as this worker (named H3_WORKER_NAME), which loads stomp-h3 and runs its
// connections; the transport worker keeps the wisp UDP streams, hands each
// datagram on as it arrives and sends what comes back, so the two threads
// split the work. A response body comes back on a port of its own
// (bodyPort.ts).
import type { RawHeaders } from '@mercuryworkshop/proxy-transports';
import { isPortBody, receiveBody, sendBody, type PortBody } from '../bodyPort';
import { RpcHelper } from '../rpc';
import type { H3Connection, H3Module, H3Response } from './Http3Transport';

/** the name the transport worker starts its HTTP/3 worker with */
export const H3_WORKER_NAME = 'stomp-h3';
const H3_RPC = '$stomp$h3';
/** on a connection's datagram port: the read side ended (to the worker), the worker closed its write side (from it) */
const END = 'end';
/** on a connection's datagram port, from the worker: stomp-h3 sent a PING, in the datagram after this */
const PING = 'ping';
/**
 * How long after the last datagram heard one that goes out is taken for a
 * possible PING (stomp-h3's keep-alive goes 15 s after it) rather than the
 * ACK of what was heard (within max_ack_delay, 25 ms): only then is
 * stomp-h3's PING count read
 */
export const PING_GAP_MS = 1000;
/** how often the worker looks for connections that ended on their own (idle timeout, a lost path) and sends their stats */
const WATCH_MS = 250;

type ConnectOptions = { pem?: string; timeoutMs?: number };

type ToWorker = {
	load: [string];
	connect: [
		{ host: string; options: ConnectOptions; port: MessagePort },
		{ conn: number; handshake: number; stats: Record<string, number> },
	];
	request: [
		{
			conn: number;
			method: string;
			url: string;
			headers: RawHeaders;
			body: Uint8Array | PortBody | null;
		},
		{ status: number; headers: RawHeaders; body: PortBody | null },
	];
	close: [number];
};
type FromWorker = {
	state: [{ conn: number; alive: boolean; stats: Record<string, number> }];
};

/** a buffer to transfer that holds `chunk` and nothing else */
function ownBuffer(chunk: Uint8Array): ArrayBuffer {
	return chunk.byteOffset === 0 &&
		chunk.byteLength === chunk.buffer.byteLength &&
		chunk.buffer instanceof ArrayBuffer
		? chunk.buffer
		: (chunk.slice().buffer as ArrayBuffer);
}

/** In the HTTP/3 worker: serve stomp-h3 to the transport worker that started it */
export function serveH3(scope: DedicatedWorkerGlobalScope): void {
	let module: H3Module | null = null;
	const connections = new Map<number, { conn: H3Connection; alive: boolean }>();
	let next = 0;
	let watching: ReturnType<typeof setInterval> | null = null;
	/** tell the transport worker how a connection is: when it ended, and (`always`) its stats */
	const report = (id: number, always = false) => {
		const entry = connections.get(id);
		if (!entry) return;
		const alive = entry.conn.alive;
		if (alive === entry.alive && !always) return;
		entry.alive = alive;
		void rpc
			.call('state', {
				conn: id,
				alive,
				stats: alive ? entry.conn.stats() : {},
			})
			.catch(() => {});
		if (!alive) connections.delete(id);
		if (!connections.size && watching !== null) {
			clearInterval(watching);
			watching = null;
		}
	};
	const rpc = new RpcHelper<ToWorker, FromWorker>(
		{
			load: async (url) => {
				if (module) return;
				const loaded = (await import(/* @vite-ignore */ url)) as H3Module;
				await loaded.default();
				module = loaded;
			},
			connect: async ({ host, options, port }) => {
				if (!module) throw new Error('stomp-h3 is not loaded');
				// datagrams in: pushed as they come, the reader is stomp-h3's
				// own loop, which reads as fast as they arrive
				let push!: ReadableStreamDefaultController<Uint8Array>;
				let ended = false;
				let lastRead = performance.now();
				const readable = new ReadableStream<Uint8Array>({
					start: (controller) => {
						push = controller;
					},
				});
				port.onmessage = ({ data }: MessageEvent<ArrayBuffer | string>) => {
					if (ended) return;
					if (data instanceof ArrayBuffer) {
						lastRead = performance.now();
						push.enqueue(new Uint8Array(data));
					} else if (data === END) {
						ended = true;
						push.close();
					}
				};
				// datagrams out: one message each, the buffer moved. One that
				// goes out a while after the last came in may carry a PING,
				// which the transport worker times (Http3Transport's blackhole
				// watch): stomp-h3's count is read once its write is over (the
				// connection is in use inside it), and the PING marker goes
				// ahead of the datagram. The end goes after what was held.
				let conn: H3Connection | null = null;
				let pings = 0;
				const post = (buffer: ArrayBuffer) =>
					port.postMessage(buffer, [buffer]);
				const closeWrite = () => {
					queueMicrotask(() => port.postMessage(END));
				};
				const writable = new WritableStream<Uint8Array>({
					write: (chunk) => {
						const buffer = ownBuffer(chunk);
						if (!conn || performance.now() - lastRead < PING_GAP_MS)
							return post(buffer);
						const live = conn;
						queueMicrotask(() => {
							try {
								const count = Number(live.pings);
								if (count > pings) {
									pings = count;
									port.postMessage(PING);
								}
							} catch {
								// no count
							}
							post(buffer);
						});
					},
					close: closeWrite,
					abort: closeWrite,
				});
				conn = await module.connect(host, readable, writable, options);
				pings = Number(conn.pings) || 0;
				const id = next++;
				connections.set(id, { conn, alive: true });
				watching ??= setInterval(() => {
					for (const id of [...connections.keys()]) report(id, true);
				}, WATCH_MS);
				return [
					{ conn: id, handshake: conn.handshake_ms, stats: conn.stats() },
					[],
				];
			},
			request: async ({ conn: id, method, url, headers, body }) => {
				const entry = connections.get(id);
				if (!entry) throw new Error('h3 send: the connection is gone');
				let response: H3Response;
				try {
					response = await entry.conn.request(
						method,
						url,
						headers,
						isPortBody(body) ? receiveBody(body) : body,
					);
				} catch (error) {
					// the state goes first: the transport reads `alive` as it
					// handles the failure
					report(id);
					throw error;
				}
				const out = response.body ? sendBody(response.body, true) : null;
				return [
					{ status: response.status, headers: response.headers, body: out },
					out ? [out.$stompBodyPort] : [],
				];
			},
			close: async (id) => {
				connections.get(id)?.conn.close();
				report(id);
			},
		},
		H3_RPC,
		(data, transfer) => scope.postMessage(data, transfer),
	);
	scope.addEventListener('message', (event) => rpc.receive(event.data));
}

/** In the transport worker: a stomp-h3 connection run by the HTTP/3 worker */
class RemoteConnection implements H3Connection {
	alive = true;
	handshake_ms: number;
	#stats: Record<string, number> = {};
	#id: number;
	#rpc: RpcHelper<FromWorker, ToWorker>;
	#pings: () => number;
	constructor(
		id: number,
		handshake: number,
		stats: Record<string, number>,
		rpc: RpcHelper<FromWorker, ToWorker>,
		pings: () => number,
	) {
		this.#id = id;
		this.handshake_ms = handshake;
		this.#stats = stats;
		this.#rpc = rpc;
		this.#pings = pings;
	}
	/** the PINGs the worker said went out (each one's marker precedes its datagram), counted from the handshake */
	get pings(): number {
		return this.#pings();
	}
	/** what the worker last said (every WATCH_MS) */
	stats(): Record<string, number> {
		return this.#stats;
	}
	update(alive: boolean, stats: Record<string, number>) {
		this.alive &&= alive;
		this.#stats = stats;
	}
	close(): void {
		this.alive = false;
		void this.#rpc.call('close', this.#id).catch(() => {});
	}
	async request(
		method: string,
		url: string,
		headers: RawHeaders,
		body: Uint8Array | ReadableStream<Uint8Array> | null,
	): Promise<H3Response> {
		// a byte body is copied, not moved: the caller keeps it to send
		// again over the base transport if HTTP/3 fails
		const sent = body instanceof ReadableStream ? sendBody(body, false) : body;
		const response = await this.#rpc.call(
			'request',
			{ conn: this.#id, method, url, headers, body: sent },
			sent && isPortBody(sent) ? [sent.$stompBodyPort] : [],
		);
		return {
			status: response.status,
			headers: response.headers,
			body: response.body ? receiveBody(response.body) : null,
		};
	}
}

/** one HTTP/3 worker per module and script, whichever Http3Transport asks (setTransport() makes a new one) */
const started = new Map<string, Promise<H3Module>>();

/**
 * stomp-h3 (at `moduleUrl`) loaded in an HTTP/3 worker started from
 * `workerUrl` (the transport worker's own script), as an H3Module whose
 * connections run there. Rejects when the worker cannot start or the module
 * cannot load in it.
 */
export function remoteH3Module(
	moduleUrl: string,
	workerUrl: string,
): Promise<H3Module> {
	const key = `${workerUrl} ${moduleUrl}`;
	let module = started.get(key);
	if (!module) {
		module = startWorker(moduleUrl, workerUrl);
		module.catch(() => started.delete(key));
		started.set(key, module);
	}
	return module;
}

async function startWorker(
	moduleUrl: string,
	workerUrl: string,
): Promise<H3Module> {
	const worker = new Worker(workerUrl, { name: H3_WORKER_NAME });
	const connections = new Map<number, RemoteConnection>();
	const rpc = new RpcHelper<FromWorker, ToWorker>(
		{
			state: async ({ conn, alive, stats }) => {
				connections.get(conn)?.update(alive, stats);
				if (!alive) connections.delete(conn);
			},
		},
		H3_RPC,
		(data, transfer) => worker.postMessage(data, transfer),
	);
	worker.addEventListener('message', (event) => rpc.receive(event.data));
	let loaded = false;
	const failed = new Promise<never>((_, reject) =>
		worker.addEventListener('error', (event) => {
			// logged here, not passed on: the controller would read it as the
			// transport worker failing
			event.preventDefault();
			if (loaded) {
				console.warn('Stomp: the HTTP/3 worker threw:', event.message);
				return;
			}
			const reason = `the HTTP/3 worker failed: ${event.message || 'error'}`;
			rpc.abort(reason);
			reject(new Error(reason));
		}),
	);
	failed.catch(() => {});
	try {
		await Promise.race([rpc.call('load', moduleUrl), failed]);
		loaded = true;
	} catch (error) {
		worker.terminate();
		throw error;
	}
	return {
		default: async () => {},
		connect: async (host, readable, writable, options) => {
			const { port1, port2 } = new MessageChannel();
			const writer = writable.getWriter();
			// counted before the datagram that carries it is written
			let pings = 0;
			port1.onmessage = ({ data }: MessageEvent<ArrayBuffer | string>) => {
				if (data instanceof ArrayBuffer)
					writer.write(new Uint8Array(data)).catch(() => {});
				else if (data === PING) pings++;
				else if (data === END) writer.close().catch(() => {});
			};
			// each datagram goes on as it is read, its buffer moved
			const reader = readable.getReader();
			void (async () => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						const buffer = ownBuffer(value);
						port1.postMessage(buffer, [buffer]);
					}
				} catch {
					// the channel failed: it ended
				}
				port1.postMessage(END);
			})();
			// when the connection fails, the worker closes its side of the
			// channel (END above), as stomp-h3 closes its writer in this realm
			const opened = await rpc.call('connect', { host, options, port: port2 }, [
				port2,
			]);
			const conn = new RemoteConnection(
				opened.conn,
				opened.handshake,
				opened.stats,
				rpc,
				() => pings,
			);
			connections.set(opened.conn, conn);
			return conn;
		},
	};
}
