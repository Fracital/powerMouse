// NetEq's time stretching (WebRTC's modules/audio_coding/neteq, accelerate
// and preemptive expand, docs/webrtc-over-wisp.md, section 16): a frame
// about to play is made a pitch period shorter or longer, where it repeats
// well enough that the cut is not heard. Frames are 48 kHz, planar.

/** the shortest and longest pitch period looked for, in samples at 48 kHz (2.5 and 10 ms) */
const MIN_LAG = 120;
const MAX_LAG = 480;
/** how alike a period and the next must be (NetEq's 0.9) */
const ALIKE = 0.9;
/** below this mean square a frame is quiet enough to cut anywhere (about -60 dBFS) */
const QUIET = 1e-6;

/** the pitch period of the frame's sound (its channels mixed) and how alike two periods are */
function periodOf(
	samples: Float32Array,
	frames: number,
	channels: number,
	longest: number,
): { lag: number; alike: number; quiet: boolean } {
	const mixed = new Float32Array(frames);
	for (let channel = 0; channel < channels; channel++)
		for (let at = 0; at < frames; at++)
			mixed[at] += samples[channel * frames + at] / channels;
	let power = 0;
	for (let at = 0; at < frames; at++) power += mixed[at] * mixed[at];
	const quiet = power / frames < QUIET;
	const score = (lag: number) => {
		let cross = 0;
		let first = 0;
		let second = 0;
		for (let at = 0; at < lag; at++) {
			cross += mixed[at] * mixed[at + lag];
			first += mixed[at] * mixed[at];
			second += mixed[at + lag] * mixed[at + lag];
		}
		return first && second ? cross / Math.sqrt(first * second) : 0;
	};
	let lag = MIN_LAG;
	let alike = -Infinity;
	// every other lag, then the ones beside the best
	for (let at = MIN_LAG; at <= longest; at += 2) {
		const got = score(at);
		if (got > alike) {
			alike = got;
			lag = at;
		}
	}
	for (const at of [lag - 1, lag + 1])
		if (at >= MIN_LAG && at <= longest) {
			const got = score(at);
			if (got > alike) {
				alike = got;
				lag = at;
			}
		}
	return { lag, alike, quiet };
}

/**
 * The frame a pitch period shorter (`longer` false: NetEq's accelerate;
 * as many periods as fit in half the frame, `fast`) or longer (its
 * preemptive expand), the two stretches at the cut faded into each
 * other; null where its sound does not repeat well enough.
 */
export function stretch(
	samples: Float32Array,
	frames: number,
	channels: number,
	longer: boolean,
	fast = false,
): { samples: Float32Array<ArrayBuffer>; frames: number } | null {
	const longest = Math.min(MAX_LAG, Math.floor(frames / 2));
	if (longest < MIN_LAG) return null;
	const found = periodOf(samples, frames, channels, longest);
	if (!found.quiet && found.alike < ALIKE) return null;
	// (a sound that repeats at one period repeats at its multiples)
	const lag =
		fast && !longer
			? Math.floor(Math.floor(frames / 2) / found.lag) * found.lag
			: found.lag;
	const length = longer ? frames + lag : frames - lag;
	const out = new Float32Array(length * channels);
	for (let channel = 0; channel < channels; channel++) {
		const from = samples.subarray(channel * frames, (channel + 1) * frames);
		const to = out.subarray(channel * length, (channel + 1) * length);
		if (longer) {
			// the first two periods, the second fading into a repeat of the
			// first, then the rest from the second on
			to.set(from.subarray(0, lag), 0);
			for (let at = 0; at < lag; at++) {
				const fade = (at + 0.5) / lag;
				to[lag + at] = from[lag + at] * (1 - fade) + from[at] * fade;
			}
			to.set(from.subarray(lag), 2 * lag);
		} else {
			// the first period fading into the second, then the rest after it
			for (let at = 0; at < lag; at++) {
				const fade = (at + 0.5) / lag;
				to[at] = from[at] * (1 - fade) + from[lag + at] * fade;
			}
			to.set(from.subarray(2 * lag), lag);
		}
	}
	return { samples: out, frames: length };
}
