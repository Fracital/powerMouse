// A transport's side of the carrier host (carrierHost.ts): the host page
// starts the host, a SharedWorker of the transport worker's script that
// outlives a reload (`extendedLifetime`), and hands its port to where the
// transport runs (useCarrierHost); a CarrierTransport there asks it for a
// wisp connection (askCarrierHost) before it would open a carrier of its
// own. What it gets is a rider: the relay's wisp connection as this
// transport alone sees it, its own stream ids, over a MessagePort.
//
// Every message on a rider's port is one Wisp packet (an ArrayBuffer,
// transferred), the host's `{ end }` when the carrier ended under it
// (`lost`: without a close of the relay's), or the client's `end` when its
// epoxy let go. The control port carries the RPC and an `alive` each way
// every ALIVE_MS: a MessagePort says nothing when the realm at its other end
// is gone (Chrome 157 fires no `close`), and a Web Lock, which would, keeps
// the page out of the back/forward cache. A host not heard from is gone
// (its riders end as lost, and the next start opens a carrier of its own);
// a client not heard from has its riders let go.
import { bodiesTaken } from './bodyPort';
import { RpcHelper } from './rpc';
import type { Held, PoolFields, PoolLine, SocketPass } from './socketPool';
import { relayNote, type TransportNote } from './transportLog';
import type {
	Carrier,
	OpenCarrier,
	WispWebTransportOptions,
} from './wispWebTransport';

const sleep = (ms: number) =>
	new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));

/** the SharedWorker's name: the transport worker's script runs the host under it */
export const CARRIER_HOST_NAME = 'stomp-carrier';
export const CARRIER_HOST_RPC = 'stomp-carrier-host';
/** how often a client says it is alive on its control port */
export const ALIVE_MS = 2000;
/** a client (or the host) not heard from for this long is gone, and so are its riders */
export const GONE_MS = 4 * ALIVE_MS;
/**
 * the same for a transport in the page (`host: 'page'`), whose timers
 * Chrome runs once a minute in a tab hidden for five; a page that unloads
 * lets its riders go itself
 */
export const PAGE_GONE_MS = 150 * 1000;
/** how long a start waits for a host that has not answered yet */
export const READY_MS = 1500;
/** the message each side sends on the control port */
export const ALIVE = 'alive';
/** a page's transport's `alive` (PAGE_GONE_MS) */
export const PAGE_ALIVE = 'alive page';
/** the client's message on a rider's port: its epoxy let go */
export const END = 'end';
/** what a host posts a rider that takes credit past what it said it took, at most (bytes) */
export const RIDER_WINDOW = 4 * 1024 * 1024;
/** what a rider tells the host it took, at least, each time (bytes) */
const TOOK_STEP = 1024 * 1024;
/** DATA a rider hands epoxy ahead of what this realm's body readers took, at most, while they read */
const PACED_AHEAD = 16 * 1024 * 1024;
/** readers that took nothing for this long are not reading: nothing waits for them */
const PACED_QUIET_MS = 250;
const DATA = 0x02;
/** a page's message on the control port as it unloads: what it held of the host's pool goes */
export const LEFT = 'left';

/** what a transport asks the host for: a relay's wisp connection */
export interface CarrierAsk {
	wisp: string;
	/** what of epoxy's options the carrier is opened with */
	first: { wisp_v2?: boolean; wisp_ws_protocols?: string[] };
	/** null: the WebSocket only (the descriptor has no `webTransport`) */
	webTransport: WispWebTransportOptions | null;
	/** the rider says what it took (`{ took }`), and the host sends no more than RIDER_WINDOW past it */
	credit?: boolean;
}

/** what the host gives: a rider, or why there is none */
export interface CarrierGiven {
	/** the rider's port; null when no carrier could be opened */
	port: MessagePort | null;
	carrier?: Carrier;
	url?: string;
	/** on the WebSocket: why not WebTransport */
	why: string;
	/** how long the host took to open the carrier, when it opened it for this ask */
	ms: number;
	/** how long the carrier had been up when it was given (0: opened for this ask) */
	upMs: number;
	/** the riders on it, this one included */
	riders: number;
	/** the host takes the rider's `{ took }` (CarrierAsk.credit) */
	credit?: boolean;
}

