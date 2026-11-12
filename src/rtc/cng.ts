// WebRTC's comfort noise encoder and the framing Chrome wraps around G.711
// and G.722 when comfort noise is negotiated, bit-exact. Mirrors WebRTC's
// modules/audio_coding/codecs/cng/{webrtc_cng.cc,audio_encoder_cng.cc} and
// the common_audio/signal_processing helpers they call (auto_correlation,
// get_hanning_window, levinson_durbin, division_operations), at revision
// 24d4c4c6 (identical at Chrome 152's and 156's). Ported from WebRTC,
// BSD-3-Clause, Copyright (c) 2011 The WebRTC project authors.

import { divW32W16, energy, energyShifts, normW32, s16, Vad } from './vad';

// webrtc_cng.cc: the energy (Q0 per sample) each -dBov level starts at
const DBOV = [
	1081109975, 858756178, 682134279, 541838517, 430397633, 341876992, 271562548,
	215709799, 171344384, 136103682, 108110997, 85875618, 68213428, 54183852,
	43039763, 34187699, 27156255, 21570980, 17134438, 13610368, 10811100, 8587562,
	6821343, 5418385, 4303976, 3418770, 2715625, 2157098, 1713444, 1361037,
	1081110, 858756, 682134, 541839, 430398, 341877, 271563, 215710, 171344,
	136104, 108111, 85876, 68213, 54184, 43040, 34188, 27156, 21571, 17134, 13610,
	10811, 8588, 6821, 5418, 4304, 3419, 2716, 2157, 1713, 1361, 1081, 859, 682,
	542, 430, 342, 272, 216, 171, 136, 108, 86, 68, 54, 43, 34, 27, 22, 17, 14,
	11, 9, 7, 5, 4, 3, 3, 2, 2, 1, 1, 1, 1, 1,
];
// lag window applied to the autocorrelation (bandwidth expansion), Q15
const CORR_WINDOW = [
	32702, 32636, 32570, 32505, 32439, 32374, 32309, 32244, 32179, 32114, 32049,
	31985,
];
/** WebRtcSpl_GetHanningWindow's table, its first half, Q14 */
const HANNING = new Int16Array(
	(
		'1,2,6,10,15,22,30,39,50,62,75,89,104,121,138,157,178,199,222,246,271,' +
		'297,324,353,383,413,446,479,513,549,586,624,663,703,744,787,830,875,' +
		'920,967,1015,1064,1114,1165,1218,1271,1325,1381,1437,1494,1553,1612,' +
		'1673,1734,1796,1859,1924,1989,2055,2122,2190,2259,2329,2399,2471,2543,' +
		'2617,2691,2765,2841,2918,2995,3073,3152,3232,3312,3393,3475,3558,3641,' +
		'3725,3809,3895,3980,4067,4154,4242,4330,4419,4509,4599,4689,4781,4872,' +
		'4964,5057,5150,5244,5338,5432,5527,5622,5718,5814,5910,6007,6104,6202,' +
		'6299,6397,6495,6594,6693,6791,6891,6990,7090,7189,7289,7389,7489,7589,' +
		'7690,7790,7890,7991,8091,8192,8293,8393,8494,8594,8694,8795,8895,8995,' +
		'9095,9195,9294,9394,9493,9593,9691,9790,9889,9987,10085,10182,10280,' +
		'10377,10474,10570,10666,10762,10857,10952,11046,11140,11234,11327,' +
		'11420,11512,11603,11695,11785,11875,11965,12054,12142,12230,12317,' +
		'12404,12489,12575,12659,12743,12826,12909,12991,13072,13152,13232,' +
		'13311,13389,13466,13543,13619,13693,13767,13841,13913,13985,14055,' +
		'14125,14194,14262,14329,14395,14460,14525,14588,14650,14711,14772,' +
		'14831,14890,14947,15003,15059,15113,15166,15219,15270,15320,15369,' +
		'15417,15464,15509,15554,15597,15640,15681,15721,15760,15798,15835,' +
		'15871,15905,15938,15971,16001,16031,16060,16087,16113,16138,16162,' +
		'16185,16206,16227,16246,16263,16280,16295,16309,16322,16334,16345,' +
		'16354,16362,16369,16374,16378,16382,16383,16384'
	)
		.split(',')
		.map(Number),
);
/** WebRTC's limit on coefficients, and the order 12 SID byte quirk */
const MAX_ORDER = 12;
/** ComfortNoiseEncoder takes at most 640 samples a call */
const MAX_SAMPLES = 640;

/** Levinson-Durbin's scratch: R, A and the next A, each in hi and low */
const LEVINSON = Array.from({ length: 6 }, () => new Int16Array(MAX_ORDER + 1));

