import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';
import { poolHost } from './carrierClient';
import { NETWORK_PARTITION } from './networkPartition';
import { REQUEST_QUEUE } from './requestQueue';
import { changedResponse } from './responseFacts';
import { connectionLine, logTransport, transportLog } from './transportLog';

// Chrome's connection limits toward a server, which the transport keeps as
// Chrome's socket pool does (measured in Chrome 157, connection-limits
// suite): a group is a scheme, host and port in a network partition, for
// requests with credentials or without; an HTTP/1 group has at most six
// requests in flight, all groups together 256, and the rest wait, the most
// urgent first and in the order they came within an urgency. An HTTP/2 or
// HTTP/3 group's requests all go at once, as streams of its one connection
// (the server's stream limit holds them there, as in Chrome). A group goes
// six at a time until a response says which: as Chrome does for a server
// it knows nothing of. Before, epoxy opened a connection per request in
// flight: 100 fetches at once opened 100 connections where Chrome opened 6.
// WebSockets have limits of their own: one handshake at a time to a host
// and port (RFC 6455 4.1, Chrome's endpoint lock), and 255 sockets open or
// opening at once, past which a new one fails.
//
// Chrome keeps one pool per profile: two tabs of a site share a group's six,
// every tab the 256, and a WebSocket endpoint's lock (the 255 WebSockets
// are a renderer process's: two tabs open 130 each). A realm that rides the carrier host
// (carrierClient.ts) asks the host's pool, the one every transport of the
// origin asks (HostedPool), and its own pool only while there is no host to
// ask: each tab's transport had its own limits, so nine tabs could have
// 2304 requests on the host's one wisp connection where Chrome has 256
// (and holyWisp refuses a session's streams past 2048). Each realm's epoxy
// still learns for itself whether a server multiplexes: it is its own
// HTTP/2 connection that takes the requests at once, and a realm that has
// not opened one yet goes six at a time until a response says so.

/** requests in flight to an HTTP/1 group */
export const PER_GROUP = 6;
/** HTTP/1 requests in flight to every group together */
export const TOTAL = 256;
/** WebSockets open or opening */
export const WEBSOCKETS = 255;
/** groups remembered (whether they multiplex); idle ones past it are forgotten */
const GROUPS_KEPT = 1024;

interface Group {
	/** HTTP/2 or HTTP/3, as its last response said (to this realm's epoxy) */
	multiplexed: boolean;
	/** this realm's requests in flight that count against the group's limit */
	active: number;
	/** the group's count across realms (the host's pool), or this realm's alone */
	limit: { active: number };
	/**
	 * The verbose log (transportLog.ts): the group's origin, partition and
	 * credentials, the version its connection was logged with, the HTTP/1
	 * connections it has open as the pool counts them (the most requests it
	 * had in flight since it was last idle long), and since when nothing is
	 * in flight
	 */
	origin: string;
	partition: string;
	credentials: string;
	logged?: string;
	opened: number;
	idleSince: number;
}

/**
 * How long epoxy's pool keeps an idle HTTP/1 connection (Chrome 157's time
 * for a used HTTP/1 socket, epoxy-tls 0081): a group idle that long opens a
 * new one, which the verbose log tells. An idle HTTP/2 connection is kept
 * until its server closes it, as Chrome keeps one.
 */
const IDLE_MS = 300 * 1000;

/** ms since the epoch, comparable across the worker's realm and this one */
const now = () => performance.timeOrigin + performance.now();

interface Waiting {
	group: Group;
	urgency: number;
	/** the worker's name for it (REQUEST_QUEUE), for a raise or a cancel */
	id: string;
	/**
	 * when the browser asked for it (ms since the epoch): of the same
	 * urgency, the first asked goes first, as Chrome's queue does, whatever
	 * order the worker's work on each brought them here in
	 */
	asked: number;
	/** true: counted against the limits; `nth`, the connection more it takes (#count's) */
	start: (started: [counted: boolean, nth: number]) => void;
	/** given up while it waited */
	cancel: () => void;
}

const CANCELLED = 'Stomp: request cancelled while it waited for a connection';

/** a request the page gave up on while it waited for a connection: it never goes out */
export class QueuedCancel extends Error {
	constructor() {
		super(CANCELLED);
	}
}