/** a request the host's pool gave a connection: its name, and whether it counts */
export interface PoolTicket {
	ticket: number;
	counted: boolean;
}

/** a response came over `version`: what the host's pool learns of it */
export interface PoolLearn {
	ticket: number;
	version?: string;
	/** the realm's verbose log is on: the host answers the connection's line, if any */
	line: boolean;
	/** the realm holds its connection until its body ends (else the host lets it go now) */
	holds: boolean;
}

export type HostBound = {
	open: [CarrierAsk, CarrierGiven];
	/** the host's pool (socketPool.ts SocketPool.hold) */
	hold: [PoolFields, PoolTicket];
	learn: [PoolLearn, PoolLine | null];
	release: [number];
	/** a cancel (urgency null) or a raise of the request the worker named `id` */
	requeue: [{ id: string; urgency: number | null }];
	/** the host's WebSocket gate: the pass's name, or null for one too many */
	admit: [string, number | null];
	connected: [number];
	closed: [number];
};
export type ClientBound = {
	note: [TransportNote];
	/** the request the worker named so has to wait for a connection */
	waiting: [string];
};

/** what the host's pool reads as HTTP/2 or HTTP/3 (socketPool.ts) */
const MULTIPLEXED = new Set(['2', '3']);

/**
 * The carrier host's socket pool and WebSocket gate, as a realm asks them
 * (socketPool.ts HostedPool): one per profile in Chrome, so one for every
 * realm of the origin here
 */
export interface PoolHost {
	/** a connection for the request `fields` names; it throws when the host cannot answer */
	hold(fields: PoolFields, waits?: (id: string) => void): Promise<Held>;
	requeue(id: string, urgency: number | null): void;
	/** a WebSocket's pass to the host and port `key`; undefined: the host cannot answer */
	admit(key: string): Promise<SocketPass | null | undefined>;
}

interface HostLink {
	rpc: RpcHelper<ClientBound, HostBound>;
	/** while a request waits for the host's pool, who hears it waits (by its id) */
	waits: Map<string, (id: string) => void>;
	pool: PoolHost;
	/** settles true once the host was heard from */
	ready: Promise<boolean>;
	heard: number;
	/** a start waited READY_MS for it once, in vain: no start waits again */
	slow: boolean;
	/** this realm's riders: end each (`lost`: the host is gone) */
	riders: Set<(lost: boolean) => void>;
}

/** this realm's connection to the carrier host, once the controller handed it one */
let host: HostLink | null = null;

/**
 * Ask the carrier host on `port` (the host page's SharedWorker port) for
 * this realm's wisp connections from now on
 */
