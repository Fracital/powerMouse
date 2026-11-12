// WebRTC's voice activity detector, bit-exact, as Chrome's comfort noise
// path runs it (AudioEncoderCng at 8 or 16 kHz). Mirrors WebRTC's
// common_audio/vad/{webrtc_vad.c,vad_core.c,vad_filterbank.c,vad_gmm.c,
// vad_sp.c,vad.cc} and the common_audio/signal_processing helpers they
// call, at revision 24d4c4c6 (identical at Chrome 152's and 156's).
// Ported from WebRTC, BSD-3-Clause, Copyright (c) 2011 The WebRTC project
// authors. All integer steps keep C's int16/int32 truncation and wrap.

/** C's (int16_t) cast */
export const s16 = (x: number): number => (x << 16) >> 16;

/** WebRtcSpl_NormW32: left shifts a can take without overflow */
export const normW32 = (a: number): number =>
	a === 0 ? 0 : Math.clz32(a < 0 ? ~a : a) - 1;

const sizeInBits = (n: number): number => 32 - Math.clz32(n);

/** WebRtcSpl_DivW32W16: den arrives cast to int16, 0 gives INT32_MAX */
export const divW32W16 = (num: number, den: number): number => {
	den = s16(den);
	return den === 0 ? 0x7fffffff : (num / den) | 0;
};

/** WebRtcSpl_Energy's scale factor, set by each energy() call */
export let energyShifts = 0;

/** WebRtcSpl_Energy with WebRtcSpl_GetScalingSquare */
export function energy(v: Int16Array, n: number): number {
	let smax = -1;
	for (let i = 0; i < n; i++) {
		// sabs is an int16_t there, so -32768 stays -32768 and never counts
		const a = s16(v[i] > 0 ? v[i] : -v[i]);
		if (a > smax) smax = a;
	}
	const t = normW32(Math.imul(smax, smax));
	const bits = sizeInBits(n);
	const sh = smax === 0 || t > bits ? 0 : bits - t;
	let en = 0;
	for (let i = 0; i < n; i++) en = (en + ((v[i] * v[i]) >> sh)) | 0;
	energyShifts = sh;
	return en;
}

// vad_core.c's model: 6 bands, 2 Gaussians each, indexed band + 6 * k
const NOISE_WEIGHTS = [34, 62, 72, 66, 53, 25, 94, 66, 56, 62, 75, 103];
const SPEECH_WEIGHTS = [48, 82, 45, 87, 50, 47, 80, 46, 83, 41, 78, 81];
const NOISE_MEANS = [
	6738, 4892, 7065, 6715, 6771, 3369, 7646, 3863, 7820, 7266, 5020, 4362,
];
const SPEECH_MEANS = [
	8306, 10085, 10078, 11823, 11843, 6309, 9473, 9571, 10879, 7581, 8180, 7483,
];
const NOISE_STDS = [
	378, 1064, 493, 582, 688, 593, 474, 697, 475, 688, 421, 455,
];
const SPEECH_STDS = [
	555, 505, 567, 524, 585, 1231, 509, 828, 492, 1540, 1079, 850,
];
const SPECTRUM_WEIGHT = [6, 8, 10, 12, 14, 16];
const MINIMUM_DIFFERENCE = [544, 544, 576, 576, 576, 576];
const MAXIMUM_SPEECH = [11392, 11392, 11520, 11520, 11520, 11520];
const MAXIMUM_NOISE = [9216, 9088, 8960, 8832, 8704, 8576];
const MINIMUM_MEAN = [640, 768];
const MIN_STD = 384;
const MIN_ENERGY = 10;
// WebRtcVad_set_mode_core's tables per mode, each for 10, 20 and 30 ms
const OVERHANG_1 = [
	[8, 4, 3],
	[8, 4, 3],
	[6, 3, 2],
	[6, 3, 2],
];
const OVERHANG_2 = [
	[14, 7, 5],
	[14, 7, 5],
	[9, 5, 3],
	[9, 5, 3],
];
const LOCAL_THRESHOLD = [
	[24, 21, 24],
	[37, 32, 37],
	[82, 78, 82],
	[94, 94, 94],
];
const GLOBAL_THRESHOLD = [
	[57, 48, 57],
	[100, 80, 100],
	[285, 260, 285],
	[1100, 1050, 1100],
];
// vad_filterbank.c: 80 Hz high pass (Q14), split allpass (Q15), and the
// per band offsets that make up for halving the signal at each split
const HP_ZERO = [6631, -13262, 6631];
const HP_POLE = [16384, -7756, 5620];
const OFFSETS = [368, 368, 272, 176, 176, 176];

