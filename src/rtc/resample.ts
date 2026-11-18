// A stream of sound at one rate as a stream at another, as soon as it can
// be: 16 input samples late (0.36 ms at 44.1 kHz), so that the output of
// each input block is made with it, the block's last sample's included
// (a filter centred on each output sample needs the 16 input samples
// after it: made on time, the last of a block's output waits for the next
// block, 10 ms later). WebCodecs' Opus encoder takes only Opus's own rates without delay:
// given 44.1 kHz (a fake capture device's, and many microphones' and
// output devices'), 22.05, 32 or 96 kHz, it held each frame 10 to 40 ms
// past its last sample before handing it out, so the worker gives it 48
// kHz made here. The filter is Chrome's SincResampler's (media/base): a
// windowed sinc of 32 taps, a Blackman window, its cutoff 0.9 of the lower
// rate's Nyquist frequency, the taps for a fraction of a sample between 32
// precomputed fractions interpolated.

const TAPS = 32;
const HALF = TAPS / 2;
const FRACTIONS = 32;
/** the window's alpha (Chrome's 0.16: a Blackman window) */
const ALPHA = 0.16;
const CUTOFF = 0.9;

function kernels(scale: number): Float32Array {
	const table = new Float32Array((FRACTIONS + 1) * TAPS);
	const a0 = (1 - ALPHA) / 2;
	const a2 = ALPHA / 2;
	for (let fraction = 0; fraction <= FRACTIONS; fraction++) {
		const offset = fraction / FRACTIONS;
		for (let tap = 0; tap < TAPS; tap++) {
			// the tap's distance from the output sample, in input samples
			const x = tap - (HALF - 1) - offset;
			const t = (tap + 1 - offset) / TAPS;
			const window =
				a0 - 0.5 * Math.cos(2 * Math.PI * t) + a2 * Math.cos(4 * Math.PI * t);
			const sinc =
				x === 0 ? scale : Math.sin(Math.PI * scale * x) / (Math.PI * x);
			table[fraction * TAPS + tap] = window * sinc;
		}
	}
	return table;
}

export class Resampler {
	#step: number;
	#table: Float32Array;
	#channels: number;
	/** each channel's input still needed: from 15 samples before the next output's place */
	#held: Float32Array[];
	#length: number;
	/** where the next output sample is, in input samples from the first held */
	#at: number;
	constructor(from: number, to: number, channels: number) {
		this.#step = from / to;
		this.#table = kernels(Math.min(1, to / from) * CUTOFF);
		this.#channels = channels;
		// the first output is 16 samples before the first input sample:
		// silence before it
		this.#held = Array.from({ length: channels }, () => new Float32Array(4096));
		this.#length = TAPS - 1;
		this.#at = HALF - 1;
	}

	/** `frames` samples of each channel, one plane after the other; returns the same at the new rate */
	push(
		input: Float32Array,
		frames: number,
	): { samples: Float32Array<ArrayBuffer>; frames: number } {
		const channels = this.#channels;
		if (this.#length + frames > this.#held[0].length)
			this.#held = this.#held.map((plane) => {
				const grown = new Float32Array((this.#length + frames) * 2);
				grown.set(plane.subarray(0, this.#length));
				return grown;
			});
		for (let channel = 0; channel < channels; channel++)
			this.#held[channel].set(
				input.subarray(channel * frames, (channel + 1) * frames),
				this.#length,
			);
		this.#length += frames;
		const step = this.#step;
		const table = this.#table;
		// outputs whose last tap has come
		let made = 0;
		let at = this.#at;
		while (Math.floor(at) + HALF < this.#length) {
			made++;
			at += step;
		}
		const out = new Float32Array(made * channels);
		for (let channel = 0; channel < channels; channel++) {
			const held = this.#held[channel];
			let position = this.#at;
			for (let index = 0; index < made; index++, position += step) {
				const base = Math.floor(position);
				const place = (position - base) * FRACTIONS;
				const fraction = Math.floor(place);
				const mix = place - fraction;
				const low = fraction * TAPS;
				const high = low + TAPS;
				const first = base - (HALF - 1);
				let lowSum = 0;
				let highSum = 0;
				for (let tap = 0; tap < TAPS; tap++) {
					const sample = held[first + tap];
					lowSum += sample * table[low + tap];
					highSum += sample * table[high + tap];
				}
				out[channel * made + index] = lowSum + (highSum - lowSum) * mix;
			}
		}
		// what the next output needs is kept
		const drop = Math.floor(at) - (HALF - 1);
		if (drop > 0) {
			for (const plane of this.#held) plane.copyWithin(0, drop, this.#length);
			this.#length -= drop;
			at -= drop;
		}
		this.#at = at;
		return { samples: out, frames: made };
	}
}
