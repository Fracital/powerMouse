// The carrier host: one wisp connection per relay for every transport of
// the host's origin (its tabs, and the page a reload brings), in a
// SharedWorker of the transport worker's script that Chrome keeps for five
// minutes after its last page (`extendedLifetime`, carrierClient.ts). A
// transport worker is the page's and goes with it; a carrier opened there
// went too, and every reload and every new tab paid a WebTransport
// session's handshake again before its first byte (holyWisp 0.5.4: 353 ms
// warm, 520 cold, as measured from the host). Here the session (or the
// WebSocket) is opened once, chosen as a transport would choose it
// (wispWebTransport.ts Chooser, its memory included), and a reload finds
// it up; Chrome keeps it through the back/forward cache as well.
//
// A session is one wisp connection, however many lanes it rides (each
// CONNECT the host sends takes the quietest lane, as a transport's own
// would: wispWebTransport.ts pipeOf), so the transports share it as
// riders of that connection: each rider is a wisp connection of its own
// to its epoxy (its stream ids from 1, the relay's INFO and its CONTINUE for
// stream 0 played to it as the relay sent them), and the host gives each of
// its streams an id of the relay's connection and puts each packet's id back
// on the way in. Every rider's INFO must say what the first one's said (it
// is the one the relay heard); a rider whose INFO differs is let go, and its
// transport opens a carrier of its own. Flow control is per stream and
// needs nothing else. A rider whose client stops saying it is alive (its
// page is gone) has its streams closed on the relay; a relay no rider has
// used for RELAY_IDLE_MS is closed.
//
// Only the carrier is shared, and the limits on what rides it: epoxy, its
// connections and its TLS stay in each page's transport worker, which can
// start workers of its own (stomp-h3's thread, its transport's shards; a
// SharedWorkerGlobalScope has no Worker), and each asks the host's socket
// pool and WebSocket gate (socketPool.ts), as Chrome's tabs ask their
// profile's one pool. The relay limits a connection's streams (holyWisp:
// 2048, fewer while it throttles, past which a CONNECT is closed with
// 0x49); a refused CONNECT is held here and sent again as streams close,
// its rider told nothing. A rider can be given more of the same relay
// (`ride`), one for each shard of a transport, whose worker then speaks to
// the host directly; a rider and its client that both say `batches` send
// the packets of one task in one message (packetBatch.ts).
import {
	ALIVE,
	ALIVE_MS,
	CARRIER_HOST_RPC,
	END,
	GONE_MS,
	LEFT,
	PAGE_ALIVE,
	PAGE_GONE_MS,
	RIDER_WINDOW,
	type CarrierAsk,
	type CarrierGiven,
	type ClientBound,
	type HostBound,
} from './carrierClient';
import { PacketBatch } from './packetBatch';
import { RpcHelper } from './rpc';
import {
	SocketPool,
	WebSocketGate,
	type Held,
	type PoolLine,
	type SocketPass,
} from './socketPool';
import { StreamCreditWatch } from './streamCredit';
import { watchTransportNotes, wispNote } from './transportLog';
import {
	Chooser,
	memory,
	relayPlan,
	watchEnd,
	type OpenCarrier,
} from './wispWebTransport';

/** how long a relay no rider rides is kept open (a reload is back long before) */
const RELAY_IDLE_MS = 30 * 1000;

const CONNECT = 0x01;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const INFO = 0x05;
/** a CLOSE's reason: the client closed the stream */
const VOLUNTARY = 0x02;
/**
 * a CLOSE's reason: the relay refuses a stream past its limit (holyWisp:
 * `max-streams-per-conn`, 2048 a session, which its reputation's THROTTLE
 * lowers)
 */
const THROTTLED = 0x49;
/** what a stream sent before the relay first answered it is kept to this much, to send again */
const EARLY_KEPT_BYTES = 128 * 1024;
/** how soon the relay is asked again for a stream it refused, doubling to RETRY_MAX_MS */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 8000;
/** a stream held this long, while no stream closed on the relay in that time, hears the refusal */
const HOLD_MS = 30 * 1000;
/** a CONNECT's stream type: UDP */
const UDP = 0x02;
/** a CLOSE's reason: the stream failed (Wisp's 0x03, a network error) */
const NETWORK_ERROR = 0x03;

