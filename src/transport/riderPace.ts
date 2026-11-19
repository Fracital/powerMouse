// A carrier host's rider read at the pace of this realm's body readers:
// the transport's own (carrierClient.ts riderCarrier) and each shard
// worker's (`ride`, wispSplit.ts lanePipe). Epoxy keeps whatever a stream
// receives until its body is read (wisp has no flow control toward the
// client), and the host, a thread of its own, can read the relay faster
// than they take it, where a carrier of this realm's own was read no
// faster than this thread runs. A packet past PACED_AHEAD bytes ahead of
// them waits here, the host sends RIDER_WINDOW (carrierClient.ts) past
// what was let through, and stops reading the relay past that: the
// session holds the server back, as a reader holds a socket's back
// natively. Readers that stop (a paused one) hold nothing back.
import { bodiesTaken } from './bodyPort';

/** a rider of the relay for another realm (a shard's worker), and whether the host takes its `{ took }` */
export interface Ride {
	port: MessagePort;
	credit: boolean;
}

/** what a rider tells the host it took, at least, each time (bytes) */
const TOOK_STEP = 1024 * 1024;
/**
 * DATA a rider hands epoxy ahead of what this realm's body readers took,
 * at most, while they read: 64 ms at a gigabit, and what a body read
 * through the worker leaves in epoxy's memory (abandoned-bodies allows 16 MB
 * of growth, and 16 here measured 14 to 18)
 */
const PACED_AHEAD = 8 * 1024 * 1024;
/** readers that took nothing for this long are not reading: nothing waits for them */
const PACED_QUIET_MS = 250;
const CONNECT = 0x01;
const DATA = 0x02;
const CLOSE = 0x04;
/** a CONNECT's stream type: UDP */
const UDP = 0x02;
const streamOf = (bytes: Uint8Array) =>
	(bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;

export interface RiderPace {
	/** the host's packets: handed to epoxy as the readers take them */
	take(packets: ArrayBuffer[]): void;
	/** the rider ended; `hand`: what waits goes to epoxy first (the host's end comes after its packets) */
	end(hand: boolean): void;
	/** a packet epoxy sends on the rider: a UDP stream's CONNECT makes its datagrams go past what waits */
	sent(packet: Uint8Array): void;
}

/** the packets of the rider on `port`, handed on to `enqueue` at the readers' pace */
export function paceRider(
	port: MessagePort,
	enqueue: (packet: ArrayBuffer) => void,
): RiderPace {
	const held: ArrayBuffer[] = [];
	/**
	 * the UDP streams epoxy opened: a datagram never waits for body readers
	 * (a native UDP socket is no one else's), and its stream holds nothing
	 * back, so it goes past what waits
	 */
	const udp = new Set<number>();
	let over = false;
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
	const hand = (packet: ArrayBuffer) => {
		const bytes = new Uint8Array(packet);
		if (bytes[0] === DATA && bytes.length > 5) delivered += bytes.length - 5;
		untold += packet.byteLength;
		enqueue(packet);
	};
	const pass = () => {
		clearTimeout(quiet);
		while (!over && held.length && flowing()) hand(held.shift()!);
		if (!over && (untold >= TOOK_STEP || (!held.length && untold))) {
			try {
				port.postMessage({ took: untold });
			} catch {
				// gone already
			}
			untold = 0;
		}
		if (over || !held.length) bodiesTaken.waiters.delete(pass);
		else {
			bodiesTaken.waiters.add(pass);
			quiet = setTimeout(pass, PACED_QUIET_MS);
		}
	};
	return {
		take(packets) {
			if (over) return;
			for (const packet of packets) {
				const bytes = new Uint8Array(packet, 0, Math.min(5, packet.byteLength));
				const id = bytes.length === 5 ? streamOf(bytes) : 0;
				if (id && udp.has(id)) {
					if (bytes[0] === CLOSE) udp.delete(id);
					hand(packet);
				} else held.push(packet);
			}
			pass();
		},
		sent(packet) {
			if (packet.length < 6) return;
			const id = streamOf(packet);
			if (packet[0] === CONNECT && packet[5] === UDP) udp.add(id);
			else if (packet[0] === CONNECT || packet[0] === CLOSE) udp.delete(id);
		},
		end(handing) {
			if (over) return;
			over = true;
			clearTimeout(quiet);
			bodiesTaken.waiters.delete(pass);
			const rest = held.splice(0);
			if (handing) for (const packet of rest) enqueue(packet);
		},
	};
}
