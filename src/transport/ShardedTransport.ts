// The transport's TLS on several threads, when one is not enough. One
// transport worker ran epoxy, and with it every TLS connection's crypto,
// its HTTP/2 and the Wisp multiplexing, on one core: a download over TLS
// through a local holyWisp held at about 550 to 610 Mbit/s on a Ryzen 9
// 7950X core however many servers it came from, the worker at 97 % of the
// core (AES-GCM most of it).
//
// Here the transport worker runs its transport as shards. Shard 0 is an
// instance of the module in the transport worker itself, as a transport
// that runs alone; the others are instances in workers the transport worker
// starts from its own script (shardWorker.ts), started only when shard 0
// and every other one running cannot keep up, and closed again when they
// have carried nothing for IDLE_MS. A start, and browsing that one thread
// keeps up with, pays for no worker.
//
// - A shard is saturated when its thread runs a task posted now later than
//   a few milliseconds on average while Wisp packets come to it
//   (shards.ts Saturation): the packets wait behind one another.
// - A group is busy while it has a response body in flight that has been
//   read for BUSY_MS or more: a download, not a page's images.
// - The next shard starts when there are more busy groups than shards
//   running and no shard running could take one: each is saturated (shard
//   0 counts as such while it relays the others' packets). Up to the
//   descriptor's `shards`, as many at once as there are busy groups beyond
//   one a shard.
//
// Each request, WebSocket and raw stream goes to one shard by its group
// (its network partition and its origin, or the stream's host and port).
// A group is placed on a shard the first time it is seen: the one not
// saturated, then with the fewest busy groups, the fewest requests in
// flight, the fewest groups used in the last 2 s, the fewest bytes from
// the relay lately, the fewest groups used lately. It stays there, so its
// connections are the pool of one epoxy, its TLS sessions are kept and
// resumed there, and the connections it opens are the ones one epoxy would
// open; a group moves only when it has nothing in flight and its shard is
// saturated while another is not, and its next request goes to the other
// one (a new connection there, its TLS handshaken again; the old shard's
// idle connections close on their own). What decides how many connections
// a group has and when a request may go (socketPool.ts), the fields sent
// (fitHeaders), a body resumed by range (resumableBody.ts) and the order
// requests go in stay with serveTransport in the transport worker, before
// any request reaches a shard, as for a transport that runs alone.
//
// The Wisp connection stays one, the transport's: what CarrierTransport
// hands its transport (the carrier, or the carrier host's rider), or a
// WebSocket opened here as epoxy would open its own, is split into a lane
// per shard (wispSplit.ts), each lane's epoxy shaking hands with the
// relay's one greeting and its streams renumbered into the connection's.
// The relay sees one session, one handshake and one stream id space.
// Shard 0's packets are handed over in this realm; a worker's cross as
// transferred buffers, those of one task in one message.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import { isPortBody, receiveBody } from './bodyPort';
import { transferablesOf } from './messages';
import { NETWORK_PARTITION } from './networkPartition';
import { promptSink } from './promptSink';
import { RpcHelper } from './rpc';
import {
	errorText,
	rawOverPort,
	Saturation,
	SHARD_RPC,
	SHARD_WORKER_NAME,
	type RawKind,
	type RawStream,
	type ShardBound,
	type ShardSocketMessage,
	type ShardToHost,
} from './shards';
import { warmResolver } from './shardWorker';
import { logTransport, transportLog } from './transportLog';
import { Meter, WispSplit, type WispPipe } from './wispSplit';
import { CARRIER_LOST, wispSocketPipe } from './wispWebTransport';

/** where a group runs, and what it has in flight */
interface Placed {
	shard: number;
	/** when it was last asked for, or let go of something */
	used: number;
	/** its requests (until their bodies are done), sockets and streams */
	flying: number;
	/** its response bodies being read */
	bodies: number;
	/** since when it has had a body being read */
	since: number;
	/** when it last moved to another shard */
	moved: number;
}

