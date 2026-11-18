// When a received audio frame is played (docs/webrtc-over-wisp.md,
// section 16). Frames arrive when the network and the wisp stream deliver
// them, in bursts and late; a track plays them end to end. The buffer here
// holds enough of them to ride out what the arrivals vary by and no more:
// its depth is where Chrome's NetEq keeps its own for the same arrivals
// (its delay manager and its buffer's limits, below), a frame that has not come when it is due is a
// gap (the caller plays silence), an underrun waits for the buffer to fill
// again, and a buffer that stays deeper than it needs gives up its
// quietest frame.
//
// Nothing here knows about audio or clocks: a frame has a time and a
// length in the caller's units (RTP timestamps), `now` is the caller's
// milliseconds, and `rate` says how many units a millisecond is.

interface Held<T> {
	time: number;
	length: number;
	value: T;
	/** how loud the frame is, for the choice of one to drop (lower is quieter) */
	energy: number;
	/** when it came, in the caller's milliseconds */
	came: number;
}

export interface PlayoutOptions<T> {
	/** units of time in a millisecond (48 at 48 kHz) */
	rate: number;
	/** the delay in milliseconds a new stream starts at */
	initialMs?: number;
	/** the longest delay in milliseconds */
	maxMs?: number;
	/** a frame the buffer gives up (late, too many, dropped to shorten the delay) */
	discard?: (value: T) => void;
}

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
/** how far below a long target NetEq's buffer may be before it is stretched */
const LOW_OFFSET_MS = 85;
/** how far above its lower limit NetEq's buffer may be before it is shortened */
const LIMIT_MS = 20;
/** how much sooner than its time a first frame may play (a timer that fires a little early) */
const EARLY_MS = 0.5;
/** how long after a frame was made shorter or longer the next may be (NetEq's six 10 ms ticks) */
const TIMESCALE_MS = 60;
/** how many times its upper limit the buffer may be before it is shortened every frame, by as much as a frame allows (NetEq's fast accelerate) */
const FAST = 4;
/** a hole longer than this many milliseconds is a pause in the stream, not a loss */
const PAUSE_MS = 200;
/** empty pulls in a row before the stream is taken to have paused */
const EMPTY_PULLS = 3;
/** a frame this far from what is held belongs to another clock */
const JUMP_MS = 10000;

export interface PlayoutStats {
	/** frames handed out */
	played: number;
	/** pulls that had no frame: silence */
	gaps: number;
	/** frames that came after their time */
	late: number;
	/** frames given up to shorten the delay, or because too many were held */
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
	/** the time of the next frame to play; null while the buffer fills */
	#next: number | null = null;
	#targetMs: number;
	/** the arrivals of the last `HISTORY_MS`: when, and that less the media time, in ms */
	#arrivals: { time: number; late: number }[] = [];
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
	#empty = 0;
	/** sound made up while nothing was held (units), which a hole that turns up then was */
	#owed = 0;
	/** how long frames wait, filtered as NetEq filters its buffer's level (ms; null before the first) */
	#level: number | null = null;
	/** the caller plays comfort noise */
	#quiet = false;
	/** the last pull was a gap (NetEq does not stretch right after an expand) */
	#gap = false;
	/** when a frame was last made shorter or longer */
	#scaled = -Infinity;
	/**
	 * What the caller does to the frame the last pull gave, as NetEq's
	 * decision logic decides it: take a pitch period out (`accelerate`),
	 * as many as fit in 10 ms (`fast`), or put one in (`expand`), and
	 * tell `stretched` how much it did.
	 */
	decision: 'fast' | 'accelerate' | 'expand' | null = null;
	/** when the buffer started to fill, for a stream that sends too little to fill it */
	#filling: number | null = null;
	/** times of frames given up, which are not gaps when their turn comes */
	#skipped = new Map<number, number>();
	/** the length of the last frame played, which a gap is taken to have */
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

