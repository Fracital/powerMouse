// What the transport worker and its shards say to each other
// (ShardedTransport.ts is the transport worker's side, shardWorker.ts a
// shard's), and the raw streams (epoxy's connect_udp, connect_tcp and
// connect_tls) carried between them on a port of their own.
import type {
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import type { PortBody } from './bodyPort';
import type { TransportToHost } from './messages';

/** the name a shard's worker is started with, then its number */
export const SHARD_WORKER_NAME = 'stomp-shard';
export const SHARD_RPC = '$stomp$shard';

/** what a shard says of the transport it made */
export interface ShardFacts {
	/** the transport's fieldSupport (serveTransport's fitHeaders) */
	fieldSupport?: unknown;
	/** whether its client opens raw streams of each kind */
	raw: RawKind[];
}

export type RawKind = 'udp' | 'tcp' | 'tls';

/** implemented by a shard (shardWorker.ts), called by the transport worker */
export type ShardBound = {
	/**
	 * import `module` and construct its transport with `options`, the first
	 * given a `wisp` that asks for a lane (ShardToHost.lane), and init it
	 */
	make: [{ instance: number; module: string; options: unknown[] }, ShardFacts];
	/** the transport `instance` is let go */
	drop: [number];
	/** open its wisp connection now (epoxy's replace_stream_provider), unless it has one */
	warm: [number];
	/**
	 * end the wisp connections of the transport `instance` here: its carrier
	 * ended where the shard cannot hear it (the carrier host's realm went
	 * away), or the shard closes, and a carrier host's rider is let go
	 */
	cut: [number];
	request: [
		{
			instance: number;
			remote: string;
			method: string;
			body: unknown;
			headers: RawHeaders;
		},
		Omit<TransferrableResponse, 'body'> & { body: unknown },
	];
	connect: [
		{
			instance: number;
			url: string;
			protocols: string[];
			requestHeaders: RawHeaders;
			port: MessagePort;
		},
		TransportToHost['connect'][1],
	];
	raw: [
		{ instance: number; kind: RawKind; url: string; port: MessagePort },
		{ send: boolean; closeReason: boolean },
	];
};

/** implemented by the transport worker, called by a shard */
export type ShardToHost = {
	/** a port that is one more Wisp connection of the transport `instance` (wispSplit.ts lanePipe) */
	lane: [{ instance: number; v2: boolean }, MessagePort];
	/** whether the shard's thread is saturated now (Saturation) */
	load: [boolean];
};

/** a shard's WebSocket, on its port: what WebSocketMessage carries, and an error after it opened */
export type ShardSocketMessage =
	| { type: 'data'; data: WebSocketDataType }
	| { type: 'close'; code: number; reason: string }
	| { type: 'error'; error: string };

/** a raw stream's port, from the shard */
type RawFromShard =
	| { type: 'data'; chunks: ArrayBuffer[] }
	| { type: 'end'; closeReason?: number }
	| { type: 'error'; error: string }
	| { type: 'sent'; id: number; error?: string };
/** and to it */
type RawToShard =
	| { type: 'data'; chunks: ArrayBuffer[] }
	| { type: 'send'; id: number; datagram: ArrayBuffer }
	| { type: 'close' }
	| { type: 'cancel'; reason: string };

/** what epoxy's connect_* answer */
export interface RawStream {
	read: ReadableStream<Uint8Array>;
	write: WritableStream<Uint8Array>;
	send?: (datagram: Uint8Array) => Promise<void>;
	closeReason?: () => number | undefined;
}

/** how often a busy thread's timer lag is sampled (ms) */
const PROBE_MS = 100;
/** a thread whose timers fire this late on average is saturated (ms) */
export const SATURATED_LAG_MS = 6;
/** and one whose timers come back under this is not (ms) */
const EASED_LAG_MS = 2;
/** a thread that had no Wisp packets for this long stops being sampled (ms) */
const QUIET_MS = 1000;

/**
 * Whether this thread is saturated: while Wisp packets come to its epoxy,
 * a timer every PROBE_MS measures how late a task posted now runs. A
 * thread that keeps up runs it within a millisecond or two; one that does
 * not has packets queued ahead of it, and the lag is how long they wait.
 * `changed` hears each change; nothing is sampled while no packets come.
 */
export class Saturation {
	#changed: (saturated: boolean) => void;
	#lag = 0;
	#saturated = false;
	#running = false;
	#last = 0;

	constructor(changed: (saturated: boolean) => void) {
		this.#changed = changed;
	}

	get saturated(): boolean {
		return this.#saturated;
	}

	/** the average lag lately (ms) */
	get lag(): number {
		return this.#lag;
	}

	/** Wisp packets came (cheap: called for each batch) */
	busy() {
		this.#last = performance.now();
		if (this.#running) return;
		this.#running = true;
		setTimeout(this.#probe, PROBE_MS);
	}

	/** a task posted on a port: not a timer, which nesting would hold back 4 ms */
	#channel: MessageChannel | null = null;
	#posted = 0;

	#probe = () => {
		if (!this.#channel) {
			this.#channel = new MessageChannel();
			this.#channel.port1.onmessage = this.#measure;
		}
		this.#posted = performance.now();
		this.#channel.port2.postMessage(null);
	};

	#measure = () => {
		const now = performance.now();
		this.#lag = this.#lag * 0.6 + (now - this.#posted) * 0.4;
		const quiet = now - this.#last > QUIET_MS;
		if (quiet) this.#lag = 0;
		const saturated = this.#saturated
			? this.#lag > EASED_LAG_MS
			: this.#lag > SATURATED_LAG_MS;
		if (saturated !== this.#saturated) {
			this.#saturated = saturated;
			this.#changed(saturated);
		}
		if (quiet) this.#running = false;
		else setTimeout(this.#probe, PROBE_MS);
	};
}

/** the text of an error as RevivingTransport and the hosts read it */
export const errorText = (error: unknown) =>
	String((error as Error)?.message ?? error);

/** a buffer of its own for `chunk`, to transfer */
const own = (chunk: Uint8Array): ArrayBuffer =>
	chunk.byteOffset === 0 &&
	chunk.byteLength === chunk.buffer.byteLength &&
	chunk.buffer instanceof ArrayBuffer
		? chunk.buffer
		: (chunk.slice().buffer as ArrayBuffer);

/** chunks posted to `port` as one message per task */
function batcher(
	post: (chunks: ArrayBuffer[]) => void,
): [add: (chunk: ArrayBuffer) => void, flush: () => void] {
	let batch: ArrayBuffer[] = [];
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		if (!batch.length) return;
		const chunks = batch;
		batch = [];
		post(chunks);
	};
	return [
		(chunk) => {
			batch.push(chunk);
			if (!scheduled) {
				scheduled = true;
				setTimeout(flush, 0);
			}
		},
		flush,
	];
}

/** a shard's raw stream, served on `port` until either side ends it */
export function serveRaw(port: MessagePort, raw: RawStream) {
	const writer = raw.write.getWriter();
	const reader = raw.read.getReader();
	let closed = false;
	const post = (message: RawFromShard, transfer: Transferable[] = []) => {
		if (!closed) port.postMessage(message, transfer);
	};
	const [add, flush] = batcher((chunks) =>
		post({ type: 'data', chunks }, chunks),
	);
	port.onmessage = ({ data }: MessageEvent<RawToShard>) => {
		if (data.type === 'data')
			for (const chunk of data.chunks)
				writer.write(new Uint8Array(chunk)).catch(() => {});
		else if (data.type === 'send')
			raw.send!(new Uint8Array(data.datagram)).then(
				() => post({ type: 'sent', id: data.id }),
				(error) => post({ type: 'sent', id: data.id, error: errorText(error) }),
			);
		else if (data.type === 'close') writer.close().catch(() => {});
		else if (data.type === 'cancel') reader.cancel(data.reason).catch(() => {});
	};
	port.start();
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				add(own(value));
			}
			flush();
			post({ type: 'end', closeReason: raw.closeReason?.() });
		} catch (error) {
			flush();
			post({ type: 'error', error: errorText(error) });
		}
		closed = true;
		port.close();
	})();
}