/** a 32 bit value's high half, in WebRTC's hi/low split */
const hi = (x: number): number => x >> 16;
/** its low half, Q(-1) */
const lo = (x: number): number => (x & 0xffff) >> 1;
const abs32 = (x: number): number => (x < 0 ? -x | 0 : x);

/** WebRtcSpl_DivW32HiLow: num / den in Q31, den in hi/low */
function divHiLow(num: number, denHi: number, denLow: number): number {
	const approx = s16(divW32W16(0x1fffffff, denHi));
	let t =
		((Math.imul(denHi, approx) << 1) + (((denLow * approx) >> 15) << 1)) | 0;
	t = (0x7fffffff - t) | 0;
	t = (Math.imul(hi(t), approx) + ((lo(t) * approx) >> 15)) << 1;
	const nh = hi(num);
	const nl = lo(num);
	t = (Math.imul(nh, hi(t)) + ((nh * lo(t)) >> 15) + ((nl * hi(t)) >> 15)) | 0;
	return t << 3;
}

/** a hi/low value times (1 - k^2), k in hi/low, all Q31 */
function timesOneMinusK2(
	h: number,
	l: number,
	kHi: number,
	kLow: number,
): number {
	let t = (((kHi * kLow) >> 14) + kHi * kHi) << 1;
	t = (0x7fffffff - abs32(t)) | 0;
	return (Math.imul(h, hi(t)) + ((h * lo(t)) >> 15) + ((l * hi(t)) >> 15)) << 1;
}

/**
 * WebRtcSpl_LevinsonDurbin, reflection coefficients only (the encoder
 * never reads the polynomial): 0 when the filter comes out unstable
 */
function levinson(r: Int32Array, k: Int16Array, order: number): number {
	const [rHi, rLow, aHi, aLow, uHi, uLow] = LEVINSON;
	let norm = normW32(r[0]);
	for (let i = 0; i <= order; i++) {
		const t = r[i] << norm;
		rHi[i] = hi(t);
		rLow[i] = lo(t);
	}
	const t2 = r[1] << norm;
	let t1 = divHiLow(abs32(t2), rHi[0], rLow[0]);
	if (t2 > 0) t1 = -t1 | 0;
	let kHi = hi(t1);
	let kLow = lo(t1);
	k[0] = kHi;
	t1 >>= 4;
	aHi[1] = hi(t1);
	aLow[1] = lo(t1);
	t1 = timesOneMinusK2(rHi[0], rLow[0], kHi, kLow);
	let alphaExp = normW32(t1);
	t1 <<= alphaExp;
	let alphaHi = hi(t1);
	let alphaLow = lo(t1);
	for (let i = 2; i <= order; i++) {
		t1 = 0;
		for (let j = 1; j < i; j++) {
			const p = rHi[j] * aHi[i - j];
			const q = ((rHi[j] * aLow[i - j]) >> 15) + ((rLow[j] * aHi[i - j]) >> 15);
			t1 = (t1 + (p << 1) + (q << 1)) | 0;
		}
		t1 = ((t1 << 4) + (rHi[i] << 16) + (rLow[i] << 1)) | 0;
		let t3 = divHiLow(abs32(t1), alphaHi, alphaLow);
		if (t1 > 0) t3 = -t3 | 0;
		norm = normW32(t3);
		if (alphaExp <= norm || t3 === 0) t3 <<= alphaExp;
		else t3 = t3 > 0 ? 0x7fffffff : -0x80000000;
		kHi = hi(t3);
		kLow = lo(t3);
		k[i - 1] = kHi;
		if (Math.abs(kHi) > 32750) return 0;
		for (let j = 1; j < i; j++) {
			const q =
				kHi * aHi[i - j] +
				((kHi * aLow[i - j]) >> 15) +
				((kLow * aHi[i - j]) >> 15);
			t1 = ((aHi[j] << 16) + (aLow[j] << 1) + (q << 1)) | 0;
			uHi[j] = hi(t1);
			uLow[j] = lo(t1);
		}
		t3 >>= 4;
		uHi[i] = hi(t3);
		uLow[i] = lo(t3);
		t1 = timesOneMinusK2(alphaHi, alphaLow, kHi, kLow);
		norm = normW32(t1);
		t1 <<= norm;
		alphaHi = hi(t1);
		alphaLow = lo(t1);
		alphaExp = s16(alphaExp + norm);
		aHi.set(uHi.subarray(1, i + 1), 1);
		aLow.set(uLow.subarray(1, i + 1), 1);
	}
	return 1;
}

