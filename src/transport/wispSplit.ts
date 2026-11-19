// One Wisp connection shared by several epoxy instances (the transport's
// shards, ShardedTransport.ts), each of which speaks Wisp to a connection of
// its own, as it would to the relay. The relay sees one client: one session
// or WebSocket, one handshake, one stream id space.
//
// Each epoxy's connection is a lane: a MessagePort to the shard's worker
// that carries the packets each way (each its own ArrayBuffer, transferred,
// those of one task in one message: packetBatch.ts), and 'end' when either
// side is done; or, for the epoxy of this realm (the transport worker's own
// shard), a pipe whose packets are handed over as they come. A shard's end
// of a lane (lanePipe) speaks to a carrier host's rider as well
// (carrierHost.ts), which ends with `{ end }` and may send a packet alone.
//
// - The handshake is the first lane's: the relay's packets up to and with
//   stream 0's CONTINUE (Wisp v2's INFO, any extension's packets, then the
//   connection's buffer size; v1's CONTINUE alone) go to it as they come,
//   and its packets on stream 0 up to its INFO go to the relay, whether that
//   CONTINUE came before its INFO (a relay that opened the Wisp stream sends
//   INFO and CONTINUE at once: wisp-lanes SPEC, section 2) or after. Once
//   both are in (the CONTINUE alone when the relay sent no INFO), every
//   later lane is given the same packets, byte for byte, as its relay's
//   greeting, and what it sends on stream 0 is dropped: its epoxy shakes
//   hands with the greeting the relay gave, and the relay hears one
//   handshake, the first lane's INFO before any lane's CONNECT.
// - A lane names its streams as its epoxy numbers them; each CONNECT takes
//   the next id of the connection, and every packet the lane sends for the
//   stream goes out under that id, every packet the relay sends under it
//   comes back under the lane's. A CLOSE either way ends the pairing, and a
//   packet for a stream no longer paired is dropped (the relay drops one too).
// - A packet of the relay's on stream 0 after the handshake is the whole
//   connection's (a CLOSE of stream 0 ends it): every lane hears it. A
//   lane's own CLOSE of stream 0 would end the others' too: it is dropped,
//   and a lane that ends closes its streams, one CLOSE each.
// - When the relay's connection ends, every lane ends, as each epoxy's own
//   connection would.

import { ownBuffer, PacketBatch, wispFeed } from './packetBatch';
import { paceRider, type Ride } from './riderPace';

/** what epoxy's function transport gives back (EpoxyWispTransportResult) */
export interface WispPipe {
	read: ReadableStream<ArrayBuffer>;
	write: WritableStream<Uint8Array>;
	/** wispWebTransport.ts WispPipe.more */
	more?: () => Promise<Ride | null>;
}

/** what crosses a lane's port, each way (a rider's: a packet alone too, and the host's `{ end }`) */
export type LaneMessage =
	ArrayBuffer[] | ArrayBuffer | 'end' | { end: 'lost' | 'closed' };

const CONNECT = 0x01;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const INFO = 0x05;
/** a CLOSE's reason: the client closed the stream (Wisp's 0x02, voluntary) */
const VOLUNTARY = 0x02;

const streamOf = (packet: Uint8Array) =>
	packet[1] | (packet[2] << 8) | (packet[3] << 16) | (packet[4] * 2 ** 24);

function setStream(packet: Uint8Array, id: number) {
	packet[1] = id & 0xff;
	packet[2] = (id >>> 8) & 0xff;
	packet[3] = (id >>> 16) & 0xff;
	packet[4] = (id >>> 24) & 0xff;
}

/** how long it takes the bytes a meter counted to count half (ms) */
const HALF_LIFE_MS = 500;

/**
 * The bytes the relay sent a shard's lanes lately: each counts in full when
 * it came and half as much every HALF_LIFE_MS after
 */
