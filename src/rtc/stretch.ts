// NetEq's time stretching (WebRTC's modules/audio_coding/neteq,
// time_stretch.cc, accelerate.cc and preemptive_expand.cc, as Chrome 157
// runs them; docs/webrtc-over-wisp.md, section 16): 30 ms of sound, the
// frame about to play and what it borrows from the end of the sync buffer,
// is made a pitch period shorter or longer at its 15 ms point, where it
// repeats well enough that the cut is not heard. Sound is 48 kHz, a plane
// a channel.

/** 15 ms, where the cut or the repeat is made */
const AT = 720;
/** what is stretched: 30 ms (NetEq takes it from 29.875) */
export const STRETCH_INPUT = 1440;
const SHORTEST_INPUT = 1434;
/** NetEq's lags at 4 kHz: from 2.5 to 15 ms, over a window of 12.5 ms */
const DOWN = 12;
const MIN_LAG = 10;
const MAX_LAG = 60;
const WINDOW = 50;
/**
 * Expand's: the last 31 ms at 4 kHz, the correlation of its last 15 ms at
 * 54 lags (the strongest looked for in 51 of them), and how much a lag
 * differs over the last 2.5 ms
 */
const EXPAND_DOWN = 124;
const EXPAND_WINDOW = 60;
const EXPAND_LAGS = 54;
const EXPAND_PEAKS_IN = 51;
const DISTORTION = 120;
/** how alike a period and the next must be (0.9; 0.5 when fast) */
const ALIKE = 0.9;
const FAST_ALIKE = 0.5;
/**
 * Sound quieter than this (mean square, full scale 1) is not speech, and
 * is cut anywhere (NetEq's fixed threshold before it has estimated the
 * background noise: 75000 in 16-bit units, over 16)
 */
const PASSIVE = (75000 * 16) / 2 / 32768 / 32768;

/** `count` samples of `signal` from `from` at 4 kHz (NetEq's 7-tap downsampling, every 12th sample) */
function downsample(
	signal: Float32Array,
	from: number,
	count: number,
): Float32Array {
	const out = new Float32Array(count);
	for (let at = 0; at < count; at++) {
		let sum = 0;
		for (let k = 0; k < 7; k++)
			sum += signal[from + at * DOWN + DOWN - 1 - k] ?? 0;
		out[at] = sum / 7;
	}
	return out;
}

/**
 * The correlations of the last `window` samples of `down` with those
 * `first` to `first + count - 1` before them (and a zero past the last,
 * which NetEq's peak fit reads)
 */
function correlate(
	down: Float32Array,
	first: number,
	count: number,
	window: number,
): Float64Array {
	const out = new Float64Array(count + 1);
	const start = down.length - window;
	for (let index = 0; index < count; index++) {
		let sum = 0;
		for (let k = 0; k < window; k++)
			sum += down[start + k] * down[start + k - first - index];
		out[index] = sum;
	}
	return out;
}

/**
 * NetEq's DspHelper::PeakDetection: the `count` strongest of the first
 * `length` correlations (each next one away from those found), each at 48
 * kHz, to the sample by a parabola through it and those beside it, and
 * how strong it is
 */
function peaksOf(
	correlation: Float64Array,
	length: number,
	count: number,
): { at: number; value: number }[] {
	const data = Float64Array.from(correlation);
	const out = [];
	for (let found = 0; found < count; found++) {
		let best = 0;
		for (let index = 1; index < (count === 1 ? length : length - 1); index++)
			if (data[index] > data[best]) best = index;
		const peak = data[best];
		let at = best;
		if (best > 0) {
			const before = data[best - 1];
			const after = data[best + 1];
			const curve = before - 2 * peak + after;
			if (curve < 0)
				at += Math.max(-0.5, Math.min(0.5, (before - after) / (2 * curve)));
		}
		out.push({ at: Math.round(at * DOWN), value: peak });
		data.fill(0, Math.max(0, best - 2), best + 3);
	}
	return out;
}

/**
 * The pitch period of the sound at 48 kHz, as NetEq's time stretching
 * finds it: the first channel at 4 kHz, its correlation at lags of 10 to
 * 59 over the 50 samples from 60 on, the strongest
 */
function periodOf(signal: Float32Array): number {
	const correlation = correlate(
		downsample(signal, 0, MAX_LAG + WINDOW),
		MIN_LAG,
		MAX_LAG - MIN_LAG,
		WINDOW,
	);
	return peaksOf(correlation, MAX_LAG - MIN_LAG, 1)[0].at + MIN_LAG * DOWN;
}

/**
 * The period NetEq's expand repeats the last sound played at
 * (Expand::AnalyzeSignal): of the three strongest correlations of its last
 * 15 ms at 4 kHz with that 2.5 to 15 ms before, each moved to the lag
 * within 0.5 ms that differs least from the sound that long before it
 * over the last 2.5 ms, the one strongest for how much it differs. Its
 * repeats take turns at that lag and at two between it and the
 * correlation's (each the longest needed: `longest`). And how alike its
 * repeats are (normalized correlation over a period, 7.5 to 15 ms).
 */
