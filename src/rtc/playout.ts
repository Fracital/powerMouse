// When a received audio frame is played (docs/webrtc-over-wisp.md,
// section 16), as Chrome's NetEq decides it. Frames arrive when the
// network and the wisp stream deliver them, in bursts and late; the
// caller plays them through a sync buffer, 10 ms at a time, and asks here
// what to do each time that buffer runs short: play the next frame
// (`normal`), make up sound for one that is not there (`expand`), go on
// from made-up sound to the frame after a hole (`merge`), or play the
// next frame a pitch period shorter or longer to move the delay
// (`accelerate`, `fast`, `preemptive`). The delay aimed at is NetEq's
// (its delay manager, below), and the buffer is kept at it as NetEq's
// decision logic keeps it, on the delay of the sound playing behind the
// packet of the last 2 s that came soonest.
//
// Nothing here knows about audio or clocks: a frame has a time and a
// length in the caller's units (RTP timestamps), `now` is the caller's
// milliseconds, and `rate` says how many units a millisecond is.

interface Held<T> {
	time: number;
	length: number;
	value: T;
	/** when it came, in the caller's milliseconds */
	came: number;
}

export interface PlayoutOptions<T> {
	/** units of time in a millisecond (48 at 48 kHz) */
	rate: number;
	/** the delay in milliseconds a new stream aims at */
	initialMs?: number;
	/** the longest delay in milliseconds */
	maxMs?: number;
	/** a frame the buffer gives up (late, or too many) */
	discard?: (value: T) => void;
}

/** what the caller does when its sync buffer runs short (NetEq's operations) */
export type Operation =
	'normal' | 'merge' | 'expand' | 'accelerate' | 'fast' | 'preemptive';

/**
 * NetEq's delay manager (WebRTC's modules/audio_coding/neteq, as Chrome
 * 157 runs it; its targets measured natively, docs/webrtc-over-wisp.md,
 * section 16): a packet's delay is how much later than the one before it
 * it came than their media times say, on NetEq's clock of 10 ms ticks,
 * added up over the last `HISTORY_MS` of media time and never below
 * nothing (later than the packet before that history, or than the one
 * since that came soonest); the longest of each `INTERVAL_MS` goes into
 * a histogram of `BUCKET_MS`
 * buckets that forgets by `FORGET` an entry (faster at first: `START`),
 * and the target is the bucket `QUANTILE` of the delays fit in, and one
 * more: 20 ms for a steady stream, 40 for one whose packets vary by 20.
 * A packet that came out of order goes instead into a histogram of its
 * own (NetEq's reorder optimizer), one entry a packet (in the first
 * bucket for one in order) forgetting by `REORDER_FORGET`, and the target
 * is at least the bucket that costs least, where a bucket costs the delay
 * it adds to the other target and `LOSS_MS` for each in a hundred packets
 * that would come after it: 60 ms for packets delayed by 0 to 40 ms,
 * some of them swapping places.
 * Until the first interval is in, the stream starts at `initialMs`.
 */
const HISTORY_MS = 2000;
const INTERVAL_MS = 500;
/** NetEq's clock ticks once each 10 ms of sound it plays */
const TICK_MS = 10;
const BUCKET_MS = 20;
const BUCKETS = 100;
const QUANTILE = 0.95;
const FORGET = 0.983;
const START = 2;
const REORDER_FORGET = 0.9993;
const LOSS_MS = 20;

/** a histogram of 20 ms buckets that forgets by `forget` an entry (faster at first) */
class Forgetting {
	buckets = new Float64Array(BUCKETS);
	entries = 0;
	#keeps = 0;
	constructor(readonly forget: number) {}
	add(index: number) {
		if (index >= BUCKETS) return;
		const buckets = this.buckets;
		for (let at = 0; at < BUCKETS; at++) buckets[at] *= this.#keeps;
		buckets[index] += 1 - this.#keeps;
		this.entries++;
		this.#keeps = Math.min(
			this.forget,
			Math.max(0, 1 - START / (this.entries + 1)),
		);
	}
}
/**
 * NetEq's decision logic (Chrome 157's, whose stable delay mode is its
 * default): the sound playing is kept between the target and the target
 * and the longest delay of the last 2 s and `LIMIT_MS` behind the packet
 * of those 2 s that came soonest for its time, a pitch period at a time,
 * at most once each `TIMESCALE_MS`, and as fast as a frame allows past
 * `FAST` times the upper limit
 */