/** the transport worker's end of a shard's raw stream, as epoxy's own */
export function rawOverPort(
	port: MessagePort,
	facts: { send: boolean; closeReason: boolean },
	/** runs once, when the stream has ended */
	settled?: () => void,
): RawStream {
	let reason: number | undefined;
	let ended = false;
	let sends = 0;
	const sending = new Map<
		number,
		{ resolve: () => void; reject: (error: Error) => void }
	>();
	const post = (message: RawToShard, transfer: Transferable[] = []) => {
		if (!ended) port.postMessage(message, transfer);
	};
	const [add, flush] = batcher((chunks) =>
		post({ type: 'data', chunks }, chunks),
	);
	let reading!: ReadableStreamDefaultController<Uint8Array>;
	const finish = () => {
		if (!ended) settled?.();
		ended = true;
		port.close();
		for (const { reject } of sending.values())
			reject(new Error('the stream ended'));
		sending.clear();
	};
	const read = new ReadableStream<Uint8Array>({
		start(controller) {
			reading = controller;
		},
		cancel(why) {
			post({ type: 'cancel', reason: String(why) });
		},
	});
	port.onmessage = ({ data }: MessageEvent<RawFromShard>) => {
		if (data.type === 'data')
			for (const chunk of data.chunks) reading.enqueue(new Uint8Array(chunk));
		else if (data.type === 'sent') {
			const waiting = sending.get(data.id);
			sending.delete(data.id);
			if (data.error === undefined) waiting?.resolve();
			else waiting?.reject(new Error(data.error));
		} else if (data.type === 'end') {
			reason = data.closeReason;
			finish();
			try {
				reading.close();
			} catch {
				// cancelled
			}
		} else if (data.type === 'error') {
			finish();
			try {
				reading.error(new Error(data.error));
			} catch {
				// cancelled
			}
		}
	};
	port.start();
	// what the caller writes stays the caller's: it is copied
	const copy = (chunk: Uint8Array) => chunk.slice().buffer as ArrayBuffer;
	const write = new WritableStream<Uint8Array>({
		write(chunk) {
			add(copy(chunk));
		},
		close() {
			flush();
			post({ type: 'close' });
		},
		abort() {
			flush();
			post({ type: 'close' });
		},
	});
	return {
		read,
		write,
		...(facts.send && {
			send: (datagram: Uint8Array) =>
				new Promise<void>((resolve, reject) => {
					if (ended) return reject(new Error('the stream ended'));
					const id = sends++;
					sending.set(id, { resolve, reject });
					// in order with the stream's writes
					flush();
					const buffer = copy(datagram);
					post({ type: 'send', id, datagram: buffer }, [buffer]);
				}),
		}),
		...(facts.closeReason && { closeReason: () => reason }),
	};
}

/** a request's response as it crosses (its body, a stream, on a port: bodyPort.ts) */
export type ShardResponse = Omit<TransferrableResponse, 'body'> & {
	body: PortBody | unknown;
};