/** WebRTC's ComfortNoiseEncoder: SID payloads (RFC 3389) from 10 ms blocks */
export class ComfortNoiseEncoder {
	readonly rate: number;
	readonly interval: number;
	readonly order: number;
	// enc_msSinceSid_, enc_Energy_, enc_reflCoefs_
	msSinceSid = 0;
	energy = 0;
	readonly reflections = new Int16Array(MAX_ORDER);
	private readonly speech = new Int16Array(MAX_SAMPLES);
	private readonly window = new Int16Array(MAX_SAMPLES);
	private readonly corr = new Int32Array(MAX_ORDER + 1);
	private readonly k = new Int16Array(MAX_ORDER);

	/** rate of the audio, SID interval in ms, coefficients 1 to 12 */
	constructor(rate: number, interval = 100, order = 8) {
		if (!(order > 0 && order <= MAX_ORDER))
			throw new RangeError('comfort noise takes 1 to 12 coefficients');
		this.rate = rate;
		this.interval = s16(interval);
		this.order = order;
	}

	reset(): void {
		this.msSinceSid = this.energy = 0;
		this.reflections.fill(0);
	}

	/**
	 * Takes in the noise of one block; a SID payload when one is due (the
	 * interval passed, or forceSid), else null. forceSid also takes this
	 * block's level and shape as they are instead of averaging them in.
	 */
	encode(block: Int16Array, forceSid: boolean): Uint8Array | null {
		const n = block.length;
		if (n > MAX_SAMPLES) throw new RangeError('block over 640 samples');
		const { speech, window, corr, k, order, reflections } = this;
		speech.set(block);
		let factor = n;
		let e = energy(speech, n);
		let shifts = energyShifts;
		// at most 5 shifts go into the divisor, the rest back into e
		while (shifts > 0) {
			if (shifts > 5) {
				e <<= shifts - 5;
				shifts = 5;
			} else {
				factor >>>= 1;
				shifts--;
			}
		}
		e = divW32W16(e, factor);
		if (e > 1) {
			hanning(window, n >> 1);
			for (let i = 0; i < n >> 1; i++) window[n - i - 1] = window[i];
			for (let i = 0; i < n; i++) speech[i] = (speech[i] * window[i]) >> 14;
			autoCorrelation(speech, n, order, corr);
			if (corr[0] === 0) corr[0] = 32767;
			// bandwidth expansion: |corr| times the window, in 16 bit halves
			// (and, as WebRTC has it, not for the last lag)
			for (let i = 0; i < order; i++) {
				const w = CORR_WINDOW[i];
				const neg = corr[i] < 0;
				const b = neg ? -corr[i] | 0 : corr[i];
				let blo = Math.imul(w, b & 0xffff);
				const bhi = ((blo >> 16) & 0xffff) + Math.imul(w, (b >> 16) & 0xffff);
				blo = (blo & 0xffff) | ((bhi & 0xffff) << 16);
				const v = (((bhi >> 16) & 0x7fff) << 17) | (blo >>> 15);
				corr[i] = neg ? -v | 0 : v;
			}
			// an unstable frame is dropped: no state change, no time counted
			if (!levinson(corr, k, order)) return null;
		} else {
			k.fill(0);
		}
		if (forceSid) {
			reflections.set(k.subarray(0, order));
			this.energy = e;
		} else {
			// average: 0.6 of the old coefficients, 0.4 of the new
			for (let i = 0; i < order; i++)
				reflections[i] =
					s16((reflections[i] * 19661) >> 15) + s16((k[i] * 13107) >> 15);
			const old = this.energy;
			this.energy = ((e >> 2) + (old >> 1) + (old >> 2)) | 0;
		}
		if (this.energy < 1) this.energy = 1;
		const ms = Math.floor((1000 * n) / this.rate);
		if (this.msSinceSid > this.interval - 1 || forceSid) {
			// the first level the energy is above; 94 when below all of them
			let index = 0;
			let i = 1;
			for (; i < 93; i++) {
				if (((this.energy - DBOV[i]) | 0) > 0) {
					index = i;
					break;
				}
			}
			if (i === 93 && index === 0) index = 94;
			const out = new Uint8Array(order + 1);
			out[0] = index;
			// Q15 to Q7, rounded; WebRTC offsets them by 127 except at order 12
			const bias = order === MAX_ORDER ? 0 : 127;
			for (let j = 0; j < order; j++)
				out[j + 1] = bias + ((reflections[j] + 128) >> 8);
			this.msSinceSid = s16(ms);
			return out;
		}
		this.msSinceSid = s16(this.msSinceSid + ms);
		return null;
	}
}