/*
 * A rider whose client takes its packets slower than the relay sends them
 * (`credit`: its readers are slow) holds the relay back, as a reader holds
 * its socket back natively. But the relay connection is every stream of the
 * profile's, and a native socket holds back only itself: the host stops
 * reading the relay for a rider behind for PAUSE_MAX_MS at most, and not at
 * all while a UDP stream is open (a datagram never waits) or another rider
 * was given packets in the last KEEPING_UP_MS and is not behind (its readers
 * keep up). Past a pause the rider is let fall behind until it takes
 * something, its packets queued here. A queue past RIDER_QUEUE_MAX holds
 * the relay back again while its readers still take some (they read
 * slower than the relay sends: a decrypting shard on a busy machine), and
 * once they took nothing for STALLED_MS the stream that holds the most of
 * it is reset, as a socket is reset under memory pressure.
 *
 * A relay connection with stream credit (Wisp's 0xE2, streamCredit.ts)
 * holds back each stream alone at the relay, as its reader in epoxy grants:
 * the host never pauses it for a rider then, behind or over, since that
 * would hold every stream of the profile for one. What waits for a rider is
 * bounded by what its epoxy granted; one whose readers took nothing for
 * STALLED_MS with more than RIDER_QUEUE_MAX waiting (a relay that sent past
 * its grants) still has its largest stream reset.
 */
const PAUSE_MAX_MS = 50;
const KEEPING_UP_MS = 100;
const RIDER_QUEUE_MAX = 64 * 1024 * 1024;
const STALLED_MS = 2000;

/**
 * A stream the relay has not answered yet: its CONNECT and what its rider
 * sent on it since, as they went to the relay (or will, once one held)
 */
interface Opening {
	rider: Rider;
	mine: number;
	relayId: number;
	packets: Uint8Array[];
	bytes: number;
	/** it went to the relay (one held has not, or not since its refusal) */
	sent: boolean;
	/** every packet it sent is kept (a refusal can be taken back) */
	whole: boolean;
	since: number;
}

const u32 = (bytes: Uint8Array, at: number) =>
	(bytes[at] |
		(bytes[at + 1] << 8) |
		(bytes[at + 2] << 16) |
		(bytes[at + 3] << 24)) >>>
	0;
function setU32(bytes: Uint8Array, at: number, value: number) {
	bytes[at] = value & 0xff;
	bytes[at + 1] = (value >>> 8) & 0xff;
	bytes[at + 2] = (value >>> 16) & 0xff;
	bytes[at + 3] = (value >>> 24) & 0xff;
}
const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);
/** a copy of `bytes` in a buffer of its own, to transfer */
const own = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const short = (error: unknown) =>
	String((error as Error)?.message ?? error).slice(0, 160);

/**
 * the most a rider's message carries: the relay's packets each come in a
 * task of their own, and gather only while the host is busy
 * (PacketBatch's `idle`); a message posted to another process costs about
 * as much whatever it carries
 */
const RIDER_MESSAGE_MAX = 256 * 1024;

/** a page's control port */
interface Client {
	port: MessagePort;
	seen: number;
	/** how long it may be silent before its riders are let go */
	goneMs: number;
	riders: Set<Rider>;
	/** its name in the host's pool (its groups', and its requests' ids) */
	realm: string;
	/** what it holds of the pool and the gate, by the name it was given */
	tickets: Map<number, Held>;
	passes: Map<number, SocketPass>;
	/** its requests waiting in the pool, by their pool ids */
	holding: Set<string>;
	named: number;
	/** it was let go (silent, or its page unloaded): what it is given now goes at once */
	left: boolean;
}

/**
 * A client let go: its requests waiting in the pool leave the line, and
 * its connections and WebSocket passes go to the others
 */
function leave(client: Client, pool: SocketPool) {
	client.left = true;
	for (const id of [...client.holding]) pool.cancel(id);
	for (const held of client.tickets.values()) held.release();
	client.tickets.clear();
	for (const pass of client.passes.values()) {
		pass.connected();
		pass.closed();
	}
	client.passes.clear();
}

/**
 * a client silent this long is forgotten (one whose riders were let go
 * may still come back from the back/forward cache, and ask again)
 */
const FORGET_MS = 10 * 60 * 1000;