export function useCarrierHost(port: MessagePort) {
	// a realm has one (the host page's every port is to the same worker)
	if (host) {
		port.close();
		return;
	}
	const waits = new Map<string, (id: string) => void>();
	const rpc = new RpcHelper<ClientBound, HostBound>(
		{
			// the host's console notes, printed where this realm's are
			note: async (note) => relayNote(note),
			waiting: async (id) => waits.get(id)?.(id),
		},
		CARRIER_HOST_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	let heard!: (ok: boolean) => void;
	const link: HostLink = {
		rpc,
		waits,
		pool: hostedPool(rpc, waits),
		ready: new Promise((resolve) => (heard = resolve)),
		heard: 0,
		slow: false,
		riders: new Set(),
	};
	port.addEventListener('message', (event) => {
		link.heard = performance.now();
		heard(true);
		if (event.data !== ALIVE) rpc.receive(event.data);
	});
	port.start();
	const page = typeof window !== 'undefined';
	const alive = () => {
		try {
			port.postMessage(page ? PAGE_ALIVE : ALIVE);
		} catch {
			// the port is gone
		}
	};
	alive();
	let last = performance.now();
	const timer = setInterval(() => {
		alive();
		const now = performance.now();
		// a check that runs late (the realm was frozen, or its timers held)
		// judges nothing: the host's messages may be waiting to be delivered
		const onTime = now - last < 2 * ALIVE_MS;
		last = now;
		if (!onTime || !link.heard || now - link.heard < GONE_MS) return;
		clearInterval(timer);
		if (host === link) host = null;
		rpc.abort('the carrier host is gone');
		for (const end of [...link.riders]) end(true);
	}, ALIVE_MS);
	// a page that unloads lets its riders go at once, and what it holds of
	// the host's pool
	if (page)
		addEventListener('pagehide', (event) => {
			if ((event as PageTransitionEvent).persisted) return;
			for (const end of [...link.riders]) end(false);
			try {
				port.postMessage(LEFT);
			} catch {
				// the port is gone
			}
		});
	host = link;
}

/** the host's pool and gate, as this realm asks them over `rpc` */
function hostedPool(
	rpc: RpcHelper<ClientBound, HostBound>,
	waits: Map<string, (id: string) => void>,
): PoolHost {
	return {
		async hold(fields, waiting) {
			if (fields.id && waiting) waits.set(fields.id, waiting);
			let taken: PoolTicket;
			try {
				taken = await rpc.call('hold', fields);
			} finally {
				if (fields.id) waits.delete(fields.id);
			}
			const { ticket, counted } = taken;
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				rpc.call('release', ticket).catch(() => {});
			};
			return {
				counted,
				learn(version, line) {
					// as the host's group will read it: a counted request is to a
					// group not known to multiplex
					const holds =
						counted && !released && !(version && MULTIPLEXED.has(version));
					rpc
						.call('learn', { ticket, version, line: !!line, holds })
						.then((told) => told && line?.(told))
						.catch(() => {});
					if (!holds) released = true;
					return holds;
				},
				release,
			};
		},
		requeue(id, urgency) {
			rpc.call('requeue', { id, urgency }).catch(() => {});
		},
		async admit(key) {
			let pass: number | null;
			try {
				pass = await rpc.call('admit', key);
			} catch {
				return undefined;
			}
			if (pass === null) return null;
			return {
				connected: () => void rpc.call('connected', pass).catch(() => {}),
				closed: () => void rpc.call('closed', pass).catch(() => {}),
			};
		},
	};
}

/**
 * The carrier host's pool, while this realm has a host that answers
 * (socketPool.ts); null without one, where the realm's own pool is asked
 */
export function poolHost(): PoolHost | null {
	return host?.heard ? host.pool : null;
}

/**
 * The host page's carrier host, started (a SharedWorker of `script`), and
 * its port; null where there is none (no SharedWorker, or one that cannot
 * start). The page hands the port to where its transport runs.
 */
export function startCarrierHost(script: URL): MessagePort | null {
	if (typeof SharedWorker !== 'function') return null;
	try {
		const worker = new SharedWorker(script, {
			name: CARRIER_HOST_NAME,
			// it outlives the page's reload by up to five minutes (Chrome 157),
			// its carriers with it; every page asks for it with the option, or
			// Chrome refuses the one that differs
			extendedLifetime: true,
		} as WorkerOptions);
		worker.addEventListener('error', () => {});
		return worker.port;
	} catch {
		return null;
	}
}

/**
 * A rider from the carrier host and what the host told of it; null when
 * there is no host, or it did not answer within `ms` (the transport then
 * opens a carrier of its own)
 */
