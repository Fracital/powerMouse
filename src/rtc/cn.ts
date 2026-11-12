// Comfort noise (RFC 3389): what a sender that leaves silence out sends in
// its place, a level and the shape of the background noise, which the
// receiver plays as noise until speech comes again rather than leave the
// track dead silent (docs/webrtc-over-wisp.md, section 16). The level is
// in -dBov, the shape reflection coefficients of an all-pole filter.

/** the most coefficients a description is read with (WebRTC's limit) */
const MAX_ORDER = 12;
/**
 * How fast the noise moves to a new description, for each 10 ms made:
 * the part of the old one kept (WebRTC's 0.8, and 0.6 for the first
 * block of a new period of noise)
 */
const KEEP = 0.8;
const KEEP_NEW = 0.6;
/**
 * Chrome plays the noise this many dB below the level a packet states
 * (measured on 152 and 156 from levels 20 to 80: -22.5 dBFS for 20,
 * -52.7 for 50, -63.0 for 60)
 */
const PLAYED_BELOW = 2.6;

/** what a comfort noise packet says */
export interface NoiseDescription {
	/** the noise's level in -dBov, 0 the loudest */
	level: number;
	/** the reflection coefficients, between -1 and 1 */
	reflections: number[];
}

export function parseNoise(payload: Uint8Array): NoiseDescription | null {
	if (!payload.length) return null;
	const reflections: number[] = [];
	const order = Math.min(payload.length - 1, MAX_ORDER);
	// RFC 3389, 4: a coefficient's byte is 127 for 0 and steps by 1/128
	for (let at = 1; at <= order; at++)
		reflections.push((payload[at] - 127) / 128);
	return { level: payload[0] & 0x7f, reflections };
}

/** the predictor of a filter given by its reflection coefficients (the step-up recursion) */
function predictor(reflections: number[]): Float64Array {
	const a = new Float64Array(reflections.length + 1);
	a[0] = 1;
	const previous = new Float64Array(reflections.length + 1);
	for (let order = 1; order <= reflections.length; order++) {
		const k = reflections[order - 1];
		previous.set(a);
		for (let i = 1; i < order; i++)
			a[i] = previous[i] + k * previous[order - i];
		a[order] = k;
	}
	return a;
}

/**
 * Noise to a description, at any rate: white noise through the
 * description's filter, scaled so that its power is the level's. The
 * filter's state carries over from one call to the next, and a new
 * description is moved to over a few blocks of 10 ms, as WebRTC's decoder
 * does.
 */
export class ComfortNoise {
	#rate: number;
	#target: NoiseDescription | null = null;
	/** what is being made now: the power and the coefficients, moving to the target's */
	#used: { power: number; reflections: number[] } | null = null;
	#state = new Float64Array(MAX_ORDER);
	/** a seeded generator: noise is noise, it needs no secret */
	#seed = 0x2545f491;

	constructor(rate: number) {
		this.#rate = rate;
	}

	get active(): boolean {
		return this.#target !== null;
	}

	/** a comfort noise packet arrived */
	update(description: NoiseDescription) {
		this.#target = description;
	}

	/** speech again: the noise stops, and the next one starts afresh */
	stop() {
		this.#target = null;
		this.#used = null;
		this.#state.fill(0);
	}

	#gauss(): number {
		// Box-Muller over a xorshift generator
		const uniform = () => {
			let x = this.#seed;
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			this.#seed = x >>> 0;
			return (this.#seed + 1) / 4294967297;
		};
		return (
			Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
		);
	}

	/** `frames` samples of the noise, between -1 and 1 */
	make(frames: number): Float32Array<ArrayBuffer> {
		const out = new Float32Array(frames);
		const target = this.#target;
		if (!target) return out;
		const power = 10 ** (-(target.level + PLAYED_BELOW) / 10);
		const reflections = [...target.reflections];
		while (reflections.length < MAX_ORDER) reflections.push(0);
		const block = Math.max(1, Math.round(this.#rate / 100));
		for (let from = 0; from < frames; from += block) {
			let keep = KEEP;
			if (!this.#used) {
				// a new period of noise starts at its description
				this.#used = { power, reflections: [...reflections] };
				keep = KEEP_NEW;
			}
			const used = this.#used;
			used.power = used.power * keep + power * (1 - keep);
			for (let i = 0; i < MAX_ORDER; i++)
				used.reflections[i] =
					used.reflections[i] * keep + reflections[i] * (1 - keep);
			const a = predictor(used.reflections);
			// white noise through the filter comes out with its power
			// divided by the prediction gain
			let gain = 1;
			for (const k of used.reflections) gain *= 1 - k * k;
			const scale = Math.sqrt(used.power * gain);
			const state = this.#state;
			const end = Math.min(frames, from + block);
			for (let at = from; at < end; at++) {
				let sample = scale * this.#gauss();
				for (let i = 1; i < a.length; i++) sample -= a[i] * state[i - 1];
				for (let i = MAX_ORDER - 1; i > 0; i--) state[i] = state[i - 1];
				state[0] = sample;
				out[at] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
			}
		}
		return out;
	}
}