/** one transport's wisp connection over the relay's */
class Rider {
	/** its stream ids, to the relay connection's */
	ids = new Map<number, number>();
	/** it was played the relay's INFO */
	greeted = false;
	/** its INFO was taken (v2), or there is none to take (v1) */
	ready = false;
	ended = false;
	/** it says what it took (CarrierAsk.credit): RIDER_WINDOW past that is posted, the rest held */
	#credit: boolean;
	/** bytes posted that it has not said it took */
	#out = 0;
	#held: ArrayBuffer[] = [];
	#heldBytes = 0;
	#drained: (() => void) | null = null;
	/** its client takes a task's packets in one message */
	#batch: PacketBatch | null;
	/** when the relay last sent it a packet */
	fedAt = 0;
	/** a pause for it ran out: the relay is not held back for it again until it takes something */
	stalled = false;
	/** when it last said it took some */
	tookAt = performance.now();
	constructor(
		readonly relay: Relay,
		readonly port: MessagePort,
		readonly client: Client,
		batches: boolean,
		credit = false,
	) {
		this.#credit = credit;
		this.#batch = batches
			? new PacketBatch(
					(packets) => {
						if (this.ended) return;
						try {
							this.port.postMessage(packets, packets);
						} catch {
							// its realm is gone
						}
					},
					{ idle: true, max: RIDER_MESSAGE_MAX },
				)
			: null;
		port.addEventListener('message', (event) => {
			const data = event.data as unknown;
			if (data instanceof ArrayBuffer) relay.fromRider(this, data);
			else if (Array.isArray(data))
				for (const packet of data as ArrayBuffer[])
					relay.fromRider(this, packet);
			else if (data === END) relay.drop(this);
			else if (typeof (data as { took?: unknown } | null)?.took === 'number')
				this.#took((data as { took: number }).took);
		});
		port.start();
	}
	/** whether more than RIDER_WINDOW waits for it: the relay is not read until it takes some */
	get behind(): boolean {
		return this.#heldBytes > RIDER_WINDOW;
	}
	/** more than RIDER_QUEUE_MAX waits for it */
	get over(): boolean {
		return this.#heldBytes > RIDER_QUEUE_MAX;
	}
	/** settles once no more than RIDER_WINDOW waits for it, or it ended */
	caughtUp(): Promise<void> {
		if (!this.behind || this.ended) return Promise.resolve();
		return new Promise((resolve) => (this.#drained = resolve));
	}
	#took(bytes: number) {
		this.stalled = false;
		this.tookAt = performance.now();
		this.#out = Math.max(0, this.#out - bytes);
		while (
			this.#held.length &&
			this.#out + this.#held[0].byteLength <= RIDER_WINDOW
		) {
			const buffer = this.#held.shift()!;
			this.#heldBytes -= buffer.byteLength;
			this.#post(buffer);
		}
		if (!this.behind) this.#wake();
	}
	#wake() {
		const resolve = this.#drained;
		this.#drained = null;
		resolve?.();
	}
	/** what was gathered for it, posted now */
	flush() {
		if (!this.ended) this.#batch?.flush();
	}
	send(buffer: ArrayBuffer) {
		if (this.ended) return;
		if (
			this.#credit &&
			(this.#held.length || this.#out + buffer.byteLength > RIDER_WINDOW)
		) {
			this.#held.push(buffer);
			this.#heldBytes += buffer.byteLength;
			return;
		}
		this.#post(buffer);
	}
	/** the stream (its id) whose packets are most of what waits for it */
	largestQueued(): number | null {
		const bytes = new Map<number, number>();
		for (const buffer of this.#held) {
			const id = u32(new Uint8Array(buffer, 0, 5), 1);
			if (id) bytes.set(id, (bytes.get(id) ?? 0) + buffer.byteLength);
		}
		let largest: number | null = null;
		for (const [id, n] of bytes)
			if (largest === null || n > bytes.get(largest)!) largest = id;
		return largest;
	}
	/** what waits for it of stream `id`, dropped, and the stream's CLOSE posted with `reason` */
	reset(id: number, reason: number) {
		const kept: ArrayBuffer[] = [];
		this.#heldBytes = 0;
		for (const buffer of this.#held)
			if (u32(new Uint8Array(buffer, 0, 5), 1) !== id) {
				kept.push(buffer);
				this.#heldBytes += buffer.byteLength;
			}
		this.#held = kept;
		const close = new Uint8Array(6);
		close[0] = CLOSE;
		setU32(close, 1, id);
		close[5] = reason;
		this.#post(close.buffer);
		if (!this.behind) this.#wake();
	}
	#post(buffer: ArrayBuffer) {
		this.#out += buffer.byteLength;
		if (this.#batch) {
			this.#batch.push(buffer);
			return;
		}
		try {
			this.port.postMessage(buffer, [buffer]);
		} catch {
			// its realm is gone
		}
	}
	/** tell it its carrier ended (`lost`: without a close of the relay's) */
	end(lost: boolean) {
		if (this.ended) return;
		// what waits for it goes first: the end comes after its packets
		for (const buffer of this.#held.splice(0)) this.#post(buffer);
		this.#heldBytes = 0;
		this.#batch?.flush();
		this.ended = true;
		this.#wake();
		try {
			this.port.postMessage({ end: lost ? 'lost' : 'closed' });
			this.port.close();
		} catch {
			// its realm is gone
		}
	}
}

let relays = 0;

/** a relay's carrier and the riders on it */
class Relay {
	dead = false;
	/** its name to its clients (CarrierGiven.relay) */
	readonly id = ++relays;
	#chooser: Chooser;
	#ready: Promise<OpenCarrier | null>;
	#open: OpenCarrier | null = null;
	#writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	#why = '';
	#ms = 0;
	#upAt = 0;
	#forget: () => void;
	/** the relay's INFO (Wisp v2), as it sent it */
	#serverInfo: Uint8Array | null = null;
	/** the relay's CONTINUE for stream 0 (the buffer of every new stream) */
	#continue0: Uint8Array | null = null;
	/** whether the relay spoke v1 (a CONTINUE before any INFO) */
	#v1 = false;
	/** the first rider's INFO, the one the relay heard */
	#clientInfo: Uint8Array | null = null;
	/** whether the relay's INFO and the first rider's named stream credit */
	#streamCredit = new StreamCreditWatch();
	#riders = new Set<Rider>();
	/** the relay connection's stream ids, to the rider and its own id */
	#routes = new Map<number, [Rider, number]>();
	/** the relay connection's stream ids of UDP streams */
	#udp = new Set<number>();
	#next = 1;
	#idle: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The relay's limit on a connection's streams (holyWisp's 2048, or
	 * fewer while it throttles) is the host's to keep: every transport of
	 * the origin rides this connection, and each knew only its own streams.
	 * A CONNECT the relay refuses with THROTTLED waits, and goes again as a
	 * stream closes (or the relay answers one held), on no other session and
	 * with nothing said to its rider; while one waits, every new one waits
	 * behind it.
	 */
	#opening = new Map<number, Opening>();
	#held: Opening[] = [];
	#lastClose = 0;
	#retryMs = RETRY_FIRST_MS;
	#retry: ReturnType<typeof setTimeout> | undefined;

	constructor(ask: CarrierAsk, forget: () => void) {
		this.#chooser = new Chooser(ask.wisp, ask.first, ask.webTransport);
		this.#forget = forget;
		this.#ready = this.#start(ask);
	}

	async #start(ask: CarrierAsk): Promise<OpenCarrier | null> {
		const started = performance.now();
		let open: OpenCarrier | null;
		let key: string;
		if (ask.webTransport) {
			const plan = relayPlan(ask.wisp, ask.webTransport);
			key = plan.key;
			({ open, why: this.#why } = await this.#chooser.choose(plan));
		} else {
			key = `wisp ${ask.wisp}`;
			this.#why = 'off';
			open = await this.#chooser.socket().catch((error) => {
				wispNote('warn', `websocket did not open (${short(error)})`);
				return null;
			});
		}
		this.#ms = Math.round(performance.now() - started);
		if (!open) {
			this.#gone();
			return null;
		}
		this.#upAt = performance.now();
		watchEnd(open, key);
		this.#open = open;
		this.#writer = open.pipe.write.getWriter();
		void this.#read(open);
		this.#idleCheck();
		return open;
	}

