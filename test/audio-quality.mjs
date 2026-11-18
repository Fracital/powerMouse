// What a call sounds like, measured: the webrtc-audio suite's test signal
// (a sine sweep, then speech-like sound with pauses) written as the WAV
// file Chrome's fake capture device plays, and the comparison of what one
// end of a call received with what the other end sent, both recorded off
// their tracks. The two recordings are lined up by cross-correlation, then
// followed block by block: the delay of each block says how late the
// sound came and how steadily (jitter, a clock or sample-rate error as a
// slope, lost or added sound as a jump), and the block's residual against
// the sent sound says how changed it was (segmental SNR, log-spectral
// distance) or whether it was missing (a dropout).

const TAU = 2 * Math.PI;

/** a deterministic noise source, so every run plays the same file */
function noise(seed = 1) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 31 - 1;
	};
}

/** a two-pole resonator (a formant) at `hz` with bandwidth `width` */
function resonator(hz, width, rate) {
	const r = Math.exp((-Math.PI * width) / rate);
	const a1 = 2 * r * Math.cos((TAU * hz) / rate);
	const a2 = -r * r;
	const gain = 1 - r;
	let y1 = 0;
	let y2 = 0;
	return (x) => {
		const y = gain * x + a1 * y1 + a2 * y2;
		y2 = y1;
		y1 = y;
		return y;
	};
}

// vowels as their first three formants (Hz)
const VOWELS = [
	[730, 1090, 2440],
	[270, 2290, 3010],
	[530, 1840, 2480],
	[300, 870, 2240],
	[640, 1190, 2390],
	[440, 1020, 2240],
];

/**
 * The test signal, `seconds` long at `rate`: 0 to 4 s a logarithmic sweep
 * from 150 Hz to 7 kHz, 4 to 9 s speech-like sound (a voice with a moving
 * pitch through changing formants, in syllables of about 180 ms with
 * fricatives and pauses), 9 to 10 s silence
 */
export function testSignal(rate = 48000) {
	const out = new Float32Array(rate * 10);
	const random = noise(7);
	// the sweep
	const sweep = 4 * rate;
	const f0 = 150;
	const f1 = 7000;
	const k = Math.log(f1 / f0);
	for (let i = 0; i < sweep; i++) {
		const t = i / rate;
		const phase = ((TAU * f0 * 4) / k) * (Math.exp((k * t) / 4) - 1);
		const fade = Math.min(1, i / 480, (sweep - i) / 480);
		out[i] = 0.35 * fade * Math.sin(phase);
	}
	// the voice
	const from = 4 * rate;
	const to = 9 * rate;
	let glottal = 0;
	let formants = null;
	let vowel = -1;
	const hiss = resonator(5000, 2500, rate);
	for (let i = from; i < to; i++) {
		const t = (i - from) / rate;
		const syllable = Math.floor(t / 0.18);
		const inSyllable = (t % 0.18) / 0.18;
		// a pause of about 300 ms every eighth syllable
		const pause = syllable % 8 === 7 || syllable % 8 === 6;
		const next = (syllable * 5 + 3) % VOWELS.length;
		if (next !== vowel) {
			vowel = next;
			formants = VOWELS[vowel].map((hz, at) =>
				resonator(hz, 80 + at * 40, rate),
			);
		}
		const pitch =
			140 + 50 * Math.sin(TAU * 0.4 * t) + 6 * Math.sin(TAU * 5.5 * t);
		glottal += pitch / rate;
		// a pulse train with a falling spectrum
		const pulse = glottal % 1 < pitch / rate ? 1 : 0;
		glottal %= 1;
		const envelope = pause ? 0 : Math.sin(Math.PI * inSyllable) ** 0.6;
		let voiced = 0;
		for (const formant of formants) voiced += formant(pulse);
		const fricative = syllable % 3 === 1 && inSyllable < 0.3 && !pause;
		const unvoiced = fricative ? hiss(random()) * 0.6 : 0;
		out[i] = Math.max(
			-0.9,
			Math.min(0.9, 3.2 * envelope * voiced + unvoiced * (1 - inSyllable)),
		);
	}
	return out;
}

