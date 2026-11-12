// G.722, the 16 kHz sub-band ADPCM codec at 64 kbit/s (mode 1): what a
// browser offers after Opus and before G.711 (payload 9, "G722/8000", the
// 8000 being RFC 3551's historical error kept for interop; the audio is
// 16 kHz and the RTP clock still ticks 8000 a second). WebCodecs has no
// G.722, so this is the codec in integer arithmetic. Every step follows the
// ITU-T G.191 reference (STL funcg722.c) operator for operator, saturation
// included, because the decoder's predictor runs on its own reconstruction:
// one rounding that differs from the far end's encoder and the two drift
// apart for the rest of the call. A call is one packet; the state that
// carries between packets lives on the encoder and decoder objects.

/** a 16-bit two's complement result, saturated as the reference's add/sub */
function sat(value: number) {
	return value > 32767 ? 32767 : value < -32768 ? -32768 : value;
}

/** the reference's mult: Q15 product, saturated (only -1 * -1 overflows) */
function mult(a: number, b: number) {
	return sat((a * b) >> 15);
}

/** the reconstructed sub-band signal is held to 15 bits */
function limit(value: number) {
	return value > 16383 ? 16383 : value < -16384 ? -16384 : value;
}

/** lower-band decision levels, already shifted left 3 as the reference does */
const Q6 = [
	0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714,
	786, 858, 940, 1023, 1121, 1219, 1339, 1458, 1612, 1765, 1980, 2195, 2557,
	2919, 3200,
].map((level) => level << 3);
/** the 6-bit code for a decision interval, positive then negative */
const MISIL = [
	[
		0x00, 0x3f, 0x3e, 0x1f, 0x1e, 0x1d, 0x1c, 0x1b, 0x1a, 0x19, 0x18, 0x17,
		0x16, 0x15, 0x14, 0x13, 0x12, 0x11, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b,
		0x0a, 0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x00,
	],
	[
		0x00, 0x3d, 0x3c, 0x3b, 0x3a, 0x39, 0x38, 0x37, 0x36, 0x35, 0x34, 0x33,
		0x32, 0x31, 0x30, 0x2f, 0x2e, 0x2d, 0x2c, 0x2b, 0x2a, 0x29, 0x28, 0x27,
		0x26, 0x25, 0x24, 0x23, 0x22, 0x21, 0x20, 0x00,
	],
];

// The 4-bit inverse quantizer feeds both predictors: the lower band's
// prediction must survive the bits a mode 2 or 3 channel drops, so it never
// sees the two least significant ones.
const RIL4 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0];
const OQ4 = [0, 150, 323, 530, 786, 1121, 1612, 2557];
/** log scale factor steps for the 4-bit lower-band magnitude */
const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042];

/** the 6-bit (mode 1) inverse quantizer, for the decoder's output only */
const RIL6 = [
	1, 1, 1, 1, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15,
	14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 30, 29, 28, 27, 26, 25, 24, 23, 22,
	21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 2,
	1,
];
const OQ6 = [
	0, 17, 54, 91, 130, 170, 211, 254, 300, 347, 396, 447, 501, 558, 618, 682,
	750, 822, 899, 982, 1072, 1170, 1279, 1399, 1535, 1689, 1873, 2088, 2376,
	2738, 3101,
];

const IH2 = [2, 1, 2, 1];
const OQ2 = [0, 202, 926];
const WH = [0, -214, 798];

