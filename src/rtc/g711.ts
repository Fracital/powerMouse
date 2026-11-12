// G.711, the two companded 8 kHz codecs every WebRTC offer of a browser
// lists after Opus (PCMU, mu-law, and PCMA, A-law): what a peer without
// Opus speaks, a telephony gateway mostly. One byte a sample, so the codec
// is two functions each way; WebCodecs decodes both and encodes neither.

const BIAS = 0x84;
const CLIP = 32635;

/** a 16-bit sample as a mu-law byte */
export function ulawEncode(sample: number): number {
	const sign = sample < 0 ? 0x80 : 0;
	if (sign) sample = -sample;
	if (sample > CLIP) sample = CLIP;
	sample += BIAS;
	let exponent = 7;
	for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1)
		exponent--;
	const mantissa = (sample >> (exponent + 3)) & 0x0f;
	return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawDecode(byte: number): number {
	byte = ~byte & 0xff;
	const exponent = (byte >> 4) & 7;
	const sample = (((byte & 0x0f) << 3) + BIAS) << exponent;
	return byte & 0x80 ? BIAS - sample : sample - BIAS;
}

/** the top of each A-law segment, for a 13-bit magnitude */
const SEGMENT_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

/** a 16-bit sample as an A-law byte */
export function alawEncode(sample: number): number {
	let value = sample >> 3;
	let mask = 0xd5;
	if (value < 0) {
		mask = 0x55;
		value = -value - 1;
	}
	let segment = 0;
	while (segment < 8 && value > SEGMENT_END[segment]) segment++;
	if (segment >= 8) return 0x7f ^ mask;
	const low = segment < 2 ? (value >> 1) & 0x0f : (value >> segment) & 0x0f;
	return ((segment << 4) | low) ^ mask;
}

export function alawDecode(byte: number): number {
	byte ^= 0x55;
	const segment = (byte & 0x70) >> 4;
	let sample = (byte & 0x0f) << 4;
	if (segment === 0) sample += 8;
	else sample = (sample + 0x108) << (segment - 1);
	return byte & 0x80 ? sample : -sample;
}

/** a packet of either law as samples between -1 and 1 */
export function g711Decode(law: 'PCMU' | 'PCMA', bytes: Uint8Array) {
	const decode = law === 'PCMU' ? ulawDecode : alawDecode;
	const out = new Float32Array(bytes.length);
	for (let at = 0; at < bytes.length; at++) out[at] = decode(bytes[at]) / 32768;
	return out;
}

/** samples between -1 and 1 as a packet of either law */
export function g711Encode(law: 'PCMU' | 'PCMA', samples: Float32Array) {
	const encode = law === 'PCMU' ? ulawEncode : alawEncode;
	const out = new Uint8Array(samples.length);
	for (let at = 0; at < samples.length; at++) {
		const scaled = Math.round(samples[at] * 32767);
		out[at] = encode(
			scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled,
		);
	}
	return out;
}

/**
 * A stream of samples at one rate as a stream at a lower one: each output
 * sample is the mean of the input it spans (a box filter, which is enough
 * above telephone bandwidth, and exact when the rates divide).
 */
export class Downsampler {
	#step: number;
	/** how much input the output sample being built still wants */
	#want: number;
	#sum = 0;
	constructor(from: number, to: number) {
		this.#step = from / to;
		this.#want = this.#step;
	}
	push(input: Float32Array): Float32Array {
		const out = new Float32Array(Math.ceil(input.length / this.#step) + 1);
		let made = 0;
		for (let at = 0; at < input.length; at++) {
			if (this.#want >= 1) {
				this.#sum += input[at];
				this.#want -= 1;
			} else {
				// the sample straddles two output samples
				this.#sum += input[at] * this.#want;
				out[made++] = this.#sum / this.#step;
				this.#sum = input[at] * (1 - this.#want);
				this.#want = this.#step - (1 - this.#want);
			}
			if (this.#want <= 1e-9) {
				out[made++] = this.#sum / this.#step;
				this.#sum = 0;
				this.#want = this.#step;
			}
		}
		return out.subarray(0, made);
	}
}