/** a 16-bit mono WAV file of `samples` */
export function wav(samples, rate = 48000) {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++)
		data.writeInt16LE(
			Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
			i * 2,
		);
	const head = Buffer.alloc(44);
	head.write('RIFF', 0);
	head.writeUInt32LE(36 + data.length, 4);
	head.write('WAVE', 8);
	head.write('fmt ', 12);
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20);
	head.writeUInt16LE(1, 22);
	head.writeUInt32LE(rate, 24);
	head.writeUInt32LE(rate * 2, 28);
	head.writeUInt16LE(2, 32);
	head.writeUInt16LE(16, 34);
	head.write('data', 36);
	head.writeUInt32LE(data.length, 40);
	return Buffer.concat([head, data]);
}

/** a recording the page made (base64 of 16-bit samples) as floats */
export function samplesOf(recording) {
	const bytes = Buffer.from(recording.samples, 'base64');
	const out = new Float32Array(bytes.length >> 1);
	for (let i = 0; i < out.length; i++)
		out[i] = bytes.readInt16LE(i * 2) / 32767;
	return out;
}

// --- a radix-2 FFT, in place, on interleaved-free re/im arrays ---

function fft(re, im, inverse = false) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const angle = ((inverse ? 1 : -1) * TAU) / size;
		const wr = Math.cos(angle);
		const wi = Math.sin(angle);
		for (let start = 0; start < n; start += size) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < size / 2; k++) {
				const a = start + k;
				const b = a + size / 2;
				const tr = re[b] * cr - im[b] * ci;
				const ti = re[b] * ci + im[b] * cr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
				const next = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = next;
			}
		}
	}
	if (inverse)
		for (let i = 0; i < n; i++) {
			re[i] /= n;
			im[i] /= n;
		}
}

/**
 * The lag (in samples, 0 to `max`) at which `long` best matches `short`:
 * short[i] ~ long[i + lag], and how well (a normalised correlation)
 */
function bestLag(short, long, max, min = 0) {
	let n = 1;
	while (n < long.length + short.length) n <<= 1;
	const ar = new Float64Array(n);
	const ai = new Float64Array(n);
	const br = new Float64Array(n);
	const bi = new Float64Array(n);
	ar.set(long);
	br.set(short);
	fft(ar, ai);
	fft(br, bi);
	for (let i = 0; i < n; i++) {
		// long times the conjugate of short
		const r = ar[i] * br[i] + ai[i] * bi[i];
		const m = ai[i] * br[i] - ar[i] * bi[i];
		ar[i] = r;
		ai[i] = m;
	}
	fft(ar, ai, true);
	// normalised by the energy of `long` under `short` at each lag
	const sums = new Float64Array(long.length + 1);
	for (let i = 0; i < long.length; i++)
		sums[i + 1] = sums[i] + long[i] * long[i];
	let es = 0;
	for (let i = 0; i < short.length; i++) es += short[i] * short[i];
	let best = -Infinity;
	let at = Math.max(0, min);
	for (
		let lag = Math.max(0, min);
		lag <= Math.min(max, long.length - short.length);
		lag++
	) {
		const el = sums[lag + short.length] - sums[lag];
		const score = el > 0 && es > 0 ? ar[lag] / Math.sqrt(es * el) : 0;
		if (score > best) {
			best = score;
			at = lag;
		}
	}
	return { lag: at, score: Math.max(0, best) };
}

const db = (value) => 10 * Math.log10(value || 1e-12);
const median = (list) => {
	const sorted = [...list].sort((a, b) => a - b);
	return sorted.length ? sorted[sorted.length >> 1] : null;
};

/**
 * Log-spectral distance (dB) between two equal sounds, frame by frame to
 * 8 kHz, where the sent sound is not quiet. A bin more than 50 dB under
 * its frame's loudest counts as that: a codec leaves out what is masked,
 * and the log of two near-silences is noise of its own.
 */