/** the antilog table both scale factor adaptations read */
const ILA = [
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2,
	2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5,
	5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 9, 9, 9,
	9, 10, 10, 10, 10, 11, 11, 11, 11, 12, 12, 12, 13, 13, 13, 13, 14, 14, 15, 15,
	15, 16, 16, 16, 17, 17, 18, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23,
	24, 24, 25, 25, 26, 27, 27, 28, 28, 29, 30, 31, 31, 32, 33, 33, 34, 35, 36,
	37, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 54, 55,
	56, 57, 58, 60, 61, 63, 64, 65, 67, 68, 70, 71, 73, 75, 76, 78, 80, 82, 83,
	85, 87, 89, 91, 93, 95, 97, 99, 102, 104, 106, 109, 111, 113, 116, 118, 121,
	124, 127, 129, 132, 135, 138, 141, 144, 147, 151, 154, 157, 161, 165, 168,
	172, 176, 180, 184, 188, 192, 196, 200, 205, 209, 214, 219, 223, 228, 233,
	238, 244, 249, 255, 260, 266, 272, 278, 284, 290, 296, 303, 310, 316, 323,
	331, 338, 345, 353, 361, 369, 377, 385, 393, 402, 411, 420, 429, 439, 448,
	458, 468, 478, 489, 500, 511, 522, 533, 545, 557, 569, 582, 594, 607, 621,
	634, 648, 663, 677, 692, 707, 723, 739, 755, 771, 788, 806, 823, 841, 860,
	879, 898, 918, 938, 958, 979, 1001, 1023, 1045, 1068, 1092, 1115, 1140, 1165,
	1190, 1216, 1243, 1270, 1298, 1327, 1356, 1386, 1416, 1447, 1479, 1511, 1544,
	1578, 1613, 1648, 1684, 1721, 1759, 1797, 1837, 1877, 1918, 1960, 2003, 2047,
	2092, 2138, 2185, 2232, 2281, 2331, 2382, 2434, 2488, 2542, 2598, 2655, 2713,
	2773, 2833, 2895, 2959, 3024, 3090, 3157, 3227, 3297, 3370, 3443, 3519, 3596,
	3675, 3755, 3837, 3921, 4007, 4095,
];

/**
 * Transmit and receive QMF taps, in delay line order. The reference stores
 * each doubled and shifts the doubled sums back; these are the ITU values
 * and the shifts are one less, which is the same arithmetic.
 */
const QMF = [
	3, -11, -11, 53, 12, -156, 32, 362, -210, -805, 951, 3876, 3876, 951, -805,
	-210, 362, 32, -156, 12, 53, -11, -11, 3,
];

/** one sub-band's ADPCM state, as the reference's g722_state halves */
class Band {
	/** quantizer scale factor, and its log */
	det = 0;
	nb = 0;
	/** signal estimate, and its pole and zero parts */
	s = 0;
	sp = 0;
	sz = 0;
	/** pole and zero predictor coefficients (index 0 unused) */
	a = new Int16Array(3);
	b = new Int16Array(7);
	/** quantized differences, partial reconstructions, reconstructions */
	d = new Int16Array(7);
	p = new Int16Array(3);
	r = new Int16Array(3);
	#reset: number;
	constructor(det: number) {
		this.#reset = det;
		this.reset();
	}
	reset() {
		this.det = this.#reset;
		this.nb = this.s = this.sp = this.sz = 0;
		this.a.fill(0);
		this.b.fill(0);
		this.d.fill(0);
		this.p.fill(0);
		this.r.fill(0);
	}
	/** the predictor's update from a quantized difference (Block 4) */
	adapt(difference: number) {
		const { a, b, d, p, r } = this;
		d[0] = difference;
		p[0] = sat(difference + this.sz);
		r[0] = sat(this.s + difference);

		// upzero: sign-sign update of the zeros, and the delay line shift
		const step = difference === 0 ? 0 : 128;
		const sg0 = d[0] >> 15;
		for (let at = 6; at > 0; at--) {
			const wd2 = sg0 === d[at] >> 15 ? step : -step;
			b[at] = sat(wd2 + mult(b[at], 32640));
			d[at] = d[at - 1];
		}

		// uppol2, then uppol1 against the new second pole (its stability
		// bound depends on it)
		const sp0 = p[0] >> 15;
		const sp1 = p[1] >> 15;
		const sp2 = p[2] >> 15;
		const wd1 = sat(a[1] << 2);
		let a2 = sat(
			sat((sp0 === sp1 ? sat(-wd1) : wd1) >> 7) + (sp0 === sp2 ? 128 : -128),
		);
		a2 = sat(a2 + mult(a[2], 32512));
		if (a2 > 12288) a2 = 12288;
		if (a2 < -12288) a2 = -12288;
		a[2] = a2;
		let a1 = sat((sp0 === sp1 ? 192 : -192) + mult(a[1], 32640));
		const bound = sat(15360 - a2);
		if (a1 > bound) a1 = bound;
		else if (a1 + bound < 0) a1 = -bound;
		p[2] = p[1];
		p[1] = p[0];
		a[1] = a1;

		// filtez: each partial sum saturates, as the reference's add does
		let sz = 0;
		for (let at = 6; at > 0; at--)
			sz = sat(sz + mult(sat(d[at] + d[at]), b[at]));
		this.sz = sz;

		// filtep
		r[2] = r[1];
		r[1] = r[0];
		this.sp = sat(mult(a[1], sat(r[1] + r[1])) + mult(a[2], sat(r[2] + r[2])));
		this.s = sat(this.sp + this.sz);
	}
}