/** delta out of gaussian(), in Q11 */
let delta = 0;

/** WebRtcVad_GaussianProbability: in Q20, delta set as a side output */
function gaussian(input: number, mean: number, std: number): number {
	const invStd = s16(divW32W16(131072 + (std >> 1), std));
	let t = invStd >> 2;
	const invStd2 = s16((t * t) >> 2);
	t = s16(s16(input << 3) - mean);
	delta = s16((invStd2 * t) >> 10);
	const e = (delta * t) >> 9;
	let exp = 0;
	if (e < 22005) {
		t = s16(-s16((5909 * e) >> 12));
		exp = 0x400 | (t & 0x3ff);
		t = (s16(t ^ 0xffff) >> 10) + 1;
		exp >>= t;
	}
	return invStd * exp;
}

/** WeightedAverage of vad_core.c: data[at + 6k] += offset first */
function weighted(
	data: Int16Array,
	at: number,
	offset: number,
	w: number[],
): number {
	let sum = 0;
	for (let k = 0; k < 2; k++) {
		const g = at + 6 * k;
		data[g] += offset;
		sum = (sum + data[g] * w[g]) | 0;
	}
	return sum;
}

/** AllPassFilter of vad_filterbank.c over every other sample of x */
function allPass(
	x: Int16Array,
	at: number,
	n: number,
	coef: number,
	state: Int16Array,
	band: number,
	out: Int16Array,
): void {
	let s = state[band] << 16;
	for (let i = 0; i < n; i++, at += 2) {
		const y = ((s + coef * x[at]) | 0) >> 16;
		out[i] = y;
		// wraps on full scale input, as WebRTC's does (bugs.webrtc.org/490331112)
		s = (((x[at] << 14) - coef * y) | 0) << 1;
	}
	state[band] = s >> 16;
}

export class Vad {
	/** aggressiveness, 0 (Chrome's kVadNormal for comfort noise) to 3 */
	readonly mode: number;
	// VadInstT, names as in vad_core.h
	vad = 1;
	frameCounter = 0;
	overHang = 0;
	numOfSpeech = 0;
	readonly downsampling = new Int32Array(2);
	readonly noiseMeans = new Int16Array(12);
	readonly speechMeans = new Int16Array(12);
	readonly noiseStds = new Int16Array(12);
	readonly speechStds = new Int16Array(12);
	readonly indexVector = new Int16Array(96);
	readonly lowValueVector = new Int16Array(96);
	readonly meanValue = new Int16Array(6);
	readonly upperState = new Int16Array(5);
	readonly lowerState = new Int16Array(5);
	readonly hpFilterState = new Int16Array(4);
	// scratch
	private readonly nb = new Int16Array(240);
	private readonly hp120 = new Int16Array(120);
	private readonly lp120 = new Int16Array(120);
	private readonly hp60 = new Int16Array(60);
	private readonly lp60 = new Int16Array(60);
	private readonly features = new Int16Array(6);
	private readonly deltaN = new Int16Array(12);
	private readonly deltaS = new Int16Array(12);
	private readonly ngprvec = new Int16Array(12);
	private readonly sgprvec = new Int16Array(12);
	private totalEnergy = 0;

	constructor(mode = 0) {
		if (!(mode >= 0 && mode <= 3 && mode % 1 === 0))
			throw new RangeError('VAD mode is 0 to 3');
		this.mode = mode;
		this.reset();
	}

	/** WebRtcVad_InitCore, as Vad::Reset makes a fresh instance */
	reset(): void {
		this.vad = 1;
		this.frameCounter = this.overHang = this.numOfSpeech = 0;
		this.downsampling.fill(0);
		this.noiseMeans.set(NOISE_MEANS);
		this.speechMeans.set(SPEECH_MEANS);
		this.noiseStds.set(NOISE_STDS);
		this.speechStds.set(SPEECH_STDS);
		this.lowValueVector.fill(10000);
		this.indexVector.fill(0);
		this.upperState.fill(0);
		this.lowerState.fill(0);
		this.hpFilterState.fill(0);
		this.meanValue.fill(1600);
	}