	/**
	 * Whether a transport that asks for `ask` rides this relay, as the
	 * start it would have made on its own: a session, or the WebSocket the
	 * ask wants alone (WebTransport off), are what that start would have
	 * ended on, and so is the WebSocket a failed session left while its
	 * quiet lasts. Past the quiet, or once a session is known to work, the
	 * start chooses again (a session beside the WebSocket, or the session),
	 * and the riders on this one stay until they let go.
	 */
	async takes(ask: CarrierAsk): Promise<boolean> {
		if (this.dead) return false;
		const open = this.#open;
		if (!open || open.carrier === 'webtransport' || !ask.webTransport)
			return true;
		const known = await memory.get(relayPlan(ask.wisp, ask.webTransport).key);
		return known === 'quiet' && !this.dead;
	}

	/** a rider for `client` (`batches`: it takes a task's packets at once; `credit`: it says what it took), or why there is none */
	async rider(
		client: Client,
		batches: boolean,
		credit = false,
	): Promise<CarrierGiven> {
		const opened = this.#open === null;
		const open = await this.#ready;
		if (!open || this.dead)
			return {
				port: null,
				why: this.#why || 'no carrier could be opened',
				ms: this.#ms,
				upMs: 0,
				riders: 0,
			};
		const channel = new MessageChannel();
		const rider = new Rider(this, channel.port1, client, batches, credit);
		this.#riders.add(rider);
		client.riders.add(rider);
		clearTimeout(this.#idle);
		this.#greet(rider);
		return {
			port: channel.port2,
			carrier: open.carrier,
			url: open.url,
			why: this.#why,
			ms: opened ? this.#ms : 0,
			upMs: opened ? 0 : Math.round(performance.now() - this.#upAt),
			riders: this.#riders.size,
			credit,
			relay: this.id,
			batches: true,
			...(open.stats && {
				lanes: open.stats.lanes,
				serverStream: open.stats.server,
			}),
		};
	}

	/** play a rider what the relay said of the connection so far */
	#greet(rider: Rider) {
		if (this.#serverInfo && !rider.greeted) {
			rider.greeted = true;
			rider.send(own(this.#serverInfo));
		}
		if (this.#v1) rider.ready = true;
		if (rider.ready && this.#continue0) rider.send(own(this.#continue0));
	}

	async #read(open: OpenCarrier) {
		const reader = open.pipe.read.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.#fromRelay(value);
				// a rider far behind holds the relay back (riderCarrier's pace), for a while
				await this.#pace();
			}
		} catch {
			// the carrier failed
		}
		let lost = false;
		await open.ended.catch(() => (lost = true));
		this.#gone(lost);
	}

	/** a rider far behind holds the relay back, PAUSE_MAX_MS at most, while no other stream would wait for it */
	async #pace() {
		if (this.#streamCredit.on) {
			// the relay holds back each stream itself: nothing waits here
			for (const rider of this.#riders)
				while (
					rider.over &&
					!rider.ended &&
					performance.now() - rider.tookAt > STALLED_MS &&
					rider.largestQueued() !== null
				)
					this.shed(rider);
			return;
		}
		// a queue past its cap: the relay waits while its readers take some
		for (const rider of this.#riders)
			while (rider.over && !rider.ended) {
				if (performance.now() - rider.tookAt > STALLED_MS) {
					this.shed(rider);
					continue;
				}
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					rider.caughtUp(),
					new Promise((resolve) => {
						timer = setTimeout(resolve, PAUSE_MAX_MS);
					}),
				]);
				clearTimeout(timer);
			}
		let behind: Rider[] | null = null;
		for (const rider of this.#riders)
			if (rider.behind && !rider.stalled && !rider.ended)
				(behind ??= []).push(rider);
		if (!behind || this.#udp.size) return;
		const now = performance.now();
		for (const rider of this.#riders)
			if (!rider.behind && now - rider.fedAt < KEEPING_UP_MS) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = await Promise.race([
			Promise.all(behind.map((rider) => rider.caughtUp())).then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), PAUSE_MAX_MS);
			}),
		]);
		clearTimeout(timer);
		if (late)
			for (const rider of behind) if (rider.behind) rider.stalled = true;
	}