/** lower band: quantized difference from a 6-bit code, and scale update */
function lowerAdapt(band: Band, code: number) {
	const ril = code >> 2;
	const magnitude = OQ4[RIL4[ril]] << 3;
	const difference = mult(
		band.det,
		ril < 8 && ril > 0 ? -magnitude : magnitude,
	);
	let nb = sat(mult(band.nb, 32512) + WL[RIL4[ril]]);
	if (nb < 0) nb = 0;
	if (nb > 18432) nb = 18432;
	band.nb = nb;
	band.det = (ILA[((nb >> 6) & 511) + 64] + 1) << 2;
	band.adapt(difference);
}

/** higher band: quantized difference from a 2-bit code, and scale update */
function higherAdapt(band: Band, code: number) {
	const magnitude = OQ2[IH2[code]] << 3;
	const difference = mult(code < 2 ? -magnitude : magnitude, band.det);
	let nb = sat(mult(band.nb, 32512) + WH[IH2[code]]);
	if (nb < 0) nb = 0;
	if (nb > 22528) nb = 22528;
	band.nb = nb;
	band.det = (ILA[(nb >> 6) & 511] + 1) << 2;
	band.adapt(difference);
}

function lowerEncode(band: Band, xl: number) {
	const el = sat(xl - band.s);
	// the magnitude of a negative difference is one less, as -(el + 1)
	const wd = el < 0 ? 32767 - (el & 32767) : el;
	let interval = 0;
	while (mult(Q6[interval], band.det) <= wd && interval < 30) interval++;
	const code = MISIL[el < 0 ? 0 : 1][interval];
	lowerAdapt(band, code);
	return code;
}

function higherEncode(band: Band, xh: number) {
	const eh = sat(xh - band.s);
	const wd = eh < 0 ? 32767 - (eh & 32767) : eh;
	const outer = wd >= mult(564 << 3, band.det);
	const code = eh < 0 ? (outer ? 0 : 1) : outer ? 2 : 3;
	higherAdapt(band, code);
	return code;
}

function lowerDecode(band: Band, code: number) {
	// the output takes all six bits, the predictor (in lowerAdapt) four
	const magnitude = OQ6[RIL6[code]] << 3;
	const negative = code < 32 || code >= 62;
	const out = limit(
		sat(band.s + mult(band.det, negative ? -magnitude : magnitude)),
	);
	lowerAdapt(band, code);
	return out;
}

function higherDecode(band: Band, code: number) {
	higherAdapt(band, code);
	return limit(band.r[0]);
}