	/**
	 * WebRtcVad_Process: 1 for speech, 0 for none. Frames are 10, 20 or 30
	 * ms of int16 at 8000 or 16000 Hz.
	 */
	process(frame: Int16Array, rate: number): number {
		const n = frame.length;
		const ms = (n * 1000) / rate;
		if (
			(rate !== 8000 && rate !== 16000) ||
			(ms !== 10 && ms !== 20 && ms !== 30)
		)
			throw new RangeError('VAD takes 10, 20 or 30 ms at 8 or 16 kHz');
		let x = frame;
		if (rate === 16000) {
			this.downsample(frame, n);
			x = this.nb;
		}
		const len = rate === 16000 ? n >> 1 : n;
		this.vad = this.gmm(this.calculateFeatures(x, len), len);
		return this.vad > 0 ? 1 : 0;
	}

	/** WebRtcVad_Downsampling: 16 to 8 kHz with two allpass branches */
	private downsample(x: Int16Array, n: number): void {
		const out = this.nb;
		let t1 = this.downsampling[0];
		let t2 = this.downsampling[1];
		for (let i = 0, at = 0; i < n >> 1; i++) {
			const a = s16((t1 >> 1) + ((5243 * x[at]) >> 14));
			t1 = x[at++] - ((5243 * a) >> 12);
			const b = s16((t2 >> 1) + ((1392 * x[at]) >> 14));
			t2 = x[at++] - ((1392 * b) >> 12);
			out[i] = a + b;
		}
		this.downsampling[0] = t1;
		this.downsampling[1] = t2;
	}

	/** SplitFilter: n samples of x into upper (hp) and lower (lp) halves */
	private split(
		x: Int16Array,
		n: number,
		band: number,
		hp: Int16Array,
		lp: Int16Array,
	): void {
		const half = n >> 1;
		allPass(x, 0, half, 20972, this.upperState, band, hp);
		allPass(x, 1, half, 5571, this.lowerState, band, lp);
		for (let i = 0; i < half; i++) {
			const t = hp[i];
			hp[i] -= lp[i];
			lp[i] += t;
		}
	}

	/** LogOfEnergy: features[band] = 10 log10(energy) in Q4 + offset */
	private logOfEnergy(x: Int16Array, n: number, band: number): void {
		let e = energy(x, n) >>> 0;
		const offset = OFFSETS[band];
		if (e === 0) {
			this.features[band] = offset;
			return;
		}
		let sh = energyShifts;
		const norm = 17 - Math.clz32(e);
		sh += norm;
		e = norm < 0 ? (e << -norm) >>> 0 : e >>> norm;
		const log2 = 14336 + ((e & 0x3fff) >> 4);
		let le = s16(((24660 * log2) >> 19) + ((sh * 24660) >> 9));
		if (le < 0) le = 0;
		this.features[band] = le + offset;
		if (this.totalEnergy <= MIN_ENERGY)
			this.totalEnergy = s16(
				this.totalEnergy + (sh >= 0 ? MIN_ENERGY + 1 : e >>> -sh),
			);
	}

	/** WebRtcVad_CalculateFeatures: returns the frame's total power */
	private calculateFeatures(x: Int16Array, n: number): number {
		const { hp120, lp120, hp60, lp60 } = this;
		const half = n >> 1;
		const quarter = half >> 1;
		this.totalEnergy = 0;
		this.split(x, n, 0, hp120, lp120);
		this.split(hp120, half, 1, hp60, lp60);
		this.logOfEnergy(hp60, quarter, 5);
		this.logOfEnergy(lp60, quarter, 4);
		this.split(lp120, half, 2, hp60, lp60);
		this.logOfEnergy(hp60, quarter, 3);
		this.split(lp60, quarter, 3, hp120, lp120);
		this.logOfEnergy(hp120, quarter >> 1, 2);
		this.split(lp120, quarter >> 1, 4, hp60, lp60);
		const m = quarter >> 2;
		this.logOfEnergy(hp60, m, 1);
		// the 0 to 250 Hz band loses 0 to 80 Hz before its energy
		const st = this.hpFilterState;
		for (let i = 0; i < m; i++) {
			const v = lp60[i];
			let t = HP_ZERO[0] * v + HP_ZERO[1] * st[0] + HP_ZERO[2] * st[1];
			st[1] = st[0];
			st[0] = v;
			t -= HP_POLE[1] * st[2] + HP_POLE[2] * st[3];
			st[3] = st[2];
			st[2] = t >> 14;
			hp120[i] = st[2];
		}
		this.logOfEnergy(hp120, m, 0);
		return this.totalEnergy;
	}