/** the most shards a transport is given when its descriptor names no number */
const AUTO_MAX = 4;
/** groups kept on their shard; past it the one used longest ago is forgotten */
const GROUPS_KEPT = 4096;
/** a group used within this long counts against its shard when a new one is placed (ms) */
const LATELY_MS = 30 * 1000;
/** and within this long, more (ms) */
const JUST_MS = 2000;
/** a group whose body has been read this long is busy (ms) */
const BUSY_MS = 300;
/** shards whose lanes carried lately within this many bytes of each other are as busy (wispSplit.ts Meter) */
const BUSY_STEP = 1024 * 1024;
/** a group that moved stays where it went for this long at least (ms) */
const MOVE_MS = 5000;
/** how long a shard's worker has to start and make its transport (ms) */
const BOOT_TIMEOUT_MS = 30000;
/** a shard's worker with nothing in flight for this long is closed (ms) */
const IDLE_MS = 30 * 1000;

/** TransportDescriptor.shards: the most shards, or that and how many run from the start */
export type ShardsOption = number | { max?: number; start?: number };

/** how many shards a descriptor's `shards` allows at most (1: the transport runs alone), and starts with */
export function shardCount(asked: unknown): { max: number; start: number } {
	const given = (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value)
			? Math.max(1, Math.min(16, Math.floor(value)))
			: null;
	const cores =
		(typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
	const max =
		given(asked) ??
		given((asked as { max?: unknown } | null)?.max) ??
		Math.max(1, Math.min(AUTO_MAX, Math.floor(cores / 2)));
	const start = Math.min(
		max,
		given((asked as { start?: unknown } | null)?.start) ?? 1,
	);
	return { max, start };
}

/** what a ShardedTransport is to the shards it starts */
interface Owner {
	/** a port that is one more lane of the wisp connection, for shard `index` */
	lane(v2: boolean, index: number): Promise<MessagePort>;
	/** shard `index` became saturated or not */
	load(index: number, saturated: boolean): void;
}

/** a shard's worker */
class Remote {
	readonly index: number;
	saturated = false;
	/** its requests, sockets and streams in flight */
	open = 0;
	/** settles once its transport is made, and warmed */
	ready: Promise<void>;
	/** the lanes it was given, let go when it closes */
	readonly lanes: MessagePort[] = [];
	#worker: Worker;
	#rpc: RpcHelper<ShardToHost, ShardBound>;
	#failed: Promise<never>;
	#idle: ReturnType<typeof setTimeout> | undefined;

	constructor(
		script: string,
		index: number,
		owner: Owner,
		make: ShardBound['make'][0],
	) {
		this.index = index;
		const worker = new Worker(script, {
			name: `${SHARD_WORKER_NAME} ${index}`,
		});
		this.#worker = worker;
		this.#rpc = new RpcHelper<ShardToHost, ShardBound>(
			{
				lane: async ({ v2 }) => {
					const port = await owner.lane(v2, index);
					this.lanes.push(port);
					return [port, [port]];
				},
				load: async (saturated) => {
					this.saturated = saturated;
					owner.load(index, saturated);
				},
			},
			SHARD_RPC,
			(data, transfer) => worker.postMessage(data, transfer),
		);
		worker.addEventListener('message', (event) =>
			this.#rpc.receive(event.data),
		);
		this.#failed = new Promise((_, reject) =>
			worker.addEventListener('error', (event) => {
				const why =
					(event as ErrorEvent).message ||
					`the transport shard at ${script} could not start`;
				reject(new Error(why));
			}),
		);
		this.#failed.catch(() => {});
		let timer: ReturnType<typeof setTimeout>;
		this.ready = Promise.race([
			this.call('make', make),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`the transport shard did not start within ${BOOT_TIMEOUT_MS} ms`,
							),
						),
					BOOT_TIMEOUT_MS,
				);
			}),
		])
			.finally(() => clearTimeout(timer))
			.then(() => this.call('warm', make.instance));
		this.ready.catch(() => {});
	}

	call<Method extends keyof ShardBound>(
		method: Method,
		args: ShardBound[Method][0],
		transfer: Transferable[] = [],
	): Promise<ShardBound[Method][1]> {
		return Promise.race([this.#rpc.call(method, args, transfer), this.#failed]);
	}

	/** one more thing in flight on it */
	hold() {
		this.open++;
		clearTimeout(this.#idle);
	}

	/** one less; `idle` runs once it has had nothing in flight for IDLE_MS */
	release(idle: () => void) {
		if (--this.open > 0) return;
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => {
			if (this.open === 0) idle();
		}, IDLE_MS);
	}

	close() {
		clearTimeout(this.#idle);
		this.#rpc.abort('the transport shard closed');
		this.#worker.terminate();
	}
}

let instances = 0;

/** the group a request or a stream is placed by */
function groupOf(scheme: string, host: string, headers?: RawHeaders): string {
	let partition = '';
	if (Array.isArray(headers))
		for (const [name, value] of headers)
			if (name.toLowerCase() === NETWORK_PARTITION) partition = value;
	return `${partition}\n${scheme}//${host}`;
}

/** a body as it can cross to a shard (what a host page may hand that cannot) */
function crossable(body: BodyInit | null | undefined): unknown {
	if (body instanceof URLSearchParams) return body.toString();
	return body ?? null;
}

/** `body`, telling `settled` once it was read to its end, failed or was cancelled */
function watched(
	body: ReadableStream<Uint8Array>,
	settled: () => void,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				let read;
				try {
					read = await reader.read();
				} catch (error) {
					settled();
					controller.error(error);
					return;
				}
				if (read.done) {
					settled();
					controller.close();
				} else controller.enqueue(read.value);
			},
			cancel(reason) {
				settled();
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

type RawClient = {
	[kind in `connect_${RawKind}`]?: (url: string) => Promise<RawStream>;
} & { replace_stream_provider?: () => Promise<unknown> };

/** what the transport tells of its client's raw streams, each kind on the shard of its host */
type ShardClient = {
	[kind in `connect_${RawKind}`]: (url: string) => Promise<RawStream>;
} & { replace_stream_provider: () => Promise<void> };

export interface ShardPlan {
	/** the transport module, resolved */
	module: string;
	/** the most shards */
	count: number;
	/** how many run from the start (1: shard 0 alone) */
	start: number;
	/** the transport worker's script, which a shard's worker runs */
	script: string;
}

type TransportClass = new (...args: unknown[]) => ProxyTransport;

/**
 * The transport class `Transport` as CarrierTransport constructs it (its
 * options' `wisp` the carrier's function transport, or a wisp URL), run in
 * up to `plan.count` shards
 */
export function shardedTransport(
	Transport: TransportClass,
	plan: ShardPlan,
): TransportClass {
	return class extends ShardedTransport {
		constructor(...args: unknown[]) {
			super(Transport, plan, args);
		}
	};
}

/** what a placed request, socket or stream holds until it is done */
interface Ticket {
	placed: Placed;
	/** its shard's worker; null on shard 0 */
	remote: Remote | null;
	/** let go of it (once) */
	done: () => void;
}

class ShardedTransport implements ProxyTransport {
	ready = false;
	/** the module's own (shard 0's) */
	readonly fieldSupport: unknown;
	/** what serveTransport, Http3Transport and webTransportHost open raw streams on */
	readonly client: ShardClient;
	/** each shard warms epoxy's ECH resolver itself (serveTransport's warmTransport) */
	readonly warmsResolver = true;
	readonly #instance = ++instances;
	readonly #plan: ShardPlan;
	readonly #wisp: unknown;
	/** the options as the shards' workers construct with them: the first without its wisp */
	readonly #options: unknown[];
	readonly #resolver: string | undefined;
	/** shard 0: the module's instance in this realm */
	readonly #local: ProxyTransport;
	readonly #localLoad: Saturation;
	/** by shard: its worker, null for shard 0 and a shard not running */
	#remotes: (Remote | null)[];
	/** by shard: what the relay sent its lanes lately */
	#meters: Meter[];
	#starting: Promise<void> | null = null;
	#split: WispSplit | null = null;
	#opening: Promise<WispSplit> | null = null;
	/** by group: where it runs, the one used longest ago first */
	#groups = new Map<string, Placed>();
	/** a shard's worker failed to start: no more are started */
	#noWorkers = false;

	constructor(Transport: TransportClass, plan: ShardPlan, args: unknown[]) {
		const [first, ...rest] = args as [Record<string, unknown>, ...unknown[]];
		// the ECH store (echCache.ts) stays this realm's: a worker opens its own
		const { wisp, ech_cache, ...given } = first ?? {};
		this.#plan = plan;
		this.#wisp = wisp;
		this.#options = [given, ...rest];
		this.#resolver =
			typeof given.ech_dns === 'string' ? given.ech_dns : undefined;
		this.#remotes = Array.from({ length: plan.count }, () => null);
		this.#meters = Array.from({ length: plan.count }, () => new Meter());
		this.#localLoad = new Saturation((saturated) => this.load(0, saturated));
		this.#local = new Transport(
			{
				...given,
				...(ech_cache !== undefined && { ech_cache }),
				wisp: async (v2: boolean) => {
					const split = await this.#splitter(v2);
					const pipe = split.attachLocal(this.#meters[0], () =>
						this.#localLoad.busy(),
					);
					return { read: pipe.read, write: promptSink(pipe.write) };
				},
			},
			...rest,
		);
		this.fieldSupport = (
			this.#local as { fieldSupport?: unknown }
		).fieldSupport;
		const raw = (kind: RawKind) => (url: string) => this.#raw(kind, url);
		this.client = {
			connect_udp: raw('udp'),
			connect_tcp: raw('tcp'),
			connect_tls: raw('tls'),
			replace_stream_provider: () => this.#warm(),
		};
	}

	/** what CarrierTransport reads to hand it a function transport: shard 0's */
	get client_version(): unknown {
		return (this.#local as { client_version?: unknown }).client_version;
	}

	/** epoxy's options, shard 0's: webTransportHost.ts takes a page's session roots from its pem_files */
	get opts(): unknown {
		return (this.#local as { opts?: unknown }).opts;
	}

	init(): Promise<void> {
		this.#starting ??= this.#local.init().then(
			() => {
				this.ready = true;
				for (let index = 1; index < this.#plan.start; index++)
					this.#spawn(index, 'from the start');
			},
			(error) => {
				this.#starting = null;
				throw error;
			},
		);
		return this.#starting;
	}

	async meta(): Promise<void> {}

	/** shard 0's wisp connection, opened now (epoxy's replace_stream_provider), and its resolver's */
	async #warm(): Promise<void> {
		await this.init();
		const client = (this.#local as { client?: RawClient }).client;
		await client?.replace_stream_provider?.();
		if (this.#resolver)
			void warmResolver(this.#local, this.#resolver).catch(() => {});
	}

	/** a port that is one more lane of the wisp connection, for a shard's worker */
	async lane(v2: boolean, index: number): Promise<MessagePort> {
		const split = await this.#splitter(v2);
		const channel = new MessageChannel();
		split.attach(channel.port1, this.#meters[index]);
		return channel.port2;
	}

	/**
	 * The wisp connection being split: the carrier's (a function transport
	 * gives it once), or a WebSocket to the wisp URL. Opened once: asked
	 * again after it ended, it says the connection is lost, as the carrier
	 * says to epoxy, so that RevivingTransport makes the next transport and
	 * sends again the GETs the lost connection took. Its probe, a UDP
	 * stream, fails here as over epoxy's own dead multiplexor, where a new
	 * WebSocket under it would answer and those GETs would fail
	 * (wisp-reconnect suite).
	 */
	#splitter(v2: boolean): Promise<WispSplit> {
		if (this.#split?.ended)
			return Promise.reject(
				new Error(`${CARRIER_LOST}: the wisp connection ended`),
			);
		if (this.#split) return Promise.resolve(this.#split);
		this.#opening ??= (async () => {
			let pipe: WispPipe;
			if (typeof this.#wisp === 'function')
				pipe = await (this.#wisp as (v2: boolean) => Promise<WispPipe>)(v2);
			else {
				const first = this.#options[0] as { wisp_ws_protocols?: string[] };
				const protocols = [...(first.wisp_ws_protocols ?? [])];
				// epoxy asks for v2 with a protocol of its own; holyWisp takes any
				if (v2) protocols.push(crypto.randomUUID());
				pipe = await wispSocketPipe(String(this.#wisp), protocols);
			}
			this.#split = new WispSplit(pipe);
			return this.#split;
		})().finally(() => {
			this.#opening = null;
		});
		return this.#opening;
	}

	/** whether shard `index` is running (shard 0 always is) */
	#running(index: number): boolean {
		return index === 0 || this.#remotes[index] !== null;
	}

	#saturated(index: number): boolean {
		return index === 0
			? this.#localLoad.saturated
			: (this.#remotes[index]?.saturated ?? false);
	}

	/** by shard: its busy groups */
	#busy(now: number): number[] {
		const busy = this.#meters.map(() => 0);
		for (const { shard, bodies, since } of this.#groups.values())
			if (bodies > 0 && now - since >= BUSY_MS) busy[shard]++;
		return busy;
	}

	/** shard `index` became saturated or not: start the next shard when it is time */
	load(index: number, saturated: boolean) {
		if (transportLog.on)
			logTransport(
				`transport shard ${index + 1} ${saturated ? 'cannot keep up' : 'keeps up again'}${index === 0 ? ` (tasks ${this.#localLoad.lag.toFixed(1)} ms late)` : ''}`,
			);
		if (saturated) this.#grow();
	}

	/** the next shard, when there are more busy groups than shards running and none keeps up */
	#grow() {
		if (this.#noWorkers || !this.ready) return;
		const running = this.#meters
			.map((_, index) => index)
			.filter((index) => this.#running(index));
		if (running.length >= this.#plan.count) return;
		// one that keeps up can take a group (shard 0 not, while it relays)
		const relaying = running.length > 1;
		if (
			running.some(
				(index) => !(index === 0 && relaying) && !this.#saturated(index),
			)
		)
			return;
		const busy = this.#busy(Date.now()).reduce((sum, n) => sum + n, 0);
		// as many as there are busy groups beyond one a shard, at once: each
		// waiting for the next to be saturated would take a round of moves
		for (let more = busy - running.length; more > 0; more--) {
			const index = this.#remotes.findIndex(
				(remote, index) => index > 0 && remote === null,
			);
			if (index < 0) return;
			this.#spawn(index, `${busy} downloads on ${running.length}`);
		}
	}

	/** shard `index`'s worker, started (`why`: for the verbose log) */
	#spawn(index: number, why: string) {
		const remote = new Remote(this.#plan.script, index, this, {
			instance: this.#instance,
			module: this.#plan.module,
			options: this.#options,
		});
		this.#remotes[index] = remote;
		if (transportLog.on)
			logTransport(
				`transport shard ${index + 1} of ${this.#plan.count} starts (${why})`,
			);
		remote.ready.catch((error) => {
			this.#noWorkers = true;
			this.#close(index);
			if (transportLog.on)
				logTransport(
					`transport shard ${index + 1} did not start (${errorText(error)}); shard 1 carries on`,
				);
		});
	}

	/** shard `index`'s worker had nothing in flight for IDLE_MS, or failed: its groups are placed again */
	#close(index: number) {
		const remote = this.#remotes[index];
		if (!remote) return;
		this.#remotes[index] = null;
		for (const [group, placed] of this.#groups)
			if (placed.shard === index) this.#groups.delete(group);
		for (const port of remote.lanes) this.#split?.detach(port);
		remote.close();
		if (transportLog.on)
			logTransport(`transport shard ${index + 1} closes (idle)`);
	}

	/** the shard of `group`: where it was placed, or where it goes now */
	#shardOf(group: string): Placed {
		const now = Date.now();
		const held = this.#groups.get(group);
		if (held) {
			this.#groups.delete(group);
			held.used = now;
			this.#groups.set(group, held);
			// nothing of it in flight on a shard that cannot keep up: its next
			// request may go to one that keeps up and has fewer busy groups
			// than its shard has besides it (so a group alone on its shard
			// stays, and two shards do not trade groups back and forth)
			if (
				held.flying === 0 &&
				now - held.moved > MOVE_MS &&
				this.#saturated(held.shard)
			) {
				const to = this.#best(now, held.shard);
				const busy = this.#busy(now);
				if (
					to !== held.shard &&
					!this.#saturated(to) &&
					// shard 0 is also the thread that relays every other shard's packets:
					// a group alone there goes too
					busy[to] < busy[held.shard] + (held.shard === 0 ? 1 : 0)
				) {
					if (transportLog.on)
						logTransport(
							`${this.#named(group)} moves from transport shard ${held.shard + 1} to ${to + 1}`,
						);
					held.shard = to;
					held.moved = now;
				}
			}
			return held;
		}
		const best = this.#best(now);
		const placed: Placed = {
			shard: best,
			used: now,
			flying: 0,
			bodies: 0,
			since: 0,
			moved: 0,
		};
		this.#groups.set(group, placed);
		if (this.#groups.size > GROUPS_KEPT)
			this.#groups.delete(this.#groups.keys().next().value!);
		if (transportLog.on)
			logTransport(
				`${this.#named(group)} runs on transport shard ${best + 1} of ${this.#plan.count}`,
			);
		return placed;
	}

	#named(group: string): string {
		const at = group.indexOf('\n');
		return `${group.slice(at + 1)}${at === 0 ? '' : `; partition ${group.slice(0, at)}`}`;
	}

	/** the running shard a group goes to now (`from`: the one it leaves, its busy group not counted) */
	#best(now: number, from = -1): number {
		const running = this.#meters
			.map((_, index) => index)
			.filter((index) => this.#running(index));
		if (running.length === 1) return 0;
		const busy = this.#busy(now);
		if (from >= 0 && busy[from] > 0) busy[from]--;
		const saturated = running.map((index) => (this.#saturated(index) ? 1 : 0));
		const carried = this.#meters.map((meter) =>
			Math.floor(meter.value / BUSY_STEP),
		);
		const inFlight = this.#meters.map(() => 0);
		const justUsed = this.#meters.map(() => 0);
		const lately = this.#meters.map(() => 0);
		for (const { shard, used, flying } of this.#groups.values()) {
			inFlight[shard] += flying;
			if (now - used < JUST_MS) justUsed[shard]++;
			if (now - used < LATELY_MS) lately[shard]++;
		}
		// the first of these that differs decides
		// shard 0's thread relays the other shards' packets: while they run,
		// it is the last place for a group
		const relays = running.map((index) => (index === 0 ? 1 : 0));
		const order = (a: number, b: number) =>
			relays[a] - relays[b] ||
			saturated[a] - saturated[b] ||
			busy[running[a]] - busy[running[b]] ||
			inFlight[running[a]] - inFlight[running[b]] ||
			justUsed[running[a]] - justUsed[running[b]] ||
			carried[running[a]] - carried[running[b]] ||
			lately[running[a]] - lately[running[b]];
		let best = 0;
		for (let i = 1; i < running.length; i++) if (order(i, best) < 0) best = i;
		return running[best];
	}

	/** `group` placed, its shard ready, and held until `done` */
	async #take(group: string): Promise<Ticket> {
		if (!this.ready) await this.init();
		const placed = this.#shardOf(group);
		const remote = placed.shard === 0 ? null : this.#remotes[placed.shard];
		placed.flying++;
		remote?.hold();
		let settled = false;
		const ticket: Ticket = {
			placed,
			remote,
			done: () => {
				if (settled) return;
				settled = true;
				placed.flying--;
				placed.used = Date.now();
				remote?.release(() => this.#close(remote.index));
			},
		};
		if (remote)
			try {
				await remote.ready;
			} catch (error) {
				ticket.done();
				throw error;
			}
		return ticket;
	}

	/** a body of `ticket`'s group being read, until `done` */
	#reading(ticket: Ticket): () => void {
		const { placed } = ticket;
		if (placed.bodies++ === 0) {
			placed.since = Date.now();
			// busy from then on, if it is still being read: maybe time for a shard
			setTimeout(() => {
				if (placed.bodies > 0) this.#grow();
			}, BUSY_MS + 10);
		}
		let settled = false;
		return () => {
			if (settled) return;
			settled = true;
			placed.bodies--;
			ticket.done();
		};
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		const ticket = await this.#take(
			groupOf(remote.protocol, remote.host, headers),
		);
		try {
			if (!ticket.remote) {
				const response = await this.#local.request(
					remote,
					method,
					body,
					headers,
					signal,
				);
				if (!(response.body instanceof ReadableStream)) {
					ticket.done();
					return response;
				}
				return {
					...response,
					body: watched(
						response.body as ReadableStream<Uint8Array>,
						this.#reading(ticket),
					),
				};
			}
			const sent = crossable(body);
			const response = await ticket.remote.call(
				'request',
				{
					instance: this.#instance,
					remote: remote.href,
					method,
					body: sent,
					headers,
				},
				transferablesOf(sent),
			);
			const { body: got, ...rest } = response;
			if (!isPortBody(got)) {
				ticket.done();
				return response as TransferrableResponse;
			}
			return {
				...rest,
				body: receiveBody(got, this.#reading(ticket)),
			} as TransferrableResponse;
		} catch (error) {
			ticket.done();
			throw error;
		}
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void,
	): [
		(data: WebSocketDataType) => void,
		(code: number, reason: string) => void,
	] {
		const scheme =
			url.protocol === 'wss:'
				? 'https:'
				: url.protocol === 'ws:'
					? 'http:'
					: url.protocol;
		type Calls = ReturnType<ProxyTransport['connect']>;
		// what the page says before the socket is placed waits for it
		let calls: Calls | null = null;
		let closed: [number, string] | null = null;
		const early: WebSocketDataType[] = [];
		void this.#take(groupOf(scheme, url.host)).then(
			(ticket) => {
				const closes = (code: number, reason: string) => {
					ticket.done();
					onclose(code, reason);
				};
				const fails = (error: string) => {
					ticket.done();
					onerror(error);
				};
				calls = ticket.remote
					? this.#remoteSocket(
							ticket.remote,
							url,
							protocols,
							requestHeaders,
							onopen,
							onmessage,
							closes,
							fails,
						)
					: this.#local.connect(
							url,
							protocols,
							requestHeaders,
							onopen,
							onmessage,
							closes,
							fails,
						);
				for (const data of early.splice(0)) calls[0](data);
				if (closed) calls[1](...closed);
			},
			(error) => onerror(errorText(error)),
		);
		return [
			(data) => {
				if (calls) calls[0](data);
				else early.push(data);
			},
			(code, reason) => {
				if (calls) calls[1](code, reason);
				else closed = [code, reason];
			},
		];
	}

	/** a WebSocket on a shard's worker */
	#remoteSocket(
		remote: Remote,
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void,
	): ReturnType<ProxyTransport['connect']> {
		const { port1: port, port2: theirs } = new MessageChannel();
		// frames come on their own port and can overtake the connect's answer
		let opened = false;
		const pending: ShardSocketMessage[] = [];
		const deliver = (message: ShardSocketMessage) => {
			if (message.type === 'data') onmessage(message.data);
			else if (message.type === 'close') onclose(message.code, message.reason);
			else onerror(message.error);
		};
		port.onmessage = ({ data }: MessageEvent<ShardSocketMessage>) => {
			if (opened) deliver(data);
			else pending.push(data);
		};
		remote
			.call(
				'connect',
				{
					instance: this.#instance,
					url: url.href,
					protocols,
					requestHeaders,
					port: theirs,
				},
				[theirs],
			)
			.then(
				(result) => {
					if (result.result === 'success') {
						onopen(result.protocol, result.extensions);
						opened = true;
						for (const message of pending.splice(0)) deliver(message);
					} else onerror(result.error);
				},
				(error) => onerror(errorText(error)),
			);
		return [
			(data) =>
				port.postMessage(
					{ type: 'data', data } satisfies ShardSocketMessage,
					transferablesOf(data),
				),
			(code, reason) =>
				port.postMessage({
					type: 'close',
					code,
					reason,
				} satisfies ShardSocketMessage),
		];
	}

	/** epoxy's connect_udp, connect_tcp or connect_tls, on the shard of its host and port */
	async #raw(kind: RawKind, url: string): Promise<RawStream> {
		const ticket = await this.#take(groupOf(`${kind}:`, new URL(url).host));
		if (!ticket.remote) {
			try {
				const client = (this.#local as { client?: RawClient }).client;
				const connect = client?.[`connect_${kind}`];
				if (typeof connect !== 'function')
					throw new Error(`no ${kind.toUpperCase()} on this transport`);
				return await Reflect.apply(connect, client, [url]);
			} finally {
				ticket.done();
			}
		}
		const { port1, port2 } = new MessageChannel();
		let facts: ShardBound['raw'][1];
		try {
			facts = await ticket.remote.call(
				'raw',
				{ instance: this.#instance, kind, url, port: port2 },
				[port2],
			);
		} catch (error) {
			port1.close();
			ticket.done();
			throw error;
		}
		return rawOverPort(port1, facts, ticket.done);
	}
}
