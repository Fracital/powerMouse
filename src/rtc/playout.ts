// When a received audio frame is played (docs/webrtc-over-wisp.md,
// section 16). Frames arrive when the network and the wisp stream deliver
// them, in bursts and late; a track plays them end to end. The buffer here
// holds enough of them to ride out what the arrivals vary by and no more:
// its depth follows the spread of the arrival times, a frame that has not
// come when it is due is a gap (the caller plays silence), an underrun
// waits for the buffer to fill again, and a buffer that stays deeper than
// it needs gives up its quietest frame.
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
}

export interface PlayoutOptions<T> {
	/** units of time in a millisecond (48 at 48 kHz) */
	rate: number;
	/** the delay in milliseconds a new stream starts at */
	initialMs?: number;
	/** the longest delay in milliseconds */
	maxMs?: number;
	/** sound held beyond what the arrivals ask for, in milliseconds (`holdMs`) */
	holdMs?: number;
	/** a frame the buffer gives up (late, too many, dropped to shorten the delay) */
	discard?: (value: T) => void;
}

/** how many arrivals the spread is taken over (about four seconds of 20 ms frames) */
const WINDOW = 200;
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
	/** arrival minus media time of the last arrivals, in ms */
	#offsets: number[] = [];
	#empty = 0;
	/** the least sound held, in ms, since the buffer last settled */
	#least = Infinity;
	#pulls = 0;
	/** when the buffer started to fill, for a stream that sends too little to fill it */
	#filling: number | null = null;
	/** times of frames given up, which are not gaps when their turn comes */
	#skipped = new Map<number, number>();
	/** the length of the last frame played, which a gap is taken to have */
	frameMs = 20;
	/**
	 * Sound held beyond what the arrivals ask for, in milliseconds: for a
	 * stream whose lost frame is rebuilt from the next one (Opus in-band
	 * FEC), the time that next one takes to come
	 */
	holdMs = 0;
	stats: PlayoutStats;

	constructor(options: PlayoutOptions<T>) {
		this.#rate = options.rate;
		this.#floorMs = options.initialMs ?? 40;
		this.#maxMs = options.maxMs ?? 500;
		this.#discard = options.discard ?? (() => {});
		this.holdMs = options.holdMs ?? 0;
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

	/** a frame arrived */
	push(time: number, length: number, value: T, now: number, energy = 0) {
		// a frame far from what is held is another stream's clock: start over
		const reference = this.#next ?? this.#held.at(-1)?.time;
		if (
			reference !== undefined &&
			Math.abs(time - reference) > JUMP_MS * this.#rate
		) {
			for (const held of this.#held.splice(0)) this.#discard(held.value);
			this.#next = null;
			this.#offsets = [];
			this.#filling = null;
			this.#skipped.clear();
		}
		this.#spread(time, now);
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
		this.#held.splice(at, 0, { time, length, value, energy });
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

	/** the delay the arrivals ask for: their spread, and a frame to spare */
	#spread(time: number, now: number) {
		this.#offsets.push(now - time / this.#rate);
		if (this.#offsets.length > WINDOW) this.#offsets.shift();
		let low = Infinity;
		let high = -Infinity;
		for (const value of this.#offsets) {
			if (value < low) low = value;
			if (value > high) high = value;
		}
		this.#targetMs = Math.min(
			this.#maxMs - this.frameMs,
			Math.max(this.#floorMs, high - low + this.frameMs) + this.holdMs,
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
				(heldMs < this.#targetMs && waited < this.#targetMs)
			) {
				this.stats.gaps++;
				return null;
			}
			this.#next = this.#held[0].time;
			this.#filling = null;
			this.#least = Infinity;
			this.#pulls = 0;
			this.#empty = 0;
		}
		const head = this.#held[0];
		if (!head) {
			// nothing held: the time stands still, and a stream that stays
			// silent fills the buffer again before it plays
			this.stats.gaps++;
			if (++this.#empty >= EMPTY_PULLS) this.#next = null;
			return null;
		}
		this.#empty = 0;
		for (;;) {
			const length = this.#skipped.get(this.#next);
			if (length === undefined) break;
			this.#skipped.delete(this.#next);
			this.#next += length;
		}
		if (head.time > this.#next) {
			if (head.time - this.#next > PAUSE_MS * this.#rate) {
				// the sender paused (silence suppression): go on from here
				this.#next = head.time;
				this.#skipped.clear();
			} else {
				// lost, or not here yet: its time passes
				this.#next += Math.min(
					head.time - this.#next,
					Math.round(this.frameMs * this.#rate),
				);
				this.stats.gaps++;
				return null;
			}
		}
		this.#shorten(heldMs);
		const [playing] = this.#held.splice(0, 1);
		this.#next = playing.time + playing.length;
		this.frameMs = playing.length / this.#rate;
		this.stats.played++;
		return playing.value;
	}

	/**
	 * Deeper than the arrivals ask for, for a while: the quietest of the
	 * next frames goes, which shortens the delay by one frame where it is
	 * heard least.
	 */
	#shorten(heldMs: number) {
		if (heldMs < this.#least) this.#least = heldMs;
		if (++this.#pulls < SETTLE) return;
		const spare = this.#least - this.#targetMs;
		this.#pulls = 0;
		this.#least = Infinity;
		if (spare < this.frameMs || this.#held.length < 2) return;
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