	/** WebRtcVad_FindMinimum: smoothed median of a band's recent minima */
	private findMinimum(value: number, ch: number): number {
		const age = this.indexVector;
		const low = this.lowValueVector;
		const o = ch << 4;
		for (let i = 0; i < 16; i++) {
			if (age[o + i] !== 100) {
				age[o + i]++;
			} else {
				for (let j = i; j < 15; j++) {
					low[o + j] = low[o + j + 1];
					age[o + j] = age[o + j + 1];
				}
				age[o + 15] = 101;
				low[o + 15] = 10000;
			}
		}
		// the first slot whose value is above this one, if any
		let pos = 0;
		while (pos < 16 && value >= low[o + pos]) pos++;
		if (pos < 16) {
			for (let i = 15; i > pos; i--) {
				low[o + i] = low[o + i - 1];
				age[o + i] = age[o + i - 1];
			}
			low[o + pos] = value;
			age[o + pos] = 1;
		}
		const fc = this.frameCounter;
		const median = fc > 2 ? low[o + 2] : fc > 0 ? low[o] : 1600;
		const mean = this.meanValue[ch];
		const alpha = fc > 0 ? (median < mean ? 6553 : 32439) : 0;
		const t = (alpha + 1) * mean + (32767 - alpha) * median + 16384;
		this.meanValue[ch] = t >> 15;
		return this.meanValue[ch];
	}