const LIMIT_MS = 20;
/** how long after a frame was made shorter or longer the next may be (NetEq's six 10 ms ticks) */
const TIMESCALE_MS = 60;
const FAST = 4;
/** a frame after a hole is played early where what is held waits this much longer than the target (half of NetEq's target window) */
const ABOVE_MS = 50;
/** made-up sound that has faded goes on until what is held waits this share of the target (NetEq's postponed decoding) */
const POSTPONE = 0.5;
/** a hole longer than this many milliseconds is a pause in the stream, not a loss */
const PAUSE_MS = 200;
/** a frame this far from what is held belongs to another clock */
const JUMP_MS = 10000;

export interface PlayoutStats {
	/** frames handed out */
	played: number;
	/** decisions that had no frame to play: sound made up */
	gaps: number;
	/** frames that came after their time */
	late: number;
	/** frames given up because too many were held */
	dropped: number;
	/** milliseconds of sound taken out of frames, and put into them, to move the delay */
	removedMs: number;
	insertedMs: number;
	/** the delay aimed at, in milliseconds */
	targetMs: number;
	/** milliseconds of sound held now */
	heldMs: number;
}

export class Playout<T> {
	#rate: number;
	#floorMs: number;
	#maxMs: number;
	#discard: (value: T) => void;
	#held: Held<T>[] = [];
	/** the time after the last frame taken (NetEq's sync buffer end); null before a stream's first */
	#next: number | null = null;
	#targetMs: number;
	/** the arrivals of the last `HISTORY_MS`: when, and that less the media time, in ms */
	#arrivals: { time: number; late: number }[] = [];
	/** every packet of the last `HISTORY_MS` of media time, and the tick it came in (NetEq's packet arrival history) */
	#history: { time: number; at: number; reordered: boolean }[] = [];
	/** the media time of the latest arrival: one before it came out of order */
	#latest: number | null = null;
	#latestTick = 0;
	/** when the interval began, and the longest delay in it */
	#interval: number | null = null;
	#intervalMax = 0;
	/** the delays of the intervals, and those of the packets that came out of order */
	#histogram = new Forgetting(FORGET);
	#reordered = new Forgetting(REORDER_FORGET);
	/** the delay of the latest arrival */
	#delay = 0;
	/** when a frame was last made shorter or longer */
	#scaled = -Infinity;
	/** the length of the last frame taken, the shortest target */
	frameMs = 20;
	stats: PlayoutStats;

	constructor(options: PlayoutOptions<T>) {
		this.#rate = options.rate;
		this.#floorMs = options.initialMs ?? 40;
		this.#maxMs = options.maxMs ?? 500;
		this.#discard = options.discard ?? (() => {});
		this.#targetMs = this.#floorMs;
		this.stats = {
			played: 0,
			gaps: 0,
			late: 0,
			dropped: 0,
			removedMs: 0,
			insertedMs: 0,
			targetMs: this.#targetMs,
			heldMs: 0,
		};
	}

	/** frames held */
	get held(): number {
		return this.#held.length;
	}

	#heldMs(): number {
		let units = 0;
		for (const held of this.#held) units += held.length;
		return units / this.#rate;
	}

