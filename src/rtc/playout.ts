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
	/** sound the caller made up for a frame lost on the way */
	madeUp: boolean;
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
 * section 16): a packet's delay is how much later it came than the packet
 * of the last `HISTORY_MS` that came soonest for its media time; the
 * longest of each `INTERVAL_MS` goes into a histogram of `BUCKET_MS`
 * buckets that forgets by `FORGET` an entry (faster at first: `START`),
 * and the target is the bucket `QUANTILE` of the delays fit in, and one
 * more: 20 ms for a steady stream, 40 for one whose packets vary by 20.
 * Until the first interval is in, the stream starts at `initialMs`.
 */
const HISTORY_MS = 2000;
const INTERVAL_MS = 500;
const BUCKET_MS = 20;
const BUCKETS = 100;
const QUANTILE = 0.95;
const FORGET = 0.983;
const START = 2;
/** how far below a long target NetEq's buffer may be before it is stretched */
const LOW_OFFSET_MS = 85;
/** how far above its lower limit NetEq's buffer may be before it is shortened */
const LIMIT_MS = 20;
/** how much sooner than its time a first frame may play (a timer that fires a little early) */
const EARLY_MS = 0.5;
/** how many pulls the buffer must stay too deep before a frame is dropped */
const SETTLE = 100;
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
	#arrivals: { at: number; offset: number }[] = [];
	/** the media time of the latest arrival: one before it came out of order */
	#latest: number | null = null;
	/** when the interval began, and the longest delay in it */
	#interval: number | null = null;
	#intervalMax = 0;
	/** the delay histogram, its entries, and what it keeps of the last at each */
	#histogram = new Float64Array(BUCKETS);
	#entries = 0;
	#forget = 0;
	#empty = 0;
	/** sound made up while nothing was held (units), which a hole that turns up then was */
	#owed = 0;
	/** the least a frame waited, in ms, since the buffer last settled */
	#least = Infinity;
	#pulls = 0;
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
	 * caller told it with `arrived` (`counted`); `madeUp` is sound the
	 * caller made up for a frame lost on the way, which comes with the
	 * frame after it.
	 */
	push(
		time: number,
		length: number,
		value: T,
		now: number,
		energy = 0,
		counted = false,
		madeUp = false,
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
			madeUp,
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
		const offset = now - time / this.#rate;
		const arrivals = this.#arrivals;
		arrivals.push({ at: now, offset });
		while (arrivals.length > 1 && arrivals[0].at < now - HISTORY_MS)
			arrivals.shift();
		let least = Infinity;
		for (const arrival of arrivals)
			if (arrival.offset < least) least = arrival.offset;
		// one that came out of order does not count toward the underruns
		const reordered = this.#latest !== null && time < this.#latest;
		if (!reordered) this.#latest = time;
		if (this.#interval === null) this.#interval = now;
		else if (now - this.#interval > INTERVAL_MS) {
			this.#enter(this.#intervalMax);
			this.#interval = now;
			this.#intervalMax = 0;
		}
		if (!reordered)
			this.#intervalMax = Math.max(this.#intervalMax, offset - least);
		this.#target();
	}

	/** an interval's longest delay into the histogram */
	#enter(delayMs: number) {
		const index = Math.floor(delayMs / BUCKET_MS);
		if (index >= BUCKETS) return;
		const histogram = this.#histogram;
		for (let at = 0; at < BUCKETS; at++) histogram[at] *= this.#forget;
		histogram[index] += 1 - this.#forget;
		this.#entries++;
		this.#forget = Math.min(
			FORGET,
			Math.max(0, 1 - START / (this.#entries + 1)),
		);
	}

	#target() {
		let target = this.#floorMs;
		if (this.#entries) {
			let index = 0;
			let above = 1 - this.#histogram[0];
			while (above > 1 - QUANTILE + 1e-9 && index < BUCKETS - 1)
				above -= this.#histogram[++index];
			target = (index + 1) * BUCKET_MS;
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
	 * lost). The caller asks again when what it got has played.
	 */
	pull(now: number): T | null {
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
			this.#least = Infinity;
			this.#pulls = 0;
			this.#empty = 0;
			this.#owed = 0;
		}
		for (;;) {
			const length = this.#skipped.get(this.#next);
			if (length === undefined) break;
			this.#skipped.delete(this.#next);
			this.#next += length;
		}
		// Sound made up for a lost frame, which came with the frame after
		// it, where nothing was held when it was due: what was made up then
		// stood for it, as NetEq, which has no packet for it, goes on from
		// the packet after it
		while (
			this.#held[0]?.madeUp &&
			this.#held[0].time === this.#next &&
			this.#owed >= this.#held[0].length
		) {
			const [lost] = this.#held.splice(0, 1);
			this.#next += lost.length;
			this.#owed -= lost.length;
			this.#discard(lost.value);
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
			return null;
		}
		// (sound made up for a lost frame came with the frame after it:
		// how long it waited says nothing of the buffer)
		this.#shorten(head.madeUp ? Infinity : now - head.came);
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
	 * Frames that waited longer than NetEq lets its buffer be, for a while:
	 * the quietest of the next frames goes, which shortens the wait by one
	 * frame where it is heard least, if they still wait at least what
	 * NetEq's buffer may be without it.
	 */
	#shorten(waited: number) {
		if (waited < this.#least) this.#least = waited;
		if (++this.#pulls < SETTLE) return;
		const least = this.#least;
		const { low, high } = this.#band();
		this.#pulls = 0;
		this.#least = Infinity;
		if (least <= high || least - this.frameMs < low || this.#held.length < 2)
			return;
		let quietest = 0;
		const reach = Math.min(this.#held.length - 1, 5);
		for (let at = 1; at < reach; at++)
			if (this.#held[at].energy < this.#held[quietest].energy) quietest = at;
		const [dropped] = this.#held.splice(quietest, 1);
		// its turn is passed over when it comes, without a gap
		this.#skipped.set(dropped.time, dropped.length);
		this.stats.dropped++;
		this.#discard(dropped.value);
	}

	/** give up everything held, for a stream that ends */
	clear() {
		this.#next = null;
		this.#filling = null;
		this.#skipped.clear();
		for (const held of this.#held.splice(0)) this.#discard(held.value);
	}
}