	/** GmmProbability: the decision, with hangover, and the model update */
	private gmm(power: number, n: number): number {
		const lengthIndex = n === 80 ? 0 : n === 160 ? 1 : 2;
		const m = this.mode;
		const { features, deltaN, deltaS, ngprvec, sgprvec } = this;
		const { noiseMeans, speechMeans, noiseStds, speechStds } = this;
		let vadflag = 0;
		if (power > MIN_ENERGY) {
			ngprvec.fill(0);
			sgprvec.fill(0);
			let sumLlr = 0;
			for (let ch = 0; ch < 6; ch++) {
				let h0 = 0;
				let h1 = 0;
				let np0 = 0;
				let sp0 = 0;
				for (let k = 0; k < 2; k++) {
					const g = ch + 6 * k;
					let p = gaussian(features[ch], noiseMeans[g], noiseStds[g]);
					deltaN[g] = delta;
					const np = Math.imul(NOISE_WEIGHTS[g], p);
					h0 = (h0 + np) | 0;
					p = gaussian(features[ch], speechMeans[g], speechStds[g]);
					deltaS[g] = delta;
					const sp = Math.imul(SPEECH_WEIGHTS[g], p);
					h1 = (h1 + sp) | 0;
					if (k === 0) {
						np0 = np;
						sp0 = sp;
					}
				}
				// log2 likelihood ratio, approximated by the normalising shifts
				const llr =
					(h0 === 0 ? 31 : normW32(h0)) - (h1 === 0 ? 31 : normW32(h1));
				sumLlr += llr * SPECTRUM_WEIGHT[ch];
				if (llr * 4 > LOCAL_THRESHOLD[m][lengthIndex]) vadflag = 1;
				const h0q = s16(h0 >> 12);
				if (h0q > 0) {
					const t = ((np0 & 0xfffff000) << 2) | 0;
					ngprvec[ch] = divW32W16(t, h0q);
					ngprvec[ch + 6] = 16384 - ngprvec[ch];
				} else {
					ngprvec[ch] = 16384;
				}
				const h1q = s16(h1 >> 12);
				if (h1q > 0) {
					const t = ((sp0 & 0xfffff000) << 2) | 0;
					sgprvec[ch] = divW32W16(t, h1q);
					sgprvec[ch + 6] = 16384 - sgprvec[ch];
				}
			}
			if (sumLlr >= GLOBAL_THRESHOLD[m][lengthIndex]) vadflag = 1;

			// a band's speech mean cap is the previous band's (12800 first)
			let maxspe = 12800;
			for (let ch = 0; ch < 6; ch++) {
				const fmin = this.findMinimum(features[ch], ch);
				const ngm = s16(weighted(noiseMeans, ch, 0, NOISE_WEIGHTS) >> 6);
				for (let k = 0; k < 2; k++) {
					const g = ch + 6 * k;
					const nmk = noiseMeans[g];
					const smk = speechMeans[g];
					let nmk2 = nmk;
					if (!vadflag) {
						const d = s16((ngprvec[g] * deltaN[g]) >> 11);
						nmk2 = s16(nmk + s16((d * 655) >> 22));
					}
					const ndelt = s16((fmin << 4) - ngm);
					let nmk3 = s16(nmk2 + s16((ndelt * 154) >> 9));
					const lo = (k + 5) << 7;
					const hi = (72 + k - ch) << 7;
					if (nmk3 < lo) nmk3 = lo;
					if (nmk3 > hi) nmk3 = hi;
					noiseMeans[g] = nmk3;
					if (vadflag) {
						const d = s16((sgprvec[g] * deltaS[g]) >> 11);
						const t = s16((d * 6554) >> 21);
						let smk2 = s16(smk + ((t + 1) >> 1));
						const maxmu = s16(maxspe + 640);
						if (smk2 < MINIMUM_MEAN[k]) smk2 = MINIMUM_MEAN[k];
						if (smk2 > maxmu) smk2 = maxmu;
						speechMeans[g] = smk2;
						const x = s16(features[ch] - s16((smk + 4) >> 3));
						const t1 = (((deltaS[g] * x) >> 3) - 4096) | 0;
						const t2 = Math.imul(sgprvec[g] >> 2, t1) >> 4;
						speechStds[g] = this.stdStep(speechStds[g], t2, 10, 128, 8);
					} else {
						const x = s16(features[ch] - (nmk >> 3));
						const t1 = (((deltaN[g] * x) >> 3) - 4096) | 0;
						const t2 = Math.imul(s16((ngprvec[g] + 2) >> 2), t1);
						noiseStds[g] = this.stdStep(noiseStds[g], t2 >> 14, 1, 32, 6);
					}
				}
				let ngm2 = weighted(noiseMeans, ch, 0, NOISE_WEIGHTS);
				let sgm = weighted(speechMeans, ch, 0, SPEECH_WEIGHTS);
				const diff = s16(s16(sgm >> 9) - s16(ngm2 >> 9));
				if (diff < MINIMUM_DIFFERENCE[ch]) {
					// pull the models apart, about 0.8 of the gap speech, 0.2 noise
					const t = s16(MINIMUM_DIFFERENCE[ch] - diff);
					sgm = weighted(speechMeans, ch, s16((13 * t) >> 2), SPEECH_WEIGHTS);
					ngm2 = weighted(
						noiseMeans,
						ch,
						s16(-s16((3 * t) >> 2)),
						NOISE_WEIGHTS,
					);
				}
				maxspe = MAXIMUM_SPEECH[ch];
				let t = s16(sgm >> 7);
				if (t > maxspe) {
					t -= maxspe;
					speechMeans[ch] -= t;
					speechMeans[ch + 6] -= t;
				}
				t = s16(ngm2 >> 7);
				if (t > MAXIMUM_NOISE[ch]) {
					t -= MAXIMUM_NOISE[ch];
					noiseMeans[ch] -= t;
					noiseMeans[ch + 6] -= t;
				}
			}
			this.frameCounter = (this.frameCounter + 1) | 0;
		}
		// hangover: a few frames stay speech after speech ends
		if (!vadflag) {
			if (this.overHang > 0) {
				vadflag = 2 + this.overHang;
				this.overHang--;
			}
			this.numOfSpeech = 0;
		} else {
			this.numOfSpeech++;
			if (this.numOfSpeech > 6) {
				this.numOfSpeech = 6;
				this.overHang = OVERHANG_2[m][lengthIndex];
			} else {
				this.overHang = OVERHANG_1[m][lengthIndex];
			}
		}
		return vadflag;
	}

	/**
	 * A standard deviation's update: num (Q20) over std * scale, rounded
	 * and shifted to Q7, floored at MIN_STD
	 */
	private stdStep(
		std: number,
		num: number,
		scale: number,
		round: number,
		shift: number,
	): number {
		let t =
			num > 0
				? s16(divW32W16(num, std * scale))
				: s16(-s16(divW32W16(-num | 0, std * scale)));
		t = s16(t + round);
		const next = s16(std + (t >> shift));
		return next < MIN_STD ? MIN_STD : next;
	}
}