/** 16 kHz samples in, one byte per two of them out */
export class G722Encoder {
	#low = new Band(32);
	#high = new Band(8);
	/** the QMF delay line, newest first */
	#x = new Int32Array(24);
	/** an odd sample left over from the last call, waiting for its pair */
	#pending: number | null = null;
	reset() {
		this.#low.reset();
		this.#high.reset();
		this.#x.fill(0);
		this.#pending = null;
	}
	/** a byte for every two samples; an odd one waits for the next call */
	encode(samples: Int16Array): Uint8Array {
		const pending = this.#pending === null ? 0 : 1;
		const total = samples.length + pending;
		const out = new Uint8Array(total >> 1);
		let at = 0;
		for (let made = 0; made < out.length; made++) {
			let first: number;
			if (made === 0 && this.#pending !== null) first = this.#pending;
			else first = samples[at++];
			out[made] = this.#pair(first, samples[at++]);
		}
		// an empty call leaves a waiting sample waiting
		if (samples.length)
			this.#pending = total & 1 ? samples[samples.length - 1] : null;
		return out;
	}
	#pair(first: number, second: number) {
		const x = this.#x;
		x[1] = first;
		x[0] = second;
		let even = 0;
		let odd = 0;
		for (let at = 0; at < 24; at += 2) {
			even += QMF[at] * x[at];
			odd += QMF[at + 1] * x[at + 1];
		}
		x.copyWithin(2, 0, 22);
		// the reference holds the sub-bands to 15 bits here, which only
		// full-scale input with overshoot reaches; ffmpeg's encoder does not,
		// so on such input its codes differ from the reference's (check.mjs)
		const xl = limit((even + odd) >> 14);
		const xh = limit((even - odd) >> 14);
		return (higherEncode(this.#high, xh) << 6) | lowerEncode(this.#low, xl);
	}
	/**
	 * One code from sub-band samples, bypassing the QMF: the ITU digital test
	 * sequences drive the ADPCM this way, and nothing else should.
	 */
	encodeSubbands(xl: number, xh: number) {
		return (higherEncode(this.#high, xh) << 6) | lowerEncode(this.#low, xl);
	}
}

/** one byte in, two 16 kHz samples out */
export class G722Decoder {
	#low = new Band(32);
	#high = new Band(8);
	#x = new Int32Array(24);
	reset() {
		this.#low.reset();
		this.#high.reset();
		this.#x.fill(0);
	}
	decode(bytes: Uint8Array): Int16Array {
		const out = new Int16Array(bytes.length * 2);
		const x = this.#x;
		for (let at = 0; at < bytes.length; at++) {
			const rl = lowerDecode(this.#low, bytes[at] & 0x3f);
			const rh = higherDecode(this.#high, bytes[at] >> 6);
			x[1] = sat(rl + rh);
			x[0] = sat(rl - rh);
			let even = 0;
			let odd = 0;
			for (let tap = 0; tap < 24; tap += 2) {
				even += QMF[tap] * x[tap];
				odd += QMF[tap + 1] * x[tap + 1];
			}
			x.copyWithin(2, 0, 22);
			out[at * 2] = sat(even >> 11);
			out[at * 2 + 1] = sat(odd >> 11);
		}
		return out;
	}
	/** the two sub-band reconstructions of one code, bypassing the QMF */
	decodeSubbands(code: number): [low: number, high: number] {
		const rl = lowerDecode(this.#low, code & 0x3f);
		return [rl, higherDecode(this.#high, (code >> 6) & 3)];
	}
}

/** 16 kHz samples between -1 and 1 as G.722 bytes */
export function g722Encode(encoder: G722Encoder, samples: Float32Array) {
	const scaled = new Int16Array(samples.length);
	for (let at = 0; at < samples.length; at++)
		scaled[at] = sat(Math.round(samples[at] * 32767));
	return encoder.encode(scaled);
}

/** G.722 bytes as 16 kHz samples between -1 and 1 */
export function g722Decode(decoder: G722Decoder, bytes: Uint8Array) {
	const samples = decoder.decode(bytes);
	const out = new Float32Array(samples.length);
	for (let at = 0; at < samples.length; at++) out[at] = samples[at] / 32768;
	return out;
}