function spectralDistance(a, b, rate) {
	const n = 1024;
	const top = Math.floor((8000 / rate) * n);
	let total = 0;
	let frames = 0;
	for (let from = 0; from + n <= a.length; from += n / 2) {
		const ar = new Float64Array(n);
		const ai = new Float64Array(n);
		const br = new Float64Array(n);
		const bi = new Float64Array(n);
		let energy = 0;
		for (let i = 0; i < n; i++) {
			const w = 0.5 - 0.5 * Math.cos((TAU * i) / n);
			ar[i] = a[from + i] * w;
			br[i] = b[from + i] * w;
			energy += a[from + i] * a[from + i];
		}
		if (db(energy / n) < -30) continue;
		fft(ar, ai);
		fft(br, bi);
		let peak = 0;
		for (let k = 2; k < top; k++)
			peak = Math.max(peak, ar[k] * ar[k] + ai[k] * ai[k]);
		const floor = peak * 1e-5 + 1e-12;
		let sum = 0;
		for (let k = 2; k < top; k++) {
			const pa = Math.max(floor, ar[k] * ar[k] + ai[k] * ai[k]);
			const pb = Math.max(floor, br[k] * br[k] + bi[k] * bi[k]);
			sum += (10 * Math.log10(pa / pb)) ** 2;
		}
		total += Math.sqrt(sum / (top - 2));
		frames++;
	}
	return frames ? total / frames : null;
}

/** the strongest frequency of a block (Hz), with parabolic refinement */
function peakHz(block, rate) {
	const n = 8192;
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const m = Math.min(n, block.length);
	for (let i = 0; i < m; i++)
		re[i] = block[i] * (0.5 - 0.5 * Math.cos((TAU * i) / m));
	fft(re, im);
	let best = 0;
	let at = 0;
	for (let k = 2; k < n / 2 - 1; k++) {
		const p = re[k] * re[k] + im[k] * im[k];
		if (p > best) {
			best = p;
			at = k;
		}
	}
	const p = (k) => Math.sqrt(re[k] * re[k] + im[k] * im[k]);
	const [l, c, r] = [p(at - 1), p(at), p(at + 1)];
	const shift = (0.5 * (l - r)) / (l - 2 * c + r || 1);
	return ((at + shift) * rate) / n;
}

/**
 * How fast the sweep runs in a recording, against the test signal's own:
 * the slope of its log-frequency over time. 1 is right; a sound played at
 * another sample rate than it was made at (44.1 kHz read as 48 kHz) runs
 * that much fast or slow, its pitch with it.
 */
export function sweepSpeed(samples, rate) {
	const hop = 1024;
	const size = 2048;
	const points = [];
	for (let from = 0; from + size <= samples.length; from += hop) {
		const piece = samples.subarray(from, from + size);
		let energy = 0;
		for (const value of piece) energy += value * value;
		if (db(energy / size) < -30) {
			points.push(null);
			continue;
		}
		const hz = peakHz(piece, rate);
		// a pure tone: what is left after the peak's sinusoid is small
		const turn = (TAU * hz) / rate;
		let re = 0;
		let im = 0;
		for (let i = 0; i < size; i++) {
			re += piece[i] * Math.cos(turn * i);
			im += piece[i] * Math.sin(turn * i);
		}
		const tone = (2 * (re * re + im * im)) / size / energy;
		points.push(tone > 0.4 && hz > 200 && hz < 6500 ? Math.log(hz) : null);
	}
	// the steepest steady rises: runs of points each above the last
	const slopes = [];
	let run = [];
	const flush = () => {
		if (run.length >= 8) {
			const n = run.length;
			const mx = run.reduce((a, [x]) => a + x, 0) / n;
			const my = run.reduce((a, [, y]) => a + y, 0) / n;
			let sxy = 0;
			let sxx = 0;
			for (const [x, y] of run) {
				sxy += (x - mx) * (y - my);
				sxx += (x - mx) ** 2;
			}
			slopes.push(sxy / sxx);
		}
		run = [];
	};
	for (let i = 0; i < points.length; i++) {
		const y = points[i];
		const t = (i * hop) / rate;
		if (y === null || (run.length && y <= run.at(-1)[1])) flush();
		if (y !== null) run.push([t, y]);
	}
	flush();
	const want = Math.log(7000 / 150) / 4;
	return slopes.length ? +(median(slopes) / want).toFixed(4) : null;
}