export async function askCarrierHost(
	ask: CarrierAsk,
	ms: number,
): Promise<{ given: CarrierGiven; open: OpenCarrier | null } | null> {
	const link = host;
	if (!link) return null;
	if (!link.heard) {
		if (link.slow) return null;
		const answered = await Promise.race([link.ready, sleep(READY_MS)]);
		if (!answered) {
			link.slow = true;
			return null;
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const asked = link.rpc.call('open', { ...ask, credit: true });
		const given = await Promise.race([
			asked,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), ms);
			}),
		]);
		if (!given) {
			// a rider that comes after all is let go
			void asked.then(
				(late) => late.port && endRider(late.port),
				() => {},
			);
			return null;
		}
		return {
			given,
			open: given.port ? riderCarrier(given, given.port, link) : null,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function endRider(port: MessagePort) {
	try {
		port.postMessage(END);
		port.close();
	} catch {
		// gone already
	}
}

/** the rider on `port` as a carrier epoxy reads and writes, as its own */
function riderCarrier(
	given: CarrierGiven,
	port: MessagePort,
	link: HostLink,
): OpenCarrier {
	let reading!: ReadableStreamDefaultController<ArrayBuffer>;
	let ended = false;
	let settle!: () => void;
	let fail!: (error: Error) => void;
	const done = new Promise<void>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	done.catch(() => {});
	const finish = (lost: boolean) => {
		if (ended) return;
		ended = true;
		link.riders.delete(end);
		try {
			reading.close();
		} catch {
			// cancelled already
		}
		port.close();
		if (lost) fail(new Error('the carrier was lost without a close'));
		else settle();
	};
	const close = () => {
		if (ended) return;
		try {
			port.postMessage(END);
		} catch {
			// gone already
		}
		finish(false);
	};
	/** the host is gone (`lost`), or the page unloads */
	const end = (lost: boolean) => (lost ? finish(true) : close());
	link.riders.add(end);
	const read = new ReadableStream<ArrayBuffer>({
		start(controller) {
			reading = controller;
		},
		cancel() {
			close();
		},
	});
	// Paced to the readers of this realm's bodies: epoxy keeps whatever a
	// stream receives until its body is read (wisp has no flow control
	// toward the client), and the host, a thread of its own, can read the
	// relay faster than they take it, where a carrier of this realm's own
	// was read no faster than this thread runs. A packet past PACED_AHEAD
	// bytes ahead of them waits here, the host sends RIDER_WINDOW past what
	// was let through, and stops reading the relay past that: the session
	// holds the server back, as a reader holds a socket's back natively.
	// Readers that stop (a paused one) hold nothing back.
	const paced = given.credit === true;
	const held: ArrayBuffer[] = [];
	let delivered = 0;
	let start = 0;
	let untold = 0;
	let quiet: ReturnType<typeof setTimeout> | undefined;
	const flowing = () => {
		if (performance.now() - bodiesTaken.at > PACED_QUIET_MS) {
			start = delivered - bodiesTaken.bytes;
			return true;
		}
		return delivered - bodiesTaken.bytes - start < PACED_AHEAD;
	};
	const pass = () => {
		clearTimeout(quiet);
		while (!ended && held.length && flowing()) {
			const packet = held.shift()!;
			const bytes = new Uint8Array(packet);
			if (bytes[0] === DATA && bytes.length > 5) delivered += bytes.length - 5;
			untold += packet.byteLength;
			reading.enqueue(packet);
		}
		if (!ended && (untold >= TOOK_STEP || (!held.length && untold))) {
			try {
				port.postMessage({ took: untold });
			} catch {
				// gone already
			}
			untold = 0;
		}
		if (ended || !held.length) bodiesTaken.waiters.delete(pass);
		else {
			bodiesTaken.waiters.add(pass);
			quiet = setTimeout(pass, PACED_QUIET_MS);
		}
	};
	port.addEventListener('message', (event) => {
		const data = event.data as unknown;
		if (data instanceof ArrayBuffer) {
			if (ended) return;
			if (!paced) reading.enqueue(data);
			else {
				held.push(data);
				pass();
			}
			return;
		}
		if (typeof data === 'object' && data !== null && 'end' in data)
			finish((data as { end: unknown }).end === 'lost');
	});
	port.start();
	const write = new WritableStream<Uint8Array>({
		write(packet) {
			if (ended) return;
			const own = packet.slice();
			port.postMessage(own.buffer, [own.buffer]);
		},
		close,
		abort: close,
	});
	return {
		carrier: given.carrier ?? 'websocket',
		url: given.url ?? '',
		pipe: { read, write },
		close,
		ended: done,
		hosted: true,
	};
}