	/** playing: frames and their gaps are due (not while the buffer fills, or the stream is silent) */
	get running(): boolean {
		return this.#next !== null;
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
	push(
		time: number,
		length: number,
		value: T,
		now: number,
		energy = 0,
		counted = false,
	) {
		// a frame far from what is held is another stream's clock: start over
		const reference = this.#next ?? this.#held.at(-1)?.time;
		if (
			reference !== undefined &&
			Math.abs(time - reference) > JUMP_MS * this.#rate
		) {
			for (const held of this.#held.splice(0)) this.#discard(held.value);
			this.#next = null;
			this.#arrivals = [];
			this.#latest = null;
			this.#level = null;
			this.#filling = null;
			this.#skipped.clear();
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
		this.#held.splice(at, 0, {
			time,
			length,
			value,
			energy,
			came: now,
		});
		if (this.#heldMs() > this.#maxMs) {
			// more than the buffer may hold: the oldest goes
			const [oldest] = this.#held.splice(0, 1);
			this.stats.dropped++;
			if (this.#next !== null)
				this.#next = Math.max(this.#next, oldest.time + oldest.length);
			this.#discard(oldest.value);
		}
		if (this.#next === null && this.#filling === null) this.#filling = now;
	}

	/** a packet arrived for media `time`: its delay, as NetEq counts it */
	arrived(time: number, now: number) {
		// (NetEq's clock is its 10 ms ticks: how long after the last a
		// packet came is a count of them)
		const tick = Math.floor(now / TICK_MS) * TICK_MS;
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

	/**
	 * The frame to play now: a frame, or null for silence of `frameMs`
	 * (nothing has come, the buffer is filling, or the frame due was
	 * lost). The caller asks again when what it got has played; `quiet`
	 * says it plays comfort noise meanwhile, which NetEq keeps out of its
	 * buffer's level.
	 */
	pull(now: number, quiet = false): T | null {
		this.#quiet = quiet;
		this.decision = null;
		const heldMs = this.#heldMs();
		this.stats.heldMs = heldMs;
		if (this.#next === null) {
			// filling: until the delay is there, or for as long as it would
			// take to come if the sender sent steadily
			const waited = this.#filling === null ? 0 : now - this.#filling;
			if (
				!this.#held.length ||
				(heldMs <= this.#depthMs() && waited < this.#waitMs() - EARLY_MS)
			) {
				this.stats.gaps++;
				return null;
			}
			this.#next = this.#held[0].time;
			this.#filling = null;
			// (the level goes on: NetEq's filter is not reset when its
			// buffer runs dry and fills again)
			this.#gap = false;
			this.#empty = 0;
			this.#owed = 0;
		}
		for (;;) {
			const length = this.#skipped.get(this.#next);
			if (length === undefined) break;
			this.#skipped.delete(this.#next);
			this.#next += length;
		}
		const head = this.#held[0];
		if (!head) {
			// Nothing held: the frame due has not come. The time stands
			// still (the caller makes up sound meanwhile) and the frame plays
			// when it comes, later than it would have, as NetEq plays a
			// packet that comes after its time rather than drop it
			// (measured: Chrome's packetsDiscarded stays 0 with packets
			// held up for 60 to 300 ms); a stream that stays silent fills
			// the buffer again before it plays.
			// (if the frame due was lost, the sound made up meanwhile was its
			// time: NetEq goes on from the packet after it)
			this.stats.gaps++;
			this.#gap = true;
			this.#measure(0);
			this.#owed += Math.round(this.frameMs * this.#rate);
			if (++this.#empty >= EMPTY_PULLS) this.#next = null;
			return null;
		}
		this.#empty = 0;
		const owed = this.#owed;
		this.#owed = 0;
		if (head.time > this.#next) {
			if (head.time - this.#next > PAUSE_MS * this.#rate) {
				// the sender paused (silence suppression): go on from here
				this.#next = head.time;
				this.#skipped.clear();
			} else {
				// lost: what was made up while nothing was held stood for it
				this.#next += Math.min(head.time - this.#next, owed);
			}
		}
		if (head.time > this.#next) {
			// lost, or not here yet: its time passes
			this.#next += Math.min(
				head.time - this.#next,
				Math.round(this.frameMs * this.#rate),
			);
			this.stats.gaps++;
			this.#gap = true;
			this.#measure(this.#levelOf(now));
			return null;
		}
		this.#measure(this.#levelOf(now));
		if (!this.#gap) this.decision = this.#decide(now);
		this.#gap = false;
		const [playing] = this.#held.splice(0, 1);
		this.#next = playing.time + playing.length;
		this.frameMs = playing.length / this.#rate;
		this.stats.played++;
		return playing.value;
	}

	/**
	 * NetEq lets its buffer be anywhere between three quarters of its
	 * target (85 ms less, for a long one) and the higher of the target and
	 * that and 20 ms, 15 to 35 ms for a target of 20, and shortens or
	 * stretches it a pitch period at a time while it is outside.
	 */
	#band() {
		const target = this.#targetMs;
		const low = Math.max((target * 3) / 4, target - LOW_OFFSET_MS);
		return { low, high: Math.max(target, low + LIMIT_MS) };
	}

	/**
	 * How long a frame waits where NetEq's would: about the middle of that
	 * (natively 29 to 31 ms of delay for a target of 20, counted to when
	 * each 10 ms of it is played, 5 ms more than to when it starts)
	 */
	#waitMs() {
		const { low, high } = this.#band();
		return Math.min(this.#maxMs - this.frameMs, (low + high) / 2);
	}

	/** what is held where frames wait that long: the frame due, and the ones that came meanwhile */
	#depthMs() {
		return Math.min(
			this.#maxMs - this.frameMs,
			(Math.floor(this.#waitMs() / this.frameMs) + 1) * this.frameMs,
		);
	}

	/**
	 * How long until the frame of `time` is pulled, in ms, where the next
	 * pull is at `pulling`: the sound due before it after that (while the
	 * buffer fills, until it plays)
	 */
	dueIn(time: number, now: number, pulling: number): number {
		if (this.#next === null)
			return this.#filling === null
				? this.#waitMs()
				: this.#filling + this.#waitMs() - now;
		return pulling - now + (time - this.#next) / this.#rate;
	}

	/**
	 * When the buffer that is filling plays its first frame (null when it
	 * is not filling, or holds nothing): as long after that frame came as
	 * NetEq's would wait. The caller plays it then, not at its next 20 ms.
	 */
	get startsAt(): number | null {
		if (this.#next !== null || !this.#held.length || this.#filling === null)
			return null;
		return this.#filling + this.#waitMs();
	}

	/**
	 * What NetEq's level is for this buffer: how long the frame due has
	 * waited since it came (natively, with no frame made shorter or
	 * longer, its packets wait 29 to 38 ms for a target of 20, inside its
	 * 15 to 35 ms, and 44 for a target of 60, inside 45 to 65), or, after
	 * a burst, the sound held behind it
	 */
	#levelOf(now: number): number {
		const head = this.#held[0];
		if (!head) return 0;
		return Math.max(now - head.came, this.#heldMs() - head.length / this.#rate);
	}

	/**
	 * NetEq's buffer level filter: each 10 ms the level is a weighted
	 * mean of what it was and what the buffer holds now, weighted more
	 * to what it was the longer the target (251 to 254 of 256); here once
	 * a pull
	 */
	#measure(waited: number) {
		if (this.#quiet) return;
		if (this.#level === null) {
			this.#level = waited;
			return;
		}
		const target = this.#targetMs;
		const kept =
			(target <= 20 ? 251 : target <= 60 ? 252 : target <= 140 ? 253 : 254) /
			256;
		const factor = kept ** (this.frameMs / 10);
		this.#level = this.#level * factor + waited * (1 - factor);
	}

	/**
	 * NetEq's decision for a frame that came in time: shorter where the
	 * level is above the buffer's upper limit, longer where it is below
	 * its lower, no sooner than `TIMESCALE_MS` after the last; as short as
	 * it can be made where the level is `FAST` times the upper limit, at
	 * every frame.
	 */
	#decide(now: number): 'fast' | 'accelerate' | 'expand' | null {
		const level = this.#level ?? 0;
		const { low, high } = this.#band();
		if (level >= FAST * high) return 'fast';
		if (now - this.#scaled < TIMESCALE_MS) return null;
		if (level >= high) return 'accelerate';
		if (level < low) return 'expand';
		return null;
	}

	/**
	 * The caller made the frame the last pull gave `ms` longer (shorter
	 * where negative): the frames after it wait that much longer, which
	 * the level takes in at once, as NetEq's filter takes in what it
	 * stretched
	 */
	stretched(ms: number, now: number) {
		if (this.#level !== null) this.#level += ms;
		if (ms < 0) this.stats.removedMs -= ms;
		else this.stats.insertedMs += ms;
		this.#scaled = now;
	}

	/** give up everything held, for a stream that ends */
	clear() {
		this.#next = null;
		this.#filling = null;
		this.#level = null;
		this.#skipped.clear();
		for (const held of this.#held.splice(0)) this.#discard(held.value);
	}
}