/** what the pool takes of a request: its group and its place in line (REQUEST_QUEUE) */
export interface PoolFields {
	/** scheme, host and port */
	origin: string;
	partition: string;
	credentials: string;
	urgency: number;
	/** the worker's name for it, for a raise or a cancel ('' for none) */
	id: string;
	/** when the browser asked for it (ms since the epoch) */
	asked: number;
	image: boolean;
}

/** the verbose log's connection line, but for the transport it names */
export type PoolLine = [
	version: string | undefined,
	origin: string,
	partition: string,
	credentials: string,
	nth: number,
];

/** what the pool gave a request, as the realm that asked holds it */
export interface Held {
	/** it counts against the limits (an HTTP/1 request, or one to a server not known yet) */
	counted: boolean;
	/**
	 * The response came over `version`: the group learns whether it
	 * multiplexes, and `line` hears the verbose log's line when there is
	 * one to tell. True: it holds its connection until its body ends.
	 */
	learn(version: string | undefined, line?: (line: PoolLine) => void): boolean;
	/** it lets its connection go (its body ended, or it failed) */
	release(): void;
}

/** the pool's fields of a request to `url` with `headers` (see SocketPool.take) */
export function fieldsOf(url: URL, headers: RawHeaders): PoolFields {
	const fields: PoolFields = {
		origin: `${url.protocol}//${url.host}`,
		partition: '',
		credentials: 'credentialed',
		urgency: 1,
		id: '',
		asked: now(),
		image: false,
	};
	if (Array.isArray(headers))
		for (const [name, value] of headers) {
			const lower = name.toLowerCase();
			if (lower === REQUEST_QUEUE) {
				const [u, c, named, at, kind] = value.split(' ');
				fields.urgency = Number(u) || 0;
				fields.credentials = c ?? fields.credentials;
				fields.id = named ?? '';
				fields.asked = Number(at) || fields.asked;
				fields.image = kind === 'image';
			} else if (lower === NETWORK_PARTITION) fields.partition = value;
		}
	return fields;
}

/** cancels and raises that came before their request, kept for it (they cross apart) */
const EARLY_KEPT = 256;

/** what a request holds while it is in flight */
export interface Ticket {
	/** the response came: learns the group's protocol, releases at the body's end */
	answered(response: TransferrableResponse): TransferrableResponse;
	/** the request failed */
	failed(): void;
}

/**
 * Whether `transport` says which HTTP version each response came over
 * (fieldSupport.httpVersion: our epoxy build). Only then are its requests
 * queued: a transport that does not would have every HTTP/2 server held to
 * six requests at a time.
 */
export const reportsVersion = (transport: ProxyTransport) =>
	!!(transport as { fieldSupport?: { httpVersion?: boolean } }).fieldSupport
		?.httpVersion;

const MULTIPLEXED = new Set(['2', '3']);

