// Wisp packets that cross to another realm over a MessagePort, those of one
// task in one message, their buffers transferred: a shard's lane
// (wispSplit.ts), a carrier host's rider (carrierHost.ts, carrierClient.ts).
// A message costs about the same whatever it carries; the carrier host is a
// process of its own, and a message from it about 0.1 ms of its thread.
// Epoxy's packets to the relay come several in a task (2 a message at a
// gigabit); the relay's come one a task, 64 KiB each at that rate, and
// gather only once the host falls behind (`idle`).

/** what one message carries at most before it goes */
export const MESSAGE_MAX = 1024 * 1024;

type PostTask = (
	task: () => void,
	options: { priority: 'background' },
) => Promise<unknown>;

/** the Prioritized Task Scheduling API's scheduler, where the realm has it */
const scheduler = (globalThis as { scheduler?: { postTask?: PostTask } })
	.scheduler;

export interface BatchOptions {
	/**
	 * Post once the thread has nothing else to run (a background task)
	 * rather than at the next task: packets that each come in a task of
	 * their own (a carrier's reads) gather while more keep coming, and one
	 * that comes alone goes as soon as the thread is idle
	 */
	idle?: boolean;
	/** the most bytes a message carries (MESSAGE_MAX) */
	max?: number;
}

/** packets gathered until the task ends (or MESSAGE_MAX), then posted as one array */
export class PacketBatch {
	#post: (batch: ArrayBuffer[]) => void;
	#batch: ArrayBuffer[] = [];
	#bytes = 0;
	#scheduled = false;
	#idle: boolean;
	#max: number;

	/** `post`: sends a batch, its buffers transferred */
	constructor(
		post: (batch: ArrayBuffer[]) => void,
		{ idle = false, max = MESSAGE_MAX }: BatchOptions = {},
	) {
		this.#post = post;
		this.#idle = idle && typeof scheduler?.postTask === 'function';
		this.#max = max;
	}

	/** a packet (its buffer given away) */
	push(packet: ArrayBuffer) {
		this.#batch.push(packet);
		this.#bytes += packet.byteLength;
		if (this.#bytes >= this.#max) this.flush();
		else if (!this.#scheduled) {
			this.#scheduled = true;
			if (this.#idle)
				void scheduler!.postTask!(() => this.flush(), {
					priority: 'background',
				});
			else setTimeout(() => this.flush(), 0);
		}
	}

	/** what was gathered, posted now */
	flush() {
		this.#scheduled = false;
		if (!this.#batch.length) return;
		const batch = this.#batch;
		this.#batch = [];
		this.#bytes = 0;
		this.#post(batch);
	}

	/** what was gathered, dropped (the other end is gone) */
	clear() {
		this.#batch = [];
		this.#bytes = 0;
	}
}

/** a packet in a buffer of its own: `packet` itself when it owns its buffer, or a copy (a view of wasm memory) */
export function ownBuffer(packet: Uint8Array): ArrayBuffer {
	return packet.byteOffset === 0 &&
		packet.byteLength === packet.buffer.byteLength &&
		packet.buffer instanceof ArrayBuffer
		? packet.buffer
		: (packet.slice().buffer as ArrayBuffer);
}

const DATA = 0x02;
const CLOSE = 0x04;

/**
 * Packets handed to an epoxy's Wisp reader, a stream's CLOSE never in the
 * task its DATA came in. Epoxy's multiplexor drops what a stream holds
 * unread once its CLOSE is in (wisp-mux's read ends at the close), so the
 * end of a response a server sent just before it closed, or a body hyper
 * had not asked for yet, was lost: a batch (a lane's message, a carrier
 * host's) handed a download's last DATA and its CLOSE over at once, and an
 * HTTP/1 response with `Connection: close` ended short (IncompleteBody).
 * Such a CLOSE, and whatever came after it, waits a task, as a packet of
 * its own message did; `flush` hands over what waits (the connection ends).
 */
export function wispFeed(enqueue: (packet: ArrayBuffer) => void): {
	push(packet: ArrayBuffer): void;
	flush(): void;
} {
	/** the streams given DATA in this task */
	const fed = new Set<number>();
	let waiting: ArrayBuffer[] = [];
	let scheduled = false;
	const later = () => {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
			scheduled = false;
			fed.clear();
			const held = waiting;
			waiting = [];
			for (const packet of held) push(packet);
		}, 0);
	};
	const push = (packet: ArrayBuffer) => {
		if (waiting.length) {
			waiting.push(packet);
			return;
		}
		if (packet.byteLength >= 5) {
			const bytes = new Uint8Array(packet, 0, 5);
			const id =
				(bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>>
				0;
			if (id !== 0 && bytes[0] === CLOSE && fed.has(id)) {
				waiting.push(packet);
				later();
				return;
			}
			if (id !== 0 && bytes[0] === DATA) {
				fed.add(id);
				later();
			}
		}
		enqueue(packet);
	};
	const flush = () => {
		const held = waiting;
		waiting = [];
		for (const packet of held) enqueue(packet);
	};
	return { push, flush };
}