	/**
	 * A frame arrived. Its arrival counts toward the delay unless the
	 * caller told it with `arrived` (`counted`).
	 */
	push(time: number, length: number, value: T, now: number, counted = false) {
		// a frame far from what is held is another stream's clock: start over
		const reference = this.#next ?? this.#held.at(-1)?.time;
		if (
			reference !== undefined &&
			Math.abs(time - reference) > JUMP_MS * this.#rate
		) {
			for (const held of this.#held.splice(0)) this.#discard(held.value);
			this.#next = null;
			this.#arrivals = [];
			this.#history = [];
			this.#latest = null;
		}
		if (!counted) this.arrived(time, now);
		if (this.#next !== null && time < this.#next) {
			// after its time: the buffer was too shallow for it
			this.stats.late++;
			this.#discard(value);
			return;
		}
		let at = this.#held.length;
		while (at > 0 && this.#held[at - 1].time > time) at--;
		if (at > 0 && this.#held[at - 1].time === time) {
			this.#discard(value);
			return;
		}
		this.#held.splice(at, 0, { time, length, value, came: now });
		if (this.#heldMs() > this.#maxMs) {
			// more than the buffer may hold: the oldest goes
			const [oldest] = this.#held.splice(0, 1);
			this.stats.dropped++;
			if (this.#next !== null)
				this.#next = Math.max(this.#next, oldest.time + oldest.length);
			this.#discard(oldest.value);
		}
	}

	/** a packet arrived for media `time`: its delay, as NetEq counts it */
	arrived(time: number, now: number) {
		// (NetEq's clock is its 10 ms ticks: how long after the last a
		// packet came is a count of them)
		const tick = Math.floor(now / TICK_MS) * TICK_MS;
		// (NetEq's packet arrival history: one older than it keeps, or one
		// it has, is not counted at all; one older than its newest is kept
		// but does not set how late the others are)
		const history = this.#history;
		const newest = history.at(-1)?.time ?? -Infinity;
		if (
			time < newest - HISTORY_MS * this.#rate ||
			history.some((arrival) => arrival.time === time)
		)
			return;
		const reordered = time < newest;
		history.splice(
			reordered
				? history.findIndex((arrival) => arrival.time > time)
				: history.length,
			0,
			{ time, at: tick, reordered },
		);
		while (history[0].time < history.at(-1)!.time - HISTORY_MS * this.#rate)
			history.shift();
		if (this.#latest !== null && time < this.#latest) {
			// one that came out of order: as late as it came after the latest
			this.#reordered.add(
				Math.floor(
					Math.max(
						0,
						this.#delay +
							tick -
							this.#latestTick -
							(time - this.#latest) / this.#rate,
					) / BUCKET_MS,
				),
			);
			this.#target();
			return;
		}
		const last = this.#latest;
		const lastTick = this.#latestTick;
		this.#latest = time;
		this.#latestTick = tick;
		if (last === null) return;
		this.#reordered.add(0);
		const arrivals = this.#arrivals;
		arrivals.push({ time, late: tick - lastTick - (time - last) / this.#rate });
		while (time - arrivals[0].time > HISTORY_MS * this.#rate) arrivals.shift();
		// how much later than it should have, after the packet before the
		// history (or the latest that came sooner than that one would say)
		let delay = 0;
		for (const arrival of arrivals) delay = Math.max(0, delay + arrival.late);
		this.#delay = delay;
		if (this.#interval === null) this.#interval = tick;
		else if (tick - this.#interval > INTERVAL_MS) {
			this.#histogram.add(Math.floor(this.#intervalMax / BUCKET_MS));
			this.#interval = tick;
			this.#intervalMax = 0;
		}
		this.#intervalMax = Math.max(this.#intervalMax, delay);
		this.#target();
	}

	#target() {
		let target = this.#floorMs;
		if (this.#histogram.entries) {
			const buckets = this.#histogram.buckets;
			let index = 0;
			let above = 1 - buckets[0];
			while (above > 1 - QUANTILE + 1e-9 && index < BUCKETS - 1)
				above -= buckets[++index];
			target = (index + 1) * BUCKET_MS;
		}
		if (this.#reordered.entries) {
			// the bucket that costs least, the first of those that cost the same
			const buckets = this.#reordered.buckets;
			let after = 1;
			let cheapest = Infinity;
			let index = 0;
			for (let at = 0; at < BUCKETS; at++) {
				after -= buckets[at];
				const cost =
					Math.max(0, at * BUCKET_MS - target) + 100 * LOSS_MS * after;
				if (cost < cheapest - 1e-9) {
					cheapest = cost;
					index = at;
				}
				if (after <= 1e-12) break;
			}
			target = Math.max(target, (index + 1) * BUCKET_MS);
		}
		// a packet at least
		this.#targetMs = Math.min(
			this.#maxMs - this.frameMs,
			Math.max(target, this.frameMs),
		);
		this.stats.targetMs = this.#targetMs;
	}

	/** how far behind the packet of the history that came soonest for its time the sound of `time` is at `now` (NetEq's GetDelayMs), and the most a packet of it came behind that one */
	#behind(time: number, now: number): { delay: number; most: number } {
		let soonest = Infinity;
		let latest = -Infinity;
		for (const arrival of this.#history) {
			if (arrival.reordered) continue;
			const late = arrival.at - arrival.time / this.#rate;
			soonest = Math.min(soonest, late);
			latest = Math.max(latest, late);
		}
		if (soonest === Infinity) return { delay: 0, most: 0 };
		return {
			delay: Math.max(
				0,
				Math.floor(now / TICK_MS) * TICK_MS - time / this.#rate - soonest,
			),
			most: latest - soonest,
		};
	}

	/**
	 * What to do now that the caller's sync buffer holds less than it
	 * plays next, `future` units of sound not played yet, the last
	 * operation `last` (`noise` for comfort noise), `generated` units made
	 * up since that began, `muted` when what it made up has faded to under
	 * half: NetEq's decision.
	 */
	decide(
		now: number,
		future: number,
		last: Operation | 'noise' | null,
		generated: number,
		muted = false,
	): Operation {
		const head = this.#held[0];
		this.stats.heldMs = this.#heldMs();
		const next = this.#next;
		// a stream's first frame plays at once, as NetEq plays its first
		// packet at its next 10 ms
		if (head && next === null) return 'normal';
		const expanding = last === 'expand' || last === 'noise';
		const target = this.#targetMs;
		if (head && next !== null) {
			if (head.time - next > PAUSE_MS * this.#rate) {
				// the sender paused (silence suppression): go on from here
				this.#next = head.time;
				return last === 'expand' ? 'merge' : 'normal';
			}
			const tail = this.#held.at(-1)!;
			const waiting = (tail.time - head.time) / this.#rate + now - tail.came;
			if (
				!(expanding && (last === 'noise' || muted)) ||
				waiting >= target * POSTPONE
			) {
				if (head.time <= next) {
					// the frame due is here
					if (last === 'expand') return 'normal';
					const { delay, most } = this.#behind(next - future, now);
					const high = target + most + LIMIT_MS;
					if (delay >= FAST * high) return 'fast';
					if (now - this.#scaled >= TIMESCALE_MS) {
						if (delay >= high) return 'accelerate';
						if (delay < target) return 'preemptive';
					}
					return 'normal';
				}
				// a frame after a hole: once as much sound as the hole was
				// made up, or what is held waits far longer than the target
				if (head.time - next <= generated || waiting > target + ABOVE_MS) {
					if (last === 'expand') return 'merge';
					if (last === 'noise') return 'normal';
				}
			}
		}
		this.stats.gaps++;
		return 'expand';
	}

	/** the frame the last decision plays: the next held */
	take(): T | null {
		const [playing] = this.#held.splice(0, 1);
		if (!playing) return null;
		this.#next = playing.time + playing.length;
		this.frameMs = playing.length / this.#rate;
		this.stats.played++;
		return playing.value;
	}

	/**
	 * How long until the frame of `time` is taken, in ms, where the next
	 * decision is at `pulling`: the sound due before it after that
	 */
	dueIn(time: number, now: number, pulling: number, first = time): number {
		// (before the stream's first frame plays: after the first held, or
		// the caller's `first`)
		const from = this.#next ?? this.#held[0]?.time ?? first;
		return pulling - now + (time - from) / this.#rate;
	}

	/** the caller made the frame taken `ms` longer (shorter where negative) */
	stretched(ms: number, now: number) {
		if (ms < 0) this.stats.removedMs -= ms;
		else this.stats.insertedMs += ms;
		this.#scaled = now;
	}

	/** the stream stopped: its next frame starts it again, at once */
	reset() {
		this.#next = null;
	}

	/** give up everything held, for a stream that ends */
	clear() {
		this.#next = null;
		for (const held of this.#held.splice(0)) this.#discard(held.value);
	}
}