/** `body`, calling `done` once when it ends, fails or is cancelled */
export function untilDone(
	body: ReadableStream<Uint8Array>,
	done: () => void,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				let read: ReadableStreamReadResult<Uint8Array>;
				try {
					read = await reader.read();
				} catch (error) {
					done();
					controller.error(error);
					return;
				}
				if (read.done) {
					done();
					controller.close();
				} else controller.enqueue(read.value);
			},
			cancel(reason) {
				done();
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

/** the HTTP connections of one transport, or of every realm the host serves, as Chrome's socket pool keeps them */
export class SocketPool {
	/** the transport whose pool it is, for the verbose log's lines */
	#transport: ProxyTransport | null;
	/** by realm, then group */
	#groups = new Map<string, Group>();
	/** each group's count across realms */
	#limits = new Map<string, { active: number }>();
	/** by urgency, then the order they came in */
	#waiting: Waiting[] = [];
	#active = 0;
	#early = new Set<string>();
	#raised = new Map<string, number>();
	/** by the worker's name, how each request in flight lets its connection go */
	#flying = new Map<string, () => void>();

	constructor(transport: ProxyTransport | null = null) {
		this.#transport = transport;
	}

	/**
	 * Wait for a connection for a request to `url` with `headers` (the
	 * worker's REQUEST_QUEUE and NETWORK_PARTITION fields name its urgency,
	 * credentials and partition; a request without them is a credentialed
	 * one of urgency 1, a fetch's). `waits` hears the worker's name for an
	 * image's request that has to wait.
	 */
	async take(
		url: URL,
		headers: RawHeaders,
		waits?: (id: string) => void,
	): Promise<Ticket> {
		return this.ticketOf(await this.hold(fieldsOf(url, headers), waits));
	}

	/** a Ticket of what `held` holds, for a response of this pool's transport */
	ticketOf(held: Held): Ticket {
		return heldTicket(held, lineOf(this.#transport));
	}

	/**
	 * Wait for a connection for the request `fields` names, of `realm` (the
	 * host's name for the realm that asked; '' for this one): each realm's
	 * groups learn for themselves whether they multiplex, and count against
	 * the same limits
	 */
	async hold(
		fields: PoolFields,
		waits?: (id: string) => void,
		realm = '',
	): Promise<Held> {
		let { urgency } = fields;
		const { id, asked, image, origin, partition, credentials } = fields;
		if (id && this.#early.delete(id)) throw new QueuedCancel();
		const raised = id ? this.#raised.get(id) : undefined;
		if (raised !== undefined) {
			this.#raised.delete(id);
			urgency = Math.min(urgency, raised);
		}
		const shared = `${partition}\n${origin}\n${credentials}`;
		const key = `${realm}\n${shared}`;
		let group = this.#groups.get(key);
		if (!group) {
			if (this.#groups.size >= GROUPS_KEPT) this.#forget();
			let limit = this.#limits.get(shared);
			if (!limit) {
				limit = { active: 0 };
				this.#limits.set(shared, limit);
			}
			group = {
				multiplexed: false,
				active: 0,
				limit,
				origin,
				partition,
				credentials,
				opened: 0,
				idleSince: now(),
			};
			this.#groups.set(key, group);
		}
		if (group.multiplexed) return this.#held(group, false, 0);
		if (this.#startable(group))
			return this.#held(group, true, this.#count(group), id);
		// it waits its turn; whoever starts it counts it (or not, when its
		// group turned out to multiplex while it waited)
		if (image && id) waits?.(id);
		const [counted, nth] = await new Promise<[boolean, number]>(
			(start, reject) =>
				this.#wait({
					group: group!,
					urgency,
					id,
					asked,
					start,
					cancel: () => reject(new QueuedCancel()),
				}),
		);
		const held = this.#held(group, counted, nth, id);
		// given up between its start and here
		if (id && this.#early.delete(id)) {
			this.#flying.get(id)?.();
			throw new QueuedCancel();
		}
		return held;
	}

	/** the groups nothing is in flight or waiting for, forgotten */
	#forget() {
		const busy = new Set(this.#waiting.map((waiting) => waiting.group.limit));
		for (const [key, group] of this.#groups)
			if (!group.limit.active && !busy.has(group.limit)) {
				this.#groups.delete(key);
				this.#limits.delete(key.slice(key.indexOf('\n') + 1));
			}
	}

	/** in line behind every request as urgent or more */
	#wait(waiting: Waiting) {
		let at = this.#waiting.length;
		const behind = (other: Waiting) =>
			other.urgency > waiting.urgency ||
			(other.urgency === waiting.urgency && other.asked > waiting.asked);
		while (at > 0 && behind(this.#waiting[at - 1])) at--;
		this.#waiting.splice(at, 0, waiting);
	}

	/**
	 * The page gave the request `id` up (or its document went): if it still
	 * waits, it leaves the line and never goes out, as Chrome drops a
	 * cancelled request from its socket pool's queue. One that already went
	 * lets its connection go to the next in line now, as Chrome closes the
	 * socket of a request it cancels: a request whose server never answers
	 * held one of its six until the server did. (The transport cannot stop
	 * it; the worker drops its answer.)
	 */
	cancel(id: string) {
		const flying = this.#flying.get(id);
		if (flying) return flying();
		const at = this.#waiting.findIndex((waiting) => waiting.id === id);
		if (at < 0) {
			// it may not have reached the line yet
			if (this.#early.size >= EARLY_KEPT) this.#early.clear();
			this.#early.add(id);
			return;
		}
		const [waiting] = this.#waiting.splice(at, 1);
		waiting.cancel();
	}

	/**
	 * The page laid the image `id` out in its viewport: if it still waits, it
	 * waits at `urgency` from now on (behind those already there), as Chrome
	 * raises an image in the viewport to a fetch's urgency once laid out.
	 */
	raise(id: string, urgency: number) {
		const at = this.#waiting.findIndex((waiting) => waiting.id === id);
		if (at < 0) {
			// it may not have reached the line yet
			if (this.#raised.size >= EARLY_KEPT) this.#raised.clear();
			this.#raised.set(id, urgency);
			return;
		}
		if (this.#waiting[at].urgency <= urgency) return;
		const [waiting] = this.#waiting.splice(at, 1);
		waiting.urgency = urgency;
		waiting.asked = now();
		this.#wait(waiting);
	}

	#startable(group: Group) {
		return group.limit.active < PER_GROUP && this.#active < TOTAL;
	}

	/**
	 * Counts a request in; when it takes a connection more than the realm's
	 * group had open, that connection's number (the verbose log's), else 0
	 */
	#count(group: Group): number {
		if (!group.active && now() - group.idleSince >= IDLE_MS) {
			group.opened = 0;
			group.logged = undefined;
		}
		group.active++;
		group.limit.active++;
		this.#active++;
		if (group.active <= group.opened) return 0;
		group.opened = group.active;
		return group.opened;
	}

	/** the verbose log's line for a connection of `group` that `version` answered on */
	#line(
		group: Group,
		version: string | undefined,
		nth: number,
		line: (line: PoolLine) => void,
	) {
		// an HTTP/3 connection is Http3Transport's to tell, at its handshake
		if (version === '3') return;
		const multiplexed = !!version && MULTIPLEXED.has(version);
		// (its requests are not counted, and its connection is kept idle)
		if (multiplexed) group.idleSince = now();
		if (multiplexed ? group.logged === version : !nth) return;
		group.logged = version;
		line([
			version,
			group.origin,
			group.partition,
			group.credentials,
			multiplexed ? 1 : nth,
		]);
	}

	#held(group: Group, counted: boolean, nth: number, id = ''): Held {
		let held = counted;
		const release = () => {
			if (!held) return;
			held = false;
			if (id) this.#flying.delete(id);
			group.active--;
			group.limit.active--;
			this.#active--;
			if (!group.active) group.idleSince = now();
			this.#pump();
		};
		if (held && id) this.#flying.set(id, release);
		return {
			counted,
			learn: (version, line) => {
				if (line) this.#line(group, version, nth, line);
				if (version) {
					const multiplexed = MULTIPLEXED.has(version);
					if (multiplexed !== group.multiplexed) {
						group.multiplexed = multiplexed;
						// what waits for it goes now, as streams of the connection
						if (multiplexed) this.#pump();
					}
				}
				return held && !group.multiplexed;
			},
			release,
		};
	}

	/** start what may start now, the most urgent first */
	#pump() {
		for (let i = 0; i < this.#waiting.length;) {
			const waiting = this.#waiting[i];
			if (waiting.group.multiplexed) {
				this.#waiting.splice(i, 1);
				waiting.start([false, 0]);
			} else if (this.#startable(waiting.group)) {
				this.#waiting.splice(i, 1);
				waiting.start([true, this.#count(waiting.group)]);
			} else i++;
		}
	}
}

/** the verbose log's line of a connection of `transport` */
const lineOf = (transport: ProxyTransport | null) =>
	transport
		? (line: PoolLine) => logTransport(connectionLine(transport, ...line))
		: undefined;

/** the version a response says it came over, if it says */
function versionOf(response: TransferrableResponse) {
	const version = (response as { httpVersion?: unknown }).httpVersion;
	return typeof version === 'string' && version ? version : undefined;
}

/**
 * A Ticket of `held`: the response's version learnt (`line` telling the
 * verbose log's line while the log is on), and its connection let go at
 * once or at its body's end
 */
function heldTicket(held: Held, line?: (line: PoolLine) => void): Ticket {
	return {
		answered: (response) => {
			const holds = held.learn(
				versionOf(response),
				transportLog.on ? line : undefined,
			);
			if (holds && response.body instanceof ReadableStream)
				return changedResponse(response, {
					body: untilDone(
						response.body as ReadableStream<Uint8Array>,
						held.release,
					),
				});
			held.release();
			return response;
		},
		failed: held.release,
	};
}

/** what a WebSocket holds from the gate */
export interface SocketPass {
	/** the handshake ended (open or failed): the next one to its host and port may start */
	connected(): void;
	/** the socket is gone */
	closed(): void;
}

/** the host and port of a WebSocket to `url`, whose handshakes go one at a time */
export const endpointOf = (url: URL) =>
	`${url.hostname}:${url.port || (url.protocol === 'wss:' ? 443 : 80)}`;

/** the WebSockets of one transport, or of every realm the host serves, as Chrome limits them */
export class WebSocketGate {
	#open = 0;
	/** by host and port, the handshake the next one waits for */
	#locks = new Map<string, Promise<void>>();

	/** `limit`: the sockets open or opening at once, past which a new one fails */
	constructor(readonly limit = WEBSOCKETS) {}

	/** wait for a handshake to `url` to be allowed; null: too many sockets (it fails) */
	admit(url: URL): Promise<SocketPass | null> {
		return this.admitTo(endpointOf(url));
	}

	/** wait for a handshake to the host and port `key` to be allowed; null: too many sockets */
	async admitTo(key: string): Promise<SocketPass | null> {
		if (this.#open >= this.limit) return null;
		this.#open++;
		const before = this.#locks.get(key);
		let unlock!: () => void;
		const mine = new Promise<void>((resolve) => (unlock = resolve));
		this.#locks.set(key, mine);
		if (before) await before;
		let connected = false;
		let closed = false;
		return {
			connected: () => {
				if (connected) return;
				connected = true;
				if (this.#locks.get(key) === mine) this.#locks.delete(key);
				unlock();
			},
			closed: () => {
				if (closed) return;
				closed = true;
				this.#open--;
			},
		};
	}
}

/**
 * A transport's requests while its realm can ask the carrier host's pool
 * (carrierClient.ts PoolHost), and its own pool's when it cannot (no host,
 * or the host went while it asked)
 */
class HostedPool {
	constructor(
		readonly local: SocketPool,
		readonly transport: ProxyTransport,
	) {}

	async take(
		url: URL,
		headers: RawHeaders,
		waits?: (id: string) => void,
	): Promise<Ticket> {
		const host = poolHost();
		if (!host) return this.local.take(url, headers, waits);
		let held: Held | null;
		try {
			held = await host.hold(fieldsOf(url, headers), waits);
		} catch (error) {
			if ((error as Error)?.message === CANCELLED) throw new QueuedCancel();
			held = null;
		}
		if (!held) return this.local.take(url, headers, waits);
		return heldTicket(held, lineOf(this.transport));
	}

	/** (a request is in one of the two, the other keeps the word for a while and drops it) */
	cancel(id: string) {
		poolHost()?.requeue(id, null);
		this.local.cancel(id);
	}

	raise(id: string, urgency: number) {
		poolHost()?.requeue(id, urgency);
		this.local.raise(id, urgency);
	}
}

/** the same for WebSockets */
class HostedGate {
	constructor(readonly local: WebSocketGate) {}

	/**
	 * The 255 are the realm's (Chrome counts a renderer process's: two
	 * tabs open 130 each), and the endpoint lock is the profile's, so the
	 * host's: two tabs' handshakes to a host go one at a time
	 */
	async admit(url: URL): Promise<SocketPass | null> {
		const key = endpointOf(url);
		const mine = await this.local.admitTo(key);
		if (!mine) return null;
		const shared = await poolHost()?.admit(key);
		if (!shared) return mine;
		return {
			connected: () => {
				mine.connected();
				shared.connected();
			},
			closed: () => {
				mine.closed();
				shared.closed();
			},
		};
	}
}

/** the pool and gate a transport's requests and WebSockets ask */
export interface TransportPool {
	http: Pick<SocketPool, 'take' | 'cancel' | 'raise'>;
	ws: Pick<WebSocketGate, 'admit'>;
}

const pools = new WeakMap<object, TransportPool>();

/**
 * The pool and WebSocket gate of `transport` (one each, whichever port
 * serves it): the carrier host's, every realm of the origin's, while this
 * realm has a host to ask
 */
export function poolOf(transport: ProxyTransport): TransportPool {
	let pool = pools.get(transport);
	if (!pool) {
		pool = {
			http: new HostedPool(new SocketPool(transport), transport),
			ws: new HostedGate(new WebSocketGate()),
		};
		pools.set(transport, pool);
	}
	return pool;
}