	/** a rider's queue past RIDER_QUEUE_MAX: the stream that holds most of it is reset, on the relay and to the rider */
	shed(rider: Rider) {
		const mine = rider.largestQueued();
		if (mine === null) return;
		const relayId = rider.ids.get(mine);
		rider.ids.delete(mine);
		rider.reset(mine, NETWORK_ERROR);
		if (relayId === undefined) return;
		wispNote(
			'warn',
			`a stream's reader fell ${RIDER_QUEUE_MAX >> 20} MB behind: the stream is reset`,
		);
		this.#forgetStream(relayId);
		const close = new Uint8Array(6);
		close[0] = CLOSE;
		setU32(close, 1, relayId);
		close[5] = NETWORK_ERROR;
		this.#send(close);
		this.#closed();
	}

	#fromRelay(buffer: ArrayBuffer) {
		const bytes = new Uint8Array(buffer);
		if (bytes.length < 5) return;
		const type = bytes[0];
		const id = u32(bytes, 1);
		if (id === 0) {
			if (type === INFO && !this.#serverInfo) {
				this.#serverInfo = bytes.slice();
				this.#streamCredit.fromServer(bytes);
				for (const rider of this.#riders) this.#greet(rider);
			} else if (type === CONTINUE) {
				if (!this.#serverInfo) this.#v1 = true;
				this.#continue0 = bytes.slice();
				for (const rider of this.#riders) {
					if (this.#v1) rider.ready = true;
					if (rider.ready) rider.send(own(bytes));
				}
			} else if (type === CLOSE) {
				// the relay closes the whole connection
				this.#gone();
			} else
				for (const rider of this.#riders)
					if (rider.ready) rider.send(own(bytes));
			return;
		}
		const route = this.#routes.get(id);
		if (!route) return;
		const opening = this.#opening.get(id);
		const refused = type === CLOSE && bytes[5] === THROTTLED && !!opening;
		if (opening) {
			if (refused && opening.whole) {
				// the relay's limit: it waits for a stream to close, and goes again
				opening.sent = false;
				this.#held.unshift(opening);
				this.#armRetry();
				return;
			}
			// the relay took it: the next one held may fit as well
			this.#opening.delete(id);
			if (type !== CLOSE && this.#held.length) {
				this.#retryMs = RETRY_FIRST_MS;
				this.#sendHeld();
			}
		}
		const [rider, mine] = route;
		if (type === CLOSE) {
			this.#routes.delete(id);
			this.#udp.delete(id);
			rider.ids.delete(mine);
			// (a refusal passed on freed nothing on the relay)
			if (!refused) this.#closed();
		}
		setU32(bytes, 1, mine);
		rider.fedAt = performance.now();
		rider.send(buffer);
	}

	fromRider(rider: Rider, buffer: ArrayBuffer) {
		if (rider.ended || this.dead) return;
		const bytes = new Uint8Array(buffer);
		if (bytes.length < 5) return;
		const type = bytes[0];
		const id = u32(bytes, 1);
		if (id === 0) {
			if (type === INFO && !rider.ready) {
				if (!this.#clientInfo) {
					this.#clientInfo = bytes.slice();
					this.#streamCredit.fromClient(bytes);
					this.#send(bytes);
				} else if (!same(bytes, this.#clientInfo)) {
					// another epoxy, another handshake: it opens a carrier of its own
					this.drop(rider);
					return;
				}
				rider.ready = true;
				if (this.#continue0) rider.send(own(this.#continue0));
			} else if (type === CLOSE) this.drop(rider);
			return;
		}
		if (!rider.ready) return;
		if (type === CONNECT) {
			const previous = rider.ids.get(id);
			if (previous !== undefined) this.#forgetStream(previous);
			const relayId = this.#allocate();
			rider.ids.set(id, relayId);
			this.#routes.set(relayId, [rider, id]);
			if (bytes[5] === UDP) this.#udp.add(relayId);
			this.#opening.set(relayId, {
				rider,
				mine: id,
				relayId,
				packets: [],
				bytes: 0,
				sent: !this.#held.length,
				whole: true,
				since: performance.now(),
			});
		}
		const relayId = rider.ids.get(id);
		if (relayId === undefined) return;
		setU32(bytes, 1, relayId);
		const opening = this.#opening.get(relayId);
		if (type === CLOSE) {
			rider.ids.delete(id);
			this.#forgetStream(relayId);
			// one held never reached the relay: there is nothing to close there
			if (opening && !opening.sent) return;
			this.#send(bytes);
			this.#closed();
			return;
		}
		if (opening) {
			// kept until the relay answers the stream, to send again after a
			// refusal; past EARLY_KEPT_BYTES a refusal is passed on instead
			// (one held keeps all: the stream's flow control bounds it)
			if (opening.sent && opening.bytes + bytes.length > EARLY_KEPT_BYTES) {
				opening.whole = false;
				opening.packets = [];
			} else if (opening.whole) {
				opening.packets.push(bytes.slice());
				opening.bytes += bytes.length;
			}
			if (!opening.sent) {
				if (type === CONNECT) {
					this.#held.push(opening);
					this.#armRetry();
				}
				return;
			}
		}
		this.#send(bytes);
	}

	/** the relay's stream `relayId` is no one's now (closed, or its id taken again) */
	#forgetStream(relayId: number) {
		this.#routes.delete(relayId);
		this.#udp.delete(relayId);
		const opening = this.#opening.get(relayId);
		if (!opening) return;
		this.#opening.delete(relayId);
		const at = this.#held.indexOf(opening);
		if (at >= 0) this.#held.splice(at, 1);
	}

	/** a stream closed on the relay: one held goes in its place */
	#closed() {
		this.#lastClose = performance.now();
		if (this.#held.length) this.#sendHeld();
	}

	/** the first stream held goes to the relay (again), as it went the first time */
	#sendHeld() {
		const opening = this.#held.shift();
		if (!opening) return;
		opening.sent = true;
		for (const packet of opening.packets) this.#send(packet.slice());
	}

	/**
	 * While streams are held the relay is asked again with backoff, as its
	 * limit may have risen (holyWisp's reputation lowers it under THROTTLE,
	 * and lifts it); a stream held HOLD_MS while none closed on the relay
	 * in that time hears the refusal
	 */
	#armRetry() {
		if (this.#retry !== undefined || this.dead) return;
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			if (this.dead || !this.#held.length) {
				this.#retryMs = RETRY_FIRST_MS;
				return;
			}
			const now = performance.now();
			if (now - this.#lastClose >= HOLD_MS)
				for (const opening of [...this.#held])
					if (now - opening.since >= HOLD_MS) this.#refuse(opening);
			this.#sendHeld();
			this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS);
			this.#armRetry();
		}, this.#retryMs);
	}

	/** a stream held too long is refused, as the relay refused it */
	#refuse(opening: Opening) {
		const { rider, mine, relayId } = opening;
		this.#forgetStream(relayId);
		if (rider.ids.get(mine) === relayId) rider.ids.delete(mine);
		const close = new Uint8Array(6);
		close[0] = CLOSE;
		setU32(close, 1, mine);
		close[5] = THROTTLED;
		rider.send(close.buffer);
	}

	/** a stream id of the relay connection no stream has */
	#allocate(): number {
		for (;;) {
			const id = this.#next;
			this.#next = this.#next >= 0xffffffff ? 1 : this.#next + 1;
			if (!this.#routes.has(id)) return id;
		}
	}

	#send(bytes: Uint8Array) {
		this.#writer?.write(bytes).catch(() => {});
	}

