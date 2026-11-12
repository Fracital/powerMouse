// What getStats() says of the sound a section sends and plays
// (docs/webrtc-over-wisp.md, section 16): the members of `media-source`,
// `inbound-rtp` and `media-playout` that the worker counts itself, the way
// Chrome's WebRTC counts them (measured on 152 and 156).

/**
 * WebRTC's AudioLevel (audio_level.cc), fed 10 ms at a time: the level is
 * the loudest sample since the last update, as a 16-bit sample of full
 * scale, updated every 11th block (and the loudest kept a quarter of
 * itself); the energy adds each block's own loudest, squared, times its
 * length. So a tone of amplitude 0.5 reads 0.500015 (16384 / 32767) and
 * adds 0.25 a second.
 */
export class AudioLevel {
	#loudest = 0;
	#blocks = 0;
	#level = 0;
	energy = 0;
	duration = 0;

	get level(): number {
		return this.#level / 32767;
	}

	/** `planes` (each a channel's samples) of one block lasting `seconds` */
	#block(planes: Float32Array[], from: number, to: number, seconds: number) {
		let peak = 0;
		for (const plane of planes)
			for (let at = from; at < to; at++) {
				const sample = Math.abs(plane[at]);
				if (sample > peak) peak = sample;
			}
		const loudest = Math.min(32767, Math.round(peak * 32768));
		if (loudest > this.#loudest) this.#loudest = loudest;
		if (this.#blocks++ === 10) {
			this.#level = this.#loudest;
			this.#blocks = 0;
			this.#loudest >>= 2;
		}
		const share = loudest / 32767;
		this.energy += share * share * seconds;
		this.duration += seconds;
	}

	/** sound at `rate`, in blocks of 10 ms (a shorter last one as it is) */
	add(planes: Float32Array[], frames: number, rate: number) {
		const block = Math.max(1, Math.round(rate / 100));
		for (let at = 0; at < frames; at += block) {
			const end = Math.min(frames, at + block);
			this.#block(planes, at, end, (end - at) / rate);
		}
	}

	/** silence of `frames` at `rate` */
	quiet(frames: number, rate: number) {
		this.add([new Float32Array(frames)], frames, rate);
	}
}

/** an AudioData's channels, each as its own samples */
export function channelsOf(data: AudioData): Float32Array[] {
	const out: Float32Array[] = [];
	for (let plane = 0; plane < data.numberOfChannels; plane++) {
		const samples = new Float32Array(data.numberOfFrames);
		data.copyTo(samples, { planeIndex: plane, format: 'f32-planar' });
		out.push(samples);
	}
	return out;
}

/** the track a sender sends, as `media-source` tells it */
export interface SourceStats {
	audioLevel: number;
	totalAudioEnergy: number;
	totalSamplesDuration: number;
}

/** what a receiver played, as `inbound-rtp` and `media-playout` tell it */
export interface PlayedStats {
	audioLevel: number;
	totalAudioEnergy: number;
	totalSamplesDuration: number;
	/** at the decoder's rate (48 kHz for Opus, 8 kHz for G.711, 16 kHz for G.722) */
	totalSamplesReceived: number;
	concealedSamples: number;
	silentConcealedSamples: number;
	concealmentEvents: number;
	jitterBufferDelay: number;
	jitterBufferEmittedCount: number;
	jitterBufferTargetDelay: number;
	jitterBufferMinimumDelay: number;
	totalProcessingDelay: number;
	insertedSamplesForDeceleration: number;
	removedSamplesForAcceleration: number;
	/** the playout's own count, at 48 kHz */
	playout: {
		totalSamplesCount: number;
		totalSamplesDuration: number;
		totalPlayoutDelay: number;
	};
}

/**
 * What a receiver wrote to its track, counted as NetEq counts what it
 * hands the sound card: every sample, concealment included, at the
 * decoder's rate; the sound that came from packets as emitted, with how
 * long it waited; silence written for a missing frame as concealed. Only
 * what the track takes is counted: a track nothing plays takes nothing
 * after a few frames, as Chrome's NetEq is never asked for sound then.
 */
export class PlayedCount {
	#level = new AudioLevel();
	#counts = {
		samples: 0,
		concealed: 0,
		silent: 0,
		events: 0,
		emitted: 0,
		delay: 0,
		target: 0,
		removed: 0,
		playoutSamples: 0,
		playoutDelay: 0,
	};
	#concealing = false;

	/**
	 * `frames` at 48 kHz were written: sound from packets that came
	 * `waitedMs` before (`samples` its channels), or concealment (silence
	 * when `samples` is null), the decoder running at `rate`, the buffer
	 * aiming at `targetMs`
	 */
	wrote(
		frames: number,
		samples: Float32Array[] | null,
		concealed: boolean,
		rate: number,
		waitedMs: number,
		targetMs: number,
	) {
		const counts = this.#counts;
		const decoded = Math.round((frames * rate) / 48000);
		counts.samples += decoded;
		counts.playoutSamples += frames;
		if (samples) this.#level.add(samples, frames, 48000);
		else this.#level.quiet(frames, 48000);
		if (concealed) {
			counts.concealed += decoded;
			if (!samples) counts.silent += decoded;
			if (!this.#concealing) counts.events++;
			this.#concealing = true;
			counts.playoutDelay += (frames * targetMs) / 1000;
			return;
		}
		this.#concealing = false;
		counts.emitted += decoded;
		counts.delay += (decoded * waitedMs) / 1000;
		counts.target += (decoded * targetMs) / 1000;
		counts.playoutDelay += (frames * waitedMs) / 1000;
	}

	get stats(): PlayedStats {
		const counts = this.#counts;
		return {
			audioLevel: this.#level.level,
			totalAudioEnergy: this.#level.energy,
			totalSamplesDuration: this.#level.duration,
			totalSamplesReceived: counts.samples,
			concealedSamples: counts.concealed,
			silentConcealedSamples: counts.silent,
			concealmentEvents: counts.events,
			jitterBufferDelay: counts.delay,
			jitterBufferEmittedCount: counts.emitted,
			jitterBufferTargetDelay: counts.target,
			jitterBufferMinimumDelay: counts.target,
			totalProcessingDelay: counts.delay,
			insertedSamplesForDeceleration: 0,
			removedSamplesForAcceleration: counts.removed,
			playout: {
				totalSamplesCount: counts.playoutSamples,
				totalSamplesDuration: this.#level.duration,
				totalPlayoutDelay: counts.playoutDelay,
			},
		};
	}
}