export function expandLagOf(history: Float32Array): {
	lags: number[];
	longest: number;
	alike: number;
} {
	const end = history.length;
	const correlation = correlate(
		downsample(history, end - EXPAND_DOWN * DOWN, EXPAND_DOWN),
		MIN_LAG,
		EXPAND_LAGS,
		EXPAND_WINDOW,
	);
	let best = { lag: MIN_LAG * DOWN, near: MIN_LAG * DOWN, ratio: -Infinity };
	for (const { at, value } of peaksOf(correlation, EXPAND_PEAKS_IN, 3)) {
		const near = at + MIN_LAG * DOWN;
		let lag = near;
		let least = Infinity;
		const low = Math.max(MIN_LAG * DOWN, near - 24);
		const high = Math.min(AT - 1, near + 24);
		for (let candidate = low; candidate <= high; candidate++) {
			let sum = 0;
			for (let k = end - DISTORTION; k < end; k++)
				sum += Math.abs(history[k] - history[k - candidate]);
			if (sum < least) {
				least = sum;
				lag = candidate;
			}
		}
		const ratio = least > 0 ? value / least : value > 0 ? Infinity : 0;
		if (ratio > best.ratio) best = { lag, near, ratio };
	}
	const { lag, near } = best;
	const window = Math.max(Math.min(lag + 10, AT), AT / 2);
	let cross = 0;
	let now = 0;
	let then = 0;
	for (let k = end - window; k < end; k++) {
		cross += history[k] * history[k - lag];
		now += history[k] * history[k];
		then += history[k - lag] * history[k - lag];
	}
	return {
		lags: [
			lag,
			(lag + near) >> 1,
			lag > near ? (lag + near - 1) >> 1 : (lag + near + 1) >> 1,
		],
		longest: Math.max(lag, near),
		alike: now && then ? Math.max(0, cross) / Math.sqrt(now * then) : 0,
	};
}

/**
 * `planes` (`length` samples each, at least `STRETCH_INPUT`) made a pitch
 * period shorter (`accelerate`; as many periods as fit in 15 ms, `fast`)
 * or longer (`preemptive`, the first `old` samples of it played already),
 * the stretch at the cut faded across as NetEq fades it; null where its
 * sound does not repeat well enough
 */
export function stretch(
	planes: Float32Array[],
	length: number,
	op: 'accelerate' | 'fast' | 'preemptive',
	old: number,
	overlap: number,
): { planes: Float32Array[]; length: number; change: number } | null {
	if (length < SHORTEST_INPUT) return null;
	if (op === 'preemptive' && old >= length - overlap) return null;
	const signal = planes[0];
	let peak = periodOf(signal);
	const energy = (from: number, to: number) => {
		let sum = 0;
		for (let k = 0; k < peak; k++) sum += signal[from + k] * signal[to + k];
		return sum;
	};
	const first = energy(AT - peak, AT - peak);
	const second = energy(AT, AT);
	const active = (first + second) / (2 * peak) > PASSIVE;
	let alike = 0;
	if (active)
		alike = Math.min(
			1,
			Math.max(0, energy(AT - peak, AT)) / Math.sqrt(first * second),
		);
	else if (op === 'preemptive') peak = Math.min(peak, length - old);
	if (op === 'preemptive') {
		if (!((alike > ALIKE && old <= AT) || !active)) return null;
		// the sound up to 15 ms (or what was played) and a period after it,
		// that period fading into the one before it, then the rest again
		const kept = Math.max(old, AT);
		const out = planes.map((plane) => {
			const made = new Float32Array(length + peak);
			made.set(plane.subarray(0, kept + peak));
			fade(made, kept, plane.subarray(kept - peak, kept), peak);
			made.set(plane.subarray(kept, length), kept + peak);
			return made;
		});
		return { planes: out, length: length + peak, change: peak };
	}
	if (!(alike > (op === 'fast' ? FAST_ALIKE : ALIKE) || !active)) return null;
	if (op === 'fast') peak = Math.floor(AT / peak) * peak;
	// the first 15 ms, its last period fading into the period after it,
	// then the rest after that period
	const out = planes.map((plane) => {
		const made = new Float32Array(length - peak);
		made.set(plane.subarray(0, AT));
		fade(made, AT - peak, plane.subarray(AT, AT + peak), peak);
		made.set(plane.subarray(AT + peak, length), AT);
		return made;
	});
	return { planes: out, length: length - peak, change: -peak };
}

/** `length` samples of `into` from `at` fade into `from` (NetEq's AudioVector::CrossFade) */
function fade(
	into: Float32Array,
	at: number,
	from: Float32Array,
	length: number,
) {
	for (let k = 0; k < length; k++) {
		const keep = 1 - (k + 1) / (length + 1);
		into[at + k] = into[at + k] * keep + from[k] * (1 - keep);
	}
}
