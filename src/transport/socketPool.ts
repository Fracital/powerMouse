import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';
import { NETWORK_PARTITION } from './networkPartition';
import { REQUEST_QUEUE } from './requestQueue';

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
}

interface Waiting {
	group: Group;
	urgency: number;
	/** true: counted against the limits */
	start: (counted: boolean) => void;
}

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
	#groups = new Map<string, Group>();
	/** by urgency, then the order they came in */
	#waiting: Waiting[] = [];
	#active = 0;

	/**
	 * Wait for a connection for a request to `url` with `headers` (the
	 * worker's REQUEST_QUEUE and NETWORK_PARTITION fields name its urgency,
	 * credentials and partition; a request without them is a credentialed
	 * one of urgency 1, a fetch's).
	 */
	async take(url: URL, headers: RawHeaders): Promise<Ticket> {
		let urgency = 1;
		let credentials = 'credentialed';
		let partition = '';
		if (Array.isArray(headers))
			for (const [name, value] of headers) {
				const lower = name.toLowerCase();
				if (lower === REQUEST_QUEUE) {
					const [u, c] = value.split(' ');
					urgency = Number(u) || 0;
					credentials = c ?? credentials;
				} else if (lower === NETWORK_PARTITION) partition = value;
			}
		const key = `${partition}\n${url.protocol}//${url.host}\n${credentials}`;
		let group = this.#groups.get(key);
		if (!group) {
			if (this.#groups.size >= GROUPS_KEPT)
				for (const [other, kept] of this.#groups)
					if (!kept.active && !this.#waiting.some((w) => w.group === kept))
						this.#groups.delete(other);
			group = { multiplexed: false, active: 0 };
			this.#groups.set(key, group);
		}
		if (group.multiplexed) return this.#ticket(group, false);
		if (this.#startable(group)) {
			this.#count(group);
			return this.#ticket(group, true);
		}
		// it waits its turn; whoever starts it counts it (or not, when its
		// group turned out to multiplex while it waited)
		const counted = await new Promise<boolean>((start) => {
			let at = this.#waiting.length;
			while (at > 0 && this.#waiting[at - 1].urgency > urgency) at--;
			this.#waiting.splice(at, 0, { group: group!, urgency, start });
		});
		return this.#ticket(group, counted);
	}

	#startable(group: Group) {
		return group.active < PER_GROUP && this.#active < TOTAL;
	}

	#count(group: Group) {
		group.active++;
		this.#active++;
	}

	#ticket(group: Group, counted: boolean): Ticket {
		let held = counted;
		const release = () => {
			if (!held) return;
			held = false;
			group.active--;
			this.#active--;
			this.#pump();
		};
		return {
			answered: (response) => {
				const version = (response as { httpVersion?: unknown }).httpVersion;
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
				waiting.start(false);
			} else if (this.#startable(waiting.group)) {
				this.#waiting.splice(i, 1);
				this.#count(waiting.group);
				waiting.start(true);
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
		pool = { http: new SocketPool(), ws: new WebSocketGate() };
		pools.set(transport, pool);
	}
	return pool;
}