/** WebRtcSpl_GetHanningWindow: the rising half, size samples */
function hanning(v: Int16Array, size: number): void {
	const factor = divW32W16(0x40000000, size);
	let index = size < 513 ? -0x200000 : -0x100000;
	for (let i = 0; i < size; i++) {
		index = (index + factor) | 0;
		v[i] = HANNING[index >> 22];
	}
}

/** WebRtcSpl_AutoCorrelation, lags 0 to order */
function autoCorrelation(
	x: Int16Array,
	n: number,
	order: number,
	out: Int32Array,
): void {
	let smax = 0;
	for (let i = 0; i < n; i++) smax = Math.max(smax, Math.abs(x[i]));
	if (smax > 32767) smax = 32767;
	let sh = 0;
	if (smax !== 0) {
		const bits = 32 - Math.clz32(n);
		const t = normW32(smax * smax);
		sh = t > bits ? 0 : bits - t;
	}
	for (let i = 0; i <= order; i++) {
		let sum = 0;
		for (let j = 0; j < n - i; j++) sum = (sum + ((x[j] * x[i + j]) >> sh)) | 0;
		out[i] = sum;
	}
}

/** what one packet of audio becomes */
export interface CngPacket {
	/** RTP timestamp of the packet's first block */
	timestamp: number;
	/** the packet's audio for the speech codec, null when passive */
	speech: Int16Array | null;
	/** a passive packet's SID payload when one goes out now, else null */
	sid: Uint8Array | null;
}

/**
 * AudioEncoderCng's framing: buffers 10 ms blocks into packets, asks the
 * VAD about each packet and sends speech, a SID, or nothing in its place.
 */
export class CngFramer {
	readonly rate: number;
	readonly blocks: number;
	private readonly vad: Vad;
	private readonly cng: ComfortNoiseEncoder;
	private readonly block: number;
	private readonly buffer: Int16Array;
	private readonly timestamps: number[] = [];
	private lastActive = true;

	/**
	 * rate is the speech codec's (8000 for G.711, 16000 for G.722), blocks
	 * the 10 ms blocks a packet holds (2 for 20 ms). Chrome's other values:
	 * VAD mode 0 (kVadNormal), SID every 100 ms, 8 coefficients.
	 */
	constructor(
		rate: number,
		blocks = 2,
		{ vadMode = 0, sidIntervalMs = 100, coefficients = 8 } = {},
	) {
		// AudioEncoderCngConfig::IsOk and the 60 ms cap of EncodeImpl
		if (
			(rate !== 8000 && rate !== 16000) ||
			blocks < 1 ||
			blocks > 6 ||
			sidIntervalMs < blocks * 10
		)
			throw new RangeError('bad comfort noise configuration');
		this.rate = rate;
		this.blocks = blocks;
		this.block = rate / 100;
		this.buffer = new Int16Array(this.block * blocks);
		this.vad = new Vad(vadMode);
		this.cng = new ComfortNoiseEncoder(rate, sidIntervalMs, coefficients);
	}

	/** AudioEncoderCng::Reset, which resets the speech codec too */
	reset(): void {
		this.timestamps.length = 0;
		this.lastActive = true;
		this.vad.reset();
		this.cng.reset();
	}

	/** one 10 ms block and its RTP timestamp; a packet once one is full */
	push(block: Int16Array, timestamp: number): CngPacket | null {
		const { timestamps, buffer, blocks } = this;
		const size = this.block;
		if (block.length !== size) throw new RangeError('block is not 10 ms');
		buffer.set(block, timestamps.length * size);
		timestamps.push(timestamp >>> 0);
		if (timestamps.length < blocks) return null;
		// one VAD call, or two where a call would pass 30 ms: 40 ms as 20 +
		// 20, 50 as 30 + 20, 60 as 30 + 30; the second only if the first
		// found no speech
		const first = blocks === 4 ? 2 : Math.min(blocks, 3);
		let active = this.vad.process(buffer.subarray(0, first * size), this.rate);
		if (!active && blocks > first)
			active = this.vad.process(buffer.subarray(first * size), this.rate);
		const ts = timestamps[0];
		timestamps.length = 0;
		if (active) {
			this.lastActive = true;
			return { timestamp: ts, speech: buffer.slice(), sid: null };
		}
		// the first passive packet after speech forces a SID; a packet has
		// at most one, its blocks after a SID go on unforced, and a block
		// dropped as unstable passes the force on to the next
		let force = this.lastActive;
		let sid: Uint8Array | null = null;
		for (let i = 0; i < blocks; i++) {
			const out = this.cng.encode(
				buffer.subarray(i * size, (i + 1) * size),
				force,
			);
			if (out) {
				sid = out;
				force = false;
			}
		}
		this.lastActive = false;
		return { timestamp: ts, speech: null, sid };
	}
}