/**
 * What `got` (received, at `rate`) is of `sent` (the sending end's own
 * recording of its track, at `sentRate`), both with their wall-clock
 * anchors (ms): the sound's delay, its steadiness and its quality.
 * Received sound at another rate than sent is resampled to the sent rate
 * by linear interpolation before anything is compared.
 */
export function compare(sentRecording, gotRecording) {
	const sent = samplesOf(sentRecording);
	let got = samplesOf(gotRecording);
	const gotFull = got;
	const rate = Math.abs(sentRecording.rate) || 48000;
	const gotRate = Math.abs(gotRecording.rate) || 48000;
	if (gotRate !== rate) {
		const length = Math.floor((got.length * rate) / gotRate);
		const out = new Float32Array(length);
		for (let i = 0; i < length; i++) {
			const x = (i * gotRate) / rate;
			const j = Math.floor(x);
			const f = x - j;
			out[i] = (got[j] ?? 0) * (1 - f) + (got[j + 1] ?? 0) * f;
		}
		got = out;
	}
	const result = {
		sentRate: sentRecording.rate,
		gotRate: gotRecording.rate,
		gotChannels: gotRecording.channels,
		sentSeconds: +(sent.length / rate).toFixed(2),
		gotSeconds: +(got.length / rate).toFixed(2),
	};
	// skip the received recording's first half second (the call settling)
	const skip = Math.floor(rate / 2);
	got = got.subarray(skip);
	const gotAnchor = gotRecording.anchor + (skip / rate) * 1000;
	// the received sound starts no earlier than the sent recording did
	// and at most 3 s after: line up 2 s of it
	// (sent[lag] was captured `latency` before got[0] played: from 200 ms
	// early, a clock's error, to 3 s late)
	const probe = got.subarray(0, 2 * rate);
	const expected = ((gotAnchor - sentRecording.anchor) / 1000) * rate;
	const { lag, score } = bestLag(
		probe,
		sent,
		Math.floor(expected + 0.2 * rate),
		Math.floor(expected - 3 * rate),
	);
	result.match = +score.toFixed(3);
	result.latencyMs = Math.round(
		gotAnchor - (sentRecording.anchor + (lag / rate) * 1000),
	);
	// follow the sound in blocks of 100 ms, each searched within 30 ms of
	// the last block's delay
	const block = Math.floor(rate / 10);
	const search = Math.floor(rate * 0.03);
	const lags = [];
	const snrs = [];
	const scores = [];
	let dropouts = 0;
	let dropMs = 0;
	const tenth = Math.floor(rate / 100);
	let loud = 0;
	let previous = lag;
	const alignedSent = new Float32Array(got.length);
	const alignedGot = new Float32Array(got.length);
	let aligned = 0;
	for (let from = 0; from + block <= got.length; from += block) {
		const piece = got.subarray(from, from + block);
		const start = previous + from - search;
		if (start < 0 || start + block + 2 * search > sent.length) break;
		const window = sent.subarray(start, start + block + 2 * search);
		let energy = 0;
		for (let i = 0; i < block; i++)
			energy += window[search + i] * window[search + i];
		const sentDb = db(energy / block);
		let gotEnergy = 0;
		for (let i = 0; i < block; i++) gotEnergy += piece[i] * piece[i];
		// a block of the sent sound near silence says nothing of delay
		if (sentDb < -40) {
			lags.push(null);
			continue;
		}
		loud++;
		const found = bestLag(piece, window, 2 * search);
		// a 10 ms window where the sent sound was and the received is
		// 20 dB under it: sound that did not arrive
		const usable = found.score > 0.5;
		const base = usable ? start + found.lag : previous + from;
		for (let sub = 0; sub + tenth <= block; sub += tenth) {
			let a = 0;
			let b = 0;
			for (let i = sub; i < sub + tenth; i++) {
				a += sent[base + i] * sent[base + i];
				b += piece[i] * piece[i];
			}
			if (db(a / tenth) > -40 && db(b / tenth) < db(a / tenth) - 20)
				dropMs += 10;
		}
		if (db(gotEnergy / block) < sentDb - 20) {
			dropouts++;
			lags.push(null);
			continue;
		}
		const at = start + found.lag;
		scores.push(found.score);
		// least-squares gain, then what is left
		let cross = 0;
		let own = 0;
		for (let i = 0; i < block; i++) {
			cross += piece[i] * sent[at + i];
			own += sent[at + i] * sent[at + i];
		}
		const gain = own ? cross / own : 0;
		let signal = 0;
		let rest = 0;
		for (let i = 0; i < block; i++) {
			const fit = gain * sent[at + i];
			signal += fit * fit;
			rest += (piece[i] - fit) ** 2;
		}
		snrs.push(Math.max(-10, Math.min(60, db(signal / (rest || 1e-12)))));
		alignedSent.set(sent.subarray(at, at + block), aligned);
		for (let i = 0; i < block; i++)
			alignedGot[aligned + i] = gain ? piece[i] / gain : 0;
		aligned += block;
		lags.push(at - from);
		if (found.score > 0.5) previous = at - from;
	}
	// the delay of each block, in ms, from the first
	const known = lags.filter((value) => value !== null);
	const ms = known.map((value) => ((value - known[0]) / rate) * 1000);
	let jumps = 0;
	let wander = 0;
	for (let i = 1; i < ms.length; i++) {
		const step = Math.abs(ms[i] - ms[i - 1]);
		if (step > 2) jumps++;
		wander += step;
	}
	// a slope of the delay: the received clock runs at another rate
	let slope = 0;
	if (ms.length > 4) {
		const xs = ms.map((_, i) => i * 0.1);
		const mx = xs.reduce((a, b) => a + b) / xs.length;
		const my = ms.reduce((a, b) => a + b) / ms.length;
		let sxy = 0;
		let sxx = 0;
		for (let i = 0; i < ms.length; i++) {
			sxy += (xs[i] - mx) * (ms[i] - my);
			sxx += (xs[i] - mx) ** 2;
		}
		slope = sxx ? sxy / sxx : 0;
	}
	// the sweep's pitch, received against sent, where both are one tone
	const ratios = [];
	const n = 4096;
	for (let from = 0; from + n <= aligned; from += n) {
		const a = alignedSent.subarray(from, from + n);
		let energy = 0;
		for (const value of a) energy += value * value;
		if (db(energy / n) < -20) continue;
		const hzSent = peakHz(a, rate);
		const hzGot = peakHz(alignedGot.subarray(from, from + n), rate);
		if (hzSent > 200 && hzSent < 6000) ratios.push(hzGot / hzSent);
	}
	Object.assign(result, {
		blocks: lags.length,
		loudBlocks: loud,
		dropouts,
		dropMs,
		sweepSpeed: sweepSpeed(gotFull, gotRate),
		jumps,
		// how far the delay moved, in ms per second of sound
		wanderMsPerS: +(wander / Math.max(0.1, ms.length * 0.1)).toFixed(1),
		driftMsPerS: +slope.toFixed(2),
		delaySpreadMs: ms.length
			? +(Math.max(...ms) - Math.min(...ms)).toFixed(1)
			: null,
		// the delay over the whole recording (its blocks' median), where
		// latencyMs is its first 2 s's
		latencyMedianMs: ms.length
			? Math.round(result.latencyMs - median(ms))
			: result.latencyMs,
		segSnrDb: snrs.length ? +median(snrs).toFixed(1) : null,
		segSnrLowDb: snrs.length
			? +[...snrs]
					.sort((a, b) => a - b)
					[Math.floor(snrs.length / 10)].toFixed(1)
			: null,
		correlation: scores.length ? +median(scores).toFixed(3) : null,
		lsdDb:
			aligned > 2048
				? +spectralDistance(
						alignedSent.subarray(0, aligned),
						alignedGot.subarray(0, aligned),
						rate,
					).toFixed(2)
				: null,
		pitchRatio: ratios.length ? +median(ratios).toFixed(4) : null,
	});
	return result;
}