	/** a rider let go (its epoxy, or its page is gone): its streams are closed on the relay */
	drop(rider: Rider) {
		if (!this.#riders.delete(rider)) return;
		rider.client.riders.delete(rider);
		for (const relayId of rider.ids.values()) {
			const opening = this.#opening.get(relayId);
			this.#forgetStream(relayId);
			if (opening && !opening.sent) continue;
			const close = new Uint8Array(6);
			close[0] = CLOSE;
			setU32(close, 1, relayId);
			close[5] = VOLUNTARY;
			this.#send(close);
			this.#closed();
		}
		rider.ids.clear();
		rider.end(false);
		this.#idleCheck();
	}

	/** a relay no rider rides is closed after RELAY_IDLE_MS */
	#idleCheck() {
		clearTimeout(this.#idle);
		if (this.#riders.size || this.dead) return;
		this.#idle = setTimeout(() => {
			if (this.#riders.size) return;
			this.#open?.close();
			this.#gone();
		}, RELAY_IDLE_MS);
	}

	/** the carrier ended: so does every rider, whose transport chooses again */
	#gone(lost = false) {
		if (this.dead) return;
		this.dead = true;
		clearTimeout(this.#idle);
		clearTimeout(this.#retry);
		this.#opening.clear();
		this.#held.length = 0;
		this.#forget();
		for (const rider of this.#riders) {
			rider.client.riders.delete(rider);
			rider.end(lost);
		}
		this.#riders.clear();
		this.#routes.clear();
		this.#udp.clear();
	}
}

/** the key of the relay a transport asks for: what its carrier is opened with */
function keyOf(ask: CarrierAsk): string {
	return JSON.stringify([
		ask.wisp,
		ask.webTransport,
		Boolean(ask.first.wisp_v2),
		ask.first.wisp_ws_protocols ?? [],
	]);
}

function alive(port: MessagePort) {
	try {
		port.postMessage(ALIVE);
	} catch {
		// its realm is gone
	}
}

/** In the SharedWorker: serve carriers to every page of the origin that connects */
export function serveCarriers(scope: SharedWorkerGlobalScope): void {
	const relays = new Map<string, Relay>();
	const byId = new Map<number, Relay>();
	const clients = new Map<RpcHelper<HostBound, ClientBound>, Client>();
	// Chrome's limits, for every realm of the origin as for a profile
	// (socketPool.ts): one pool, and one WebSocket endpoint lock (the 255
	// WebSockets are each realm's, as Chrome counts a renderer process's)
	const pool = new SocketPool();
	const gate = new WebSocketGate(Infinity);
	let realms = 0;
	// what the host's choices and carriers tell goes to every page's console
	watchTransportNotes((note) => {
		for (const rpc of clients.keys()) rpc.call('note', note).catch(() => {});
	});
	// every page hears the host is alive; a page that stopped saying it is
	// has its riders let go
	setInterval(() => {
		const now = performance.now();
		for (const [rpc, client] of clients) {
			const silent = now - client.seen;
			if (silent >= client.goneMs) {
				for (const rider of [...client.riders]) rider.relay.drop(rider);
				if (!client.left) leave(client, pool);
			}
			if (silent >= FORGET_MS) {
				clients.delete(rpc);
				rpc.abort('the page is gone');
				client.port.close();
				continue;
			}
			alive(client.port);
		}
	}, ALIVE_MS);
	scope.addEventListener('connect', (event) => {
		const port = (event as MessageEvent).ports[0];
		if (!port) return;
		const client: Client = {
			port,
			seen: performance.now(),
			goneMs: GONE_MS,
			riders: new Set(),
			realm: String(++realms),
			tickets: new Map(),
			passes: new Map(),
			holding: new Set(),
			named: 0,
			left: false,
		};
		/** the pool's id of the request the client's worker named `id` */
		const poolId = (id: string) => id && `${client.realm} ${id}`;
		const rpc = new RpcHelper<HostBound, ClientBound>(
			{
				open: async (ask) => {
					const key = keyOf(ask);
					const kept = relays.get(key);
					let relay = kept && (await kept.takes(ask)) ? kept : undefined;
					if (!relay) {
						// another ask may have made one while this one looked
						const now = relays.get(key);
						if (now && now !== kept && !now.dead) relay = now;
						else {
							const made: Relay = new Relay(ask, () => {
								if (relays.get(key) === made) relays.delete(key);
								byId.delete(made.id);
							});
							relay = made;
							relays.set(key, made);
							byId.set(made.id, made);
						}
					}
					const given = await relay.rider(
						client,
						ask.batches === true,
						ask.credit === true,
					);
					return [given, given.port ? [given.port] : []];
				},
				ride: async ({ relay: id, batches, credit }) => {
					const relay = byId.get(id);
					if (!relay || relay.dead)
						return [
							{
								port: null,
								why: 'the relay is gone',
								ms: 0,
								upMs: 0,
								riders: 0,
							},
							[],
						];
					const given = await relay.rider(client, batches, credit === true);
					return [given, given.port ? [given.port] : []];
				},
				hold: async (fields) => {
					const id = poolId(fields.id);
					if (id) client.holding.add(id);
					let held: Held;
					try {
						held = await pool.hold(
							{ ...fields, id },
							() => void rpc.call('waiting', fields.id).catch(() => {}),
							client.realm,
						);
					} finally {
						if (id) client.holding.delete(id);
					}
					const ticket = ++client.named;
					if (client.left) held.release();
					else client.tickets.set(ticket, held);
					return [{ ticket, counted: held.counted }, []];
				},
				learn: async ({ ticket, version, line, holds }) => {
					const held = client.tickets.get(ticket);
					if (!held) return [null, []];
					let told: PoolLine | null = null;
					const keeps = held.learn(
						version,
						line ? (said) => (told = said) : undefined,
					);
					if (!keeps || !holds) {
						held.release();
						client.tickets.delete(ticket);
					}
					return [told, []];
				},
				release: async (ticket) => {
					client.tickets.get(ticket)?.release();
					client.tickets.delete(ticket);
				},
				requeue: async ({ id, urgency }) => {
					if (urgency === null) pool.cancel(poolId(id));
					else pool.raise(poolId(id), urgency);
				},
				admit: async (key) => {
					const pass = await gate.admitTo(key);
					if (!pass) return [null, []];
					const named = ++client.named;
					if (client.left) {
						pass.connected();
						pass.closed();
					} else client.passes.set(named, pass);
					return [named, []];
				},
				connected: async (named) => client.passes.get(named)?.connected(),
				closed: async (named) => {
					const pass = client.passes.get(named);
					client.passes.delete(named);
					pass?.connected();
					pass?.closed();
				},
			},
			CARRIER_HOST_RPC,
			(data, transfer) => port.postMessage(data, transfer),
		);
		port.addEventListener('message', (event) => {
			client.seen = performance.now();
			if (event.data === LEFT) return leave(client, pool);
			// one let go that speaks again (back from the back/forward cache) holds again
			client.left = false;
			if (event.data === PAGE_ALIVE) client.goneMs = PAGE_GONE_MS;
			else if (event.data !== ALIVE) rpc.receive(event.data);
		});
		port.start();
		clients.set(rpc, client);
		// the page's first start knows the host is up
		alive(port);
	});
}
