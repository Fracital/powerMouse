import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';
import { NETWORK_PARTITION } from './networkPartition';
import { REQUEST_QUEUE } from './requestQueue';
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

/** requests in flight to an HTTP/1 group */
export const PER_GROUP = 6;
/** HTTP/1 requests in flight to every group together */
export const TOTAL = 256;
/** WebSockets open or opening */
export const WEBSOCKETS = 255;
/** groups remembered (whether they multiplex); idle ones past it are forgotten */
const GROUPS_KEPT = 1024;

interface Group {
	/** HTTP/2 or HTTP/3, as its last response said */
	multiplexed: boolean;
	/** requests in flight that count against its limit */
	active: number;
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
 * How long epoxy's pool keeps an idle connection (hyper-util's default):
 * a group idle that long opens a new one, which the verbose log tells
 */
const IDLE_MS = 90 * 1000;

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

/** a request the page gave up on while it waited for a connection: it never goes out */
export class QueuedCancel extends Error {
	constructor() {
		super('Stomp: request cancelled while it waited for a connection');
	}
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
function untilDone(
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

/** the HTTP connections of one transport, as Chrome's socket pool keeps them */
export class SocketPool {
	/** the transport whose pool it is, for the verbose log's lines */
	#transport: ProxyTransport | null;
	#groups = new Map<string, Group>();
	/** by urgency, then the order they came in */
	#waiting: Waiting[] = [];
	#active = 0;
	#early = new Set<string>();
	#raised = new Map<string, number>();

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
		let urgency = 1;
		let credentials = 'credentialed';
		let partition = '';
		let id = '';
		let asked = now();
		let image = false;
		if (Array.isArray(headers))
			for (const [name, value] of headers) {
				const lower = name.toLowerCase();
				if (lower === REQUEST_QUEUE) {
					const [u, c, named, at, kind] = value.split(' ');
					urgency = Number(u) || 0;
					credentials = c ?? credentials;
					id = named ?? '';
					asked = Number(at) || asked;
					image = kind === 'image';
				} else if (lower === NETWORK_PARTITION) partition = value;
			}
		if (id && this.#early.delete(id)) throw new QueuedCancel();
		const raised = id ? this.#raised.get(id) : undefined;
		if (raised !== undefined) {
			this.#raised.delete(id);
			urgency = Math.min(urgency, raised);
		}
		const key = `${partition}\n${url.protocol}//${url.host}\n${credentials}`;
		let group = this.#groups.get(key);
		if (!group) {
			if (this.#groups.size >= GROUPS_KEPT)
				for (const [other, kept] of this.#groups)
					if (!kept.active && !this.#waiting.some((w) => w.group === kept))
						this.#groups.delete(other);
			group = {
				multiplexed: false,
				active: 0,
				origin: `${url.protocol}//${url.host}`,
				partition,
				credentials,
				opened: 0,
				idleSince: now(),
			};
			this.#groups.set(key, group);
		}
		if (group.multiplexed) return this.#ticket(group, false, 0);
		if (this.#startable(group))
			return this.#ticket(group, true, this.#count(group));
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
		return this.#ticket(group, counted, nth);
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
	 * The page gave the request `id` up: if it still waits, it leaves the
	 * line and never goes out, as Chrome drops a cancelled request from its
	 * socket pool's queue. One that already went is left to finish (the
	 * worker drops its answer).
	 */
	cancel(id: string) {
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
		return group.active < PER_GROUP && this.#active < TOTAL;
	}

	/**
	 * Counts a request in; when it takes a connection more than the group
	 * had open, that connection's number (the verbose log's), else 0
	 */
	#count(group: Group): number {
		if (!group.active && now() - group.idleSince >= IDLE_MS) {
			group.opened = 0;
			group.logged = undefined;
		}
		group.active++;
		this.#active++;
		if (group.active <= group.opened) return 0;
		group.opened = group.active;
		return group.opened;
	}

	/** the verbose log's line for a connection of `group` that `version` answered on */
	#log(group: Group, version: string | undefined, nth: number) {
		// an HTTP/3 connection is Http3Transport's to tell, at its handshake
		if (!this.#transport || version === '3') return;
		const multiplexed = !!version && MULTIPLEXED.has(version);
		if (multiplexed) {
			// its requests are not counted: idle is since its last answer
			if (now() - group.idleSince >= IDLE_MS) group.logged = undefined;
			group.idleSince = now();
		}
		if (multiplexed ? group.logged === version : !nth) return;
		group.logged = version;
		logTransport(
			connectionLine(
				this.#transport,
				version,
				group.origin,
				group.partition,
				group.credentials,
				multiplexed ? 1 : nth,
			),
		);
	}

	#ticket(group: Group, counted: boolean, nth: number): Ticket {
		let held = counted;
		const release = () => {
			if (!held) return;
			held = false;
			group.active--;
			this.#active--;
			if (!group.active) group.idleSince = now();
			this.#pump();
		};
		return {
			answered: (response) => {
				const version = (response as { httpVersion?: unknown }).httpVersion;
				if (transportLog.on)
					this.#log(
						group,
						typeof version === 'string' && version ? version : undefined,
						nth,
					);
				if (typeof version === 'string' && version) {
					const multiplexed = MULTIPLEXED.has(version);
					if (multiplexed !== group.multiplexed) {
						group.multiplexed = multiplexed;
						// what waits for it goes now, as streams of the connection
						if (multiplexed) this.#pump();
					}
				}
				if (!held) return response;
				if (group.multiplexed) {
					release();
					return response;
				}
				if (response.body instanceof ReadableStream)
					return {
						...response,
						body: untilDone(
							response.body as ReadableStream<Uint8Array>,
							release,
						),
					};
				release();
				return response;
			},
			failed: release,
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

/** what a WebSocket holds from the gate */
export interface SocketPass {
	/** the handshake ended (open or failed): the next one to its host and port may start */
	connected(): void;
	/** the socket is gone */
	closed(): void;
}

/** the WebSockets of one transport, as Chrome limits them */
export class WebSocketGate {
	#open = 0;
	/** by host and port, the handshake the next one waits for */
	#locks = new Map<string, Promise<void>>();

	/** wait for a handshake to `url` to be allowed; null: too many sockets (it fails) */
	async admit(url: URL): Promise<SocketPass | null> {
		if (this.#open >= WEBSOCKETS) return null;
		this.#open++;
		const key = `${url.hostname}:${url.port || (url.protocol === 'wss:' ? 443 : 80)}`;
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

const pools = new WeakMap<object, { http: SocketPool; ws: WebSocketGate }>();

/** the pool and WebSocket gate of `transport` (one each, whichever port serves it) */
export function poolOf(transport: ProxyTransport) {
	let pool = pools.get(transport);
	if (!pool) {
		pool = { http: new SocketPool(transport), ws: new WebSocketGate() };
		pools.set(transport, pool);
	}
	return pool;
}