export class Meter {
	#value = 0;
	#at = 0;
	#decayed(now: number) {
		return this.#value * 2 ** (-(now - this.#at) / HALF_LIFE_MS);
	}
	add(bytes: number) {
		const now = performance.now();
		this.#value = this.#decayed(now) + bytes;
		this.#at = now;
	}
	get value(): number {
		return this.#decayed(performance.now());
	}
}

/** where a lane's packets go: its epoxy */
interface Outlet {
	/** a packet to its epoxy (an ArrayBuffer of its own, given away) */
	send(packet: ArrayBuffer): void;
	/** its epoxy's connection ends (what was sent before still reaches it) */
	end(): void;
}

/** a lane over a port to a shard's worker: the packets of one task in one message */
class PortOutlet implements Outlet {
	readonly port: MessagePort;
	#batch: PacketBatch;
	#done = false;

	constructor(port: MessagePort) {
		this.port = port;
		this.#batch = new PacketBatch((batch) => {
			if (!this.#done) port.postMessage(batch satisfies LaneMessage, batch);
		});
	}

	send(packet: ArrayBuffer) {
		if (!this.#done) this.#batch.push(packet);
	}

	end() {
		if (this.#done) return;
		this.#batch.flush();
		this.#done = true;
		this.port.postMessage('end' satisfies LaneMessage);
		this.port.close();
	}
}

/** one epoxy's connection: where its packets go, and its streams by its own ids */
class Lane {
	readonly outlet: Outlet;
	/** its ids to the connection's */
	readonly streams = new Map<number, number>();
	#meter: Meter | null;
	#done = false;

	constructor(outlet: Outlet, meter: Meter | null) {
		this.outlet = outlet;
		this.#meter = meter;
	}

	send(packet: ArrayBuffer) {
		if (this.#done) return;
		this.#meter?.add(packet.byteLength);
		this.outlet.send(packet);
	}

	end() {
		if (this.#done) return;
		this.#done = true;
		this.outlet.end();
	}
}

export class WispSplit {
	#pipe: WispPipe;
	#writer: WritableStreamDefaultWriter<Uint8Array>;
	#lanes = new Set<Lane>();
	#primary: Lane | null = null;
	/** the relay's packets of the handshake, kept for the later lanes */
	#greeting: ArrayBuffer[] = [];
	/** the relay's CONTINUE for stream 0 is in */
	#heard = false;
	/** the relay sent an INFO (Wisp v2): the first lane answers with its own */
	#asked = false;
	/** the first lane's INFO went to the relay (or a CONNECT, with none before it) */
	#said = false;
	/** both sides of the handshake are done: later lanes are greeted */
	#greeted = false;
	/** lanes that came before the handshake was done */
	#waiting: Lane[] = [];
	/** the connection's ids to their lane and its id */
	#streams = new Map<number, { lane: Lane; id: number }>();
	#last = 0;
	#ended = false;

	constructor(pipe: WispPipe) {
		this.#pipe = pipe;
		this.#writer = pipe.write.getWriter();
	}

	/** whether the relay's connection has ended (a lane attached now ends at once) */
	get ended(): boolean {
		return this.#ended;
	}

	/** the lanes attached and not ended (for tests and the verbose log) */
	get lanes(): number {
		return this.#lanes.size;
	}

	/** `port` is one more epoxy's connection; `meter` counts what the relay sends it */
	attach(port: MessagePort, meter: Meter | null = null) {
		const lane = new Lane(new PortOutlet(port), meter);
		if (this.#ended) {
			lane.end();
			return;
		}
		port.onmessage = ({ data }: MessageEvent<LaneMessage>) => {
			if (data === 'end') this.#drop(lane);
			else if (Array.isArray(data))
				for (const packet of data) this.#fromLane(lane, new Uint8Array(packet));
		};
		// the shard's worker went away
		port.addEventListener('close', () => this.#drop(lane));
		port.start();
		this.#join(lane);
	}

	/**
	 * One more epoxy's connection, for an epoxy of this realm: its packets
	 * are handed over as they come, each way
	 */
	attachLocal(meter: Meter | null = null, arrived?: () => void): WispPipe {
		let reading!: ReadableStreamDefaultController<ArrayBuffer>;
		let closed = false;
		const feed = wispFeed((packet) => {
			try {
				reading.enqueue(packet);
			} catch {
				// cancelled already
			}
		});
		const close = () => {
			if (closed) return;
			closed = true;
			feed.flush();
			try {
				reading.close();
			} catch {
				// cancelled already
			}
		};
		const lane = new Lane(
			{
				send: (packet) => {
					if (closed) return;
					arrived?.();
					feed.push(packet);
				},
				end: close,
			},
			meter,
		);
		const read = new ReadableStream<ArrayBuffer>({
			start(controller) {
				reading = controller;
			},
			cancel: () => this.#drop(lane),
		});
		const write = new WritableStream<Uint8Array>({
			write: (packet) => {
				if (closed) throw new Error('the Wisp connection ended');
				// a view of a larger buffer (epoxy's memory) is copied: its
				// stream id is rewritten in place
				this.#fromLane(
					lane,
					packet.byteOffset === 0 &&
						packet.byteLength === packet.buffer.byteLength
						? packet
						: packet.slice(),
				);
			},
			close: () => this.#drop(lane),
			abort: () => this.#drop(lane),
		});
		if (this.#ended) lane.end();
		else this.#join(lane);
		return { read, write };
	}

	/** the lane whose port is `port` is let go: its streams are closed */
	detach(port: MessagePort) {
		for (const lane of this.#lanes)
			if (lane.outlet instanceof PortOutlet && lane.outlet.port === port)
				this.#drop(lane);
	}

	#join(lane: Lane) {
		this.#lanes.add(lane);
		if (!this.#primary) {
			this.#primary = lane;
			void this.#read();
		} else if (this.#greeted) this.#greet(lane);
		else this.#waiting.push(lane);
	}

	#greet(lane: Lane) {
		for (const packet of this.#greeting) lane.send(packet.slice(0));
	}

	async #read() {
		const reader = this.#pipe.read.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done || this.#ended) break;
				this.#fromRelay(value);
			}
		} catch {
			// the carrier failed
		}
		this.#end();
	}

	#fromRelay(buffer: ArrayBuffer) {
		const packet = new Uint8Array(buffer);
		if (packet.length < 5) return;
		const id = streamOf(packet);
		if (!this.#heard) {
			this.#greeting.push(buffer.slice(0));
			this.#primary!.send(buffer);
			if (packet[0] === INFO && id === 0) this.#asked = true;
			if (packet[0] === CONTINUE && id === 0) {
				this.#heard = true;
				this.#settle();
			}
			return;
		}
		if (id === 0) {
			// a lane still waiting for its greeting is not in the connection yet
			for (const lane of this.#lanes)
				if (!this.#waiting.includes(lane)) lane.send(buffer.slice(0));
			return;
		}
		const stream = this.#streams.get(id);
		if (!stream) return;
		setStream(packet, stream.id);
		stream.lane.send(buffer);
		if (packet[0] === CLOSE) {
			this.#streams.delete(id);
			stream.lane.streams.delete(stream.id);
		}
	}

	#fromLane(lane: Lane, packet: Uint8Array) {
		if (!this.#lanes.has(lane) || packet.length < 5) return;
		const own = streamOf(packet);
		if (own === 0) {
			if (lane === this.#primary && !this.#said) {
				this.#write(packet);
				if (packet[0] === INFO) {
					this.#said = true;
					this.#settle();
				}
			}
			return;
		}
		if (lane === this.#primary && !this.#said) {
			// an epoxy that said no INFO of its own (v1) is past its handshake
			this.#said = true;
			this.#settle();
		}
		let id: number | undefined;
		if (packet[0] === CONNECT) {
			id = this.#next();
			lane.streams.set(own, id);
			this.#streams.set(id, { lane, id: own });
		} else id = lane.streams.get(own);
		if (id === undefined) return;
		setStream(packet, id);
		if (packet[0] === CLOSE) {
			lane.streams.delete(own);
			this.#streams.delete(id);
		}
		this.#write(packet);
	}

	/** the handshake is over once the relay's CONTINUE and the first lane's INFO (when asked for) are in */
	#settle() {
		if (this.#greeted || !this.#heard || (this.#asked && !this.#said)) return;
		this.#greeted = true;
		for (const lane of this.#waiting.splice(0)) this.#greet(lane);
	}

	/** the connection's next stream id, never one in use (nor 0) */
	#next(): number {
		do this.#last = this.#last >= 0xffffffff ? 1 : this.#last + 1;
		while (this.#streams.has(this.#last));
		return this.#last;
	}

	#write(packet: Uint8Array) {
		// a carrier's writer settles at once (promptSink, or a WebSocket's
		// send); one that failed has ended its read too
		this.#writer.write(packet).catch(() => {});
	}

	/** a lane ended: its streams are closed, the others go on */
	#drop(lane: Lane) {
		if (!this.#lanes.delete(lane)) return;
		for (const id of lane.streams.values()) {
			this.#streams.delete(id);
			const close = new Uint8Array(6);
			close[0] = CLOSE;
			setStream(close, id);
			close[5] = VOLUNTARY;
			if (!this.#ended) this.#write(close);
		}
		lane.streams.clear();
		lane.end();
		// a handshake its lane never finished leaves no greeting for the rest
		if (lane === this.#primary && !this.#greeted) this.#end();
	}

	/** the relay's connection ended: so does every lane's */
	#end() {
		if (this.#ended) return;
		this.#ended = true;
		for (const lane of this.#lanes) lane.end();
		for (const lane of this.#waiting) lane.end();
		this.#lanes.clear();
		this.#waiting = [];
		this.#streams.clear();
		this.#writer.close().catch(() => {});
	}
}

/**
 * The shard's end of a lane, as epoxy's function transport takes it: each
 * read one packet, each write one packet. The writes of one task go in one
 * message. `end` lets it go from this side.
 */
export function lanePipe(
	port: MessagePort,
	arrived?: () => void,
	credit = false,
): WispPipe & { end(): void } {
	let reading!: ReadableStreamDefaultController<ArrayBuffer>;
	let done = false;
	const feed = wispFeed((packet) => {
		try {
			reading.enqueue(packet);
		} catch {
			// cancelled already
		}
	});
	// a carrier host's rider (`ride`) at the pace of this realm's body readers
	const pace = credit ? paceRider(port, feed.push) : null;
	const batch = new PacketBatch((sent) => {
		if (!done) port.postMessage(sent satisfies LaneMessage, sent);
	});
	const finish = () => {
		if (done) return;
		batch.flush();
		done = true;
		pace?.end(false);
		feed.flush();
		port.postMessage('end' satisfies LaneMessage);
		port.close();
		try {
			reading.close();
		} catch {
			// cancelled already
		}
	};
	const read = new ReadableStream<ArrayBuffer>({
		start(controller) {
			reading = controller;
		},
		cancel: finish,
	});
	port.onmessage = ({ data }: MessageEvent<LaneMessage>) => {
		if (done) return;
		if (data instanceof ArrayBuffer) {
			arrived?.();
			if (pace) pace.take([data]);
			else feed.push(data);
			return;
		}
		if (!Array.isArray(data)) {
			// the lane's end, or the carrier host's (its relay's carrier
			// ended): what waits here came before it
			pace?.end(true);
			feed.flush();
			done = true;
			batch.clear();
			port.close();
			try {
				reading.close();
			} catch {
				// cancelled already
			}
			return;
		}
		arrived?.();
		if (pace) pace.take(data);
		else for (const packet of data) feed.push(packet);
	};
	port.start();
	const write = new WritableStream<Uint8Array>({
		write(packet) {
			if (done) throw new Error('the Wisp connection ended');
			// a view of a larger buffer (epoxy's memory) is copied; a packet
			// that owns its buffer is transferred
			batch.push(ownBuffer(packet));
		},
		close: finish,
		abort: finish,
	});
	return { read, write, end: finish };
}
