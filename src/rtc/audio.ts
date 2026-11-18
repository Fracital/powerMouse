// A connection's audio in the worker (docs/webrtc-over-wisp.md, section
// 16). The page hands over the two ends of a track as streams (a
// MediaStreamTrackProcessor's readable for what it sends, a
// MediaStreamTrackGenerator's writable for what it receives); here the
// sound is encoded and decoded (WebCodecs for Opus, G.711 and G.722 by
// hand) and the
// stack packetizes and depacketizes. What crosses to the stack is whole
// encoded frames with their RTP time.
import { ComfortNoise, parseNoise, type NoiseDescription } from './cn';
import { CngFramer } from './cng';
import { eventPayload, TONES, ToneSender } from './dtmf';
import type { Payload } from './formats';
import { Downsampler, g711Decode, g711Encode } from './g711';
import { g722Decode, G722Decoder, g722Encode, G722Encoder } from './g722';
import { hasLbrr, repackLbrr } from './lbrr';
import {
	AudioLevel,
	channelsOf,
	PlayedCount,
	type PlayedStats,
	type SourceStats,
} from './level';
import { Playout, type PlayoutStats } from './playout';
import {
	ABSENT,
	FLAG_CONTIGUOUS,
	FLAG_TALKSPURT,
	FLAG_VOICE,
	type Frame,
} from './records';
import { Resampler } from './resample';
import { stretch } from './stretch';

/** hands an encoded frame to the stack; `age` is how long ago it was captured, in ms */
export type FrameWriter = (frame: Frame, age: number) => void;

/** a jump in a track's timestamps longer than this is a break in the sound */
const GAP_US = 100000;
/** frames a codec may have waiting before it is taken to be stuck */
const MAX_QUEUE = 25;
/** Opus counts time at 48 kHz whatever it carries: units a microsecond */
const OPUS_UNITS = 0.048;
/** an Opus frame is a multiple of 2.5 ms */
const OPUS_STEP = 120;
/** the Opus frame this side sends: 20 ms */
const FRAME_US = 20000;
const OPUS_FRAME = 960;
/**
 * The rates WebCodecs' Opus encoder takes as they are; any other is made
 * 48 kHz here first (src/rtc/resample.ts: the encoder's own conversion
 * held each frame 10 to 40 ms)
 */
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
/** frames an encoder that leaves silence out must have skipped before its time is moved on */
const DTX_RESUME = 5;
/**
 * How much more of the track than a frame's own sound is fed before the
 * frame is taken to be one the encoder left out: the most the encoder has
 * needed before giving a frame it made (a resampling encoder needs more
 * than the frame), and one more block of the track, at least
 * `DTX_SETTLE_MS` later on the clock (a track read in a burst leaves the
 * encoder no time between blocks)
 */
const DTX_WAIT_US = 20000;
const DTX_LEAD_MAX_US = 40000;
const DTX_SETTLE_MS = 10;
/**
 * libopus leaves frames out only after ten frames without a voice: a
 * frame is taken to be left out only after `DTX_QUIET_FRAMES` frames this
 * quiet (a level, -dBov), so an encoder late with a frame of speech (a
 * loaded machine) is not taken for one that left it out
 */
const DTX_QUIET_LEVEL = 40;
const DTX_QUIET_FRAMES = 8;
/**
 * The longest run of lost Opus packets made up as lost: past it the
 * gap is a pause (a sender that left silence out), not a loss
 */
const CONCEAL_FRAMES = 5;
/** the longest a packet after a hole waits for the hole's packets */
const REORDER_MS = 100;
/** how long before a frame plays its packet is decoded at the latest */
const DECODE_MS = 10;
/** a G.711 packet: 20 ms at 8 kHz */
const G711_FRAME = 160;
/**
 * A G.722 packet: 20 ms at 16 kHz, 160 bytes. The stack counts G.722's
 * time at 16 kHz and writes half of it on the wire, the 8000 Hz clock RFC
 * 3551 gave the payload by mistake and every implementation keeps.
 */
const G722_FRAME = 320;

/**
 * The audio level a packet states (RFC 6464): how far below full scale
 * the sound's power is, in dB, 0 the loudest and 127 silence.
 */
export function levelOf(squares: number, count: number): number {
	if (!count || squares <= 0) return 127;
	const level = Math.round(-10 * Math.log10(squares / count));
	return level < 0 ? 0 : level > 127 ? 127 : level;
}

/**
 * A frame's samples as one channel (the mean of its channels) or as two
 * (the first two; one channel twice), one plane after the other
 */
export function planes(
	data: AudioData,
	channels: 1 | 2,
): Float32Array<ArrayBuffer> {
	const frames = data.numberOfFrames;
	const have = data.numberOfChannels;
	const out = new Float32Array(frames * channels);
	const first = out.subarray(0, frames);
	data.copyTo(first, { planeIndex: 0, format: 'f32-planar' });
	if (channels === 2) {
		if (have > 1)
			data.copyTo(out.subarray(frames), {
				planeIndex: 1,
				format: 'f32-planar',
			});
		else out.copyWithin(frames, 0, frames);
	} else if (have > 1) {
		const other = new Float32Array(frames);
		for (let plane = 1; plane < have; plane++) {
			data.copyTo(other, { planeIndex: plane, format: 'f32-planar' });
			for (let at = 0; at < frames; at++) first[at] += other[at];
		}
		for (let at = 0; at < frames; at++) first[at] /= have;
	}
	return out;
}

function power(samples: Float32Array): number {
	let squares = 0;
	for (let at = 0; at < samples.length; at++)
		squares += samples[at] * samples[at];
	return squares;
}

// --- sending ---

export interface SenderStats {
	frames: number;
	bytes: number;
}

/**
 * What a track's sound becomes on the wire. The track is read whether or
 * not anything is sent (a track nobody reads piles up); it is encoded only
 * while the section sends and the connection is up.
 */
export class AudioSender {
	/** the stack's index of the section this sends on */
	media: number;
	#write: FrameWriter;
	#payload: Payload | null = null;
	#active = false;
	#reader: ReadableStreamDefaultReader<AudioData> | null = null;
	#encoder: AudioEncoder | null = null;
	/** the input the encoder was made for */
	#rate = 0;
	#channels = 0;
	/** that input at 48 kHz, when the encoder does not take its rate, and the time of what it has made */
	#resampler: Resampler | null = null;
	#resampled = 0;
	/** the encoder leaves silence out (the peer's `usedtx=1`) */
	#dtx = false;
	/**
	 * With `usedtx`, the time (on the encoder's count) of the frame after
	 * the last one the encoder made, which it may leave out; whether it
	 * is the first left out since (sent as a packet of the last frame's
	 * table of contents byte alone, as Chrome sends it); and when its
	 * sound was all in the encoder
	 */
	#gap: number | null = null;
	#gapToc = 0;
	#gapFirst = false;
	#gapDue = 0;
	/** how far past a frame's sound the track had been fed when the encoder gave it, in microseconds */
	#lead = 0;
	/** frames the encoder made in a row that were quiet */
	#quiet = 0;
	/** an input no encoder could be made for, not to be tried on every frame */
	#refused = '';
	/** RTP times start at a number of the sender's own */
	#offset = crypto.getRandomValues(new Uint32Array(1))[0];
	/**
	 * An unbroken run of the track's sound: the encoder counts time from
	 * the run's first frame (its timestamp, in microseconds), whatever the
	 * later frames' timestamps say
	 */
	#epoch: number | null = null;
	/** where the track's timestamps should go on */
	#expected: number | null = null;
	/** how far the run has been fed, on the encoder's count, and when */
	#fedUs = 0;
	#fedAt = 0;
	/** how long the track's blocks are (10 ms, from Chrome's capture), in microseconds */
	#blockUs = 10000;
	/** the power of what was fed since the last frame went out */
	#squares = 0;
	#count = 0;
	/** the time the last frame of this run ended at, on the track's own count */
	#last: number | null = null;
	/**
	 * The sender's own time. A track's times start anywhere (a track a page
	 * writes itself reads below zero here) and another track's start
	 * somewhere else, so the times that go out are the sender's: a run
	 * goes on from the last frame sent, by as much as the clock has moved
	 * since, and within a run they are the encoder's count.
	 */
	#shift = 0;
	/** a run has begun and its first frame has yet to place it */
	#placed = false;
	/** where the last frame sent ended on the sender's time, in which clock, and when */
	#sentEnd = 0;
	#sentRate = 0;
	#sentAt = 0;
	#down: Downsampler | null = null;
	#pcm = new Float32Array(G722_FRAME);
	#g722: G722Encoder | null = null;
	#fill = 0;
	#made = 0;
	/**
	 * The comfort noise payload, with G.711 or G.722 when the section
	 * negotiated CN at 8000 Hz (Chrome's condition), and what decides each
	 * packet: speech, a comfort noise packet or nothing (src/rtc/cng.ts)
	 */
	#noise: Payload | null = null;
	#framer: CngFramer | null = null;
	#blocks = new Int16Array(G722_FRAME);
	/** the telephone-event payload DTMF goes on, and the tones to play */
	#event: Payload | null = null;
	#tones = new ToneSender();
	stats: SenderStats = { frames: 0, bytes: 0 };

	constructor(media: number, write: FrameWriter) {
		this.media = media;
		this.#write = write;
	}

	/** the track's frames (a MediaStreamTrackProcessor's readable), or null for no track */
	/**
	 * The track as its stats entry (media-source) tells it: measured from
	 * when a description of this side has the section (Chrome's counts
	 * start there), and anew for each track
	 */
	#source: AudioLevel | null = null;
	#measuring = false;

	/** a local description has the section: the track is measured from now */
	measure() {
		if (this.#measuring) return;
		this.#measuring = true;
		this.#source = new AudioLevel();
	}

	get source(): SourceStats | null {
		const level = this.#source;
		return (
			level && {
				audioLevel: level.level,
				totalAudioEnergy: level.energy,
				totalSamplesDuration: level.duration,
			}
		);
	}

	/** what is sent: its payload type and, for Opus, the encoder's bitrate */
	get sending(): { pt: number; bitrate: number } | null {
		const payload = this.#payload;
		if (!payload) return null;
		const name = payload.name.toLowerCase();
		const limit = Number(payload.parameters.maxaveragebitrate);
		const bitrate =
			name !== 'opus'
				? 64000
				: limit >= 6000 && limit <= 510000
					? limit
					: payload.parameters.stereo === '1'
						? 64000
						: 32000;
		return { pt: payload.pt, bitrate };
	}

	setTrack(readable: ReadableStream<AudioData> | null) {
		const old = this.#reader;
		this.#reader = null;
		old?.cancel().catch(() => {});
		this.#restart();
		if (this.#measuring) this.#source = new AudioLevel();
		if (!readable) return;
		const reader = readable.getReader();
		this.#reader = reader;
		void this.#pump(reader);
	}

	/** the payload to send: the first the section negotiated that can be encoded here */
	configure(payloads: Payload[]) {
		const payload =
			payloads.find((candidate) =>
				['opus', 'g722', 'pcmu', 'pcma'].includes(candidate.name.toLowerCase()),
			) ?? null;
		this.#event = payload ? eventPayload(payloads) : null;
		this.#noise =
			payload && payload.name.toLowerCase() !== 'opus'
				? (payloads.find(
						(candidate) =>
							candidate.name.toLowerCase() === 'cn' && candidate.clock === 8000,
					) ?? null)
				: null;
		if (JSON.stringify(payload) === JSON.stringify(this.#payload)) return;
		this.#payload = payload;
		this.#restart();
	}

	/** whether the section negotiated a payload for DTMF */
	get canTone(): boolean {
		return this.#event !== null;
	}

	/**
	 * A tone of the page's RTCDTMFSender (one of TONES), for `ms`: it goes
	 * out with the next frames the track makes, as Chrome's does
	 */
	tone(tone: string, ms: number) {
		const code = TONES.indexOf(tone.toUpperCase());
		if (code !== -1 && tone.length === 1 && this.#event)
			this.#tones.add(code, ms);
	}

	/** whether the section sends now (its direction, and a connection that is up) */
	setActive(active: boolean) {
		if (this.#active === active) return;
		this.#active = active;
		this.#restart();
	}

	close() {
		this.setTrack(null);
		this.#tones.clear();
	}

	async #pump(reader: ReadableStreamDefaultReader<AudioData>) {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				try {
					if (this.#reader === reader) {
						this.#source?.add(
							channelsOf(value),
							value.numberOfFrames,
							value.sampleRate,
						);
						this.#input(value);
					}
				} finally {
					value.close();
				}
				if (this.#reader !== reader) break;
			}
		} catch (error) {
			// the track ended
		}
	}

	/** a new run: the encoder and everything counted since the last one go */
	#restart() {
		const encoder = this.#encoder;
		this.#encoder = null;
		if (encoder && encoder.state !== 'closed') encoder.close();
		this.#epoch = null;
		this.#expected = null;
		this.#last = null;
		this.#placed = false;
		this.#down = null;
		this.#resampler = null;
		this.#resampled = 0;
		this.#g722 = null;
		this.#framer = null;
		this.#fill = 0;
		this.#made = 0;
		this.#squares = 0;
		this.#count = 0;
		this.#gap = null;
		this.#lead = 0;
		this.#quiet = 0;
	}

	#input(data: AudioData) {
		const payload = this.#payload;
		if (!this.#active || !payload) return;
		const duration = (data.numberOfFrames / data.sampleRate) * 1e6;
		this.#blockUs = duration;
		// the track stopped for a while (muted, a source that paused): what
		// comes now is a new run, at its own time
		if (
			this.#expected !== null &&
			Math.abs(data.timestamp - this.#expected) > GAP_US
		)
			this.#restart();
		this.#expected = data.timestamp + duration;
		const name = payload.name.toLowerCase();
		if (name === 'opus') this.#opus(data, payload, duration);
		else if (name === 'g722') this.#narrow(data, payload, duration, 16000);
		else this.#narrow(data, payload, duration, 8000);
	}

	#opus(data: AudioData, payload: Payload, duration: number) {
		// one channel unless the peer asked for two, as the browser sends
		const channels = payload.parameters.stereo === '1' ? 2 : 1;
		if (
			!this.#encoder ||
			this.#rate !== data.sampleRate ||
			this.#channels !== channels
		) {
			const expected = this.#expected;
			this.#restart();
			this.#expected = expected;
			this.#start(payload, data.sampleRate, channels);
		}
		const encoder = this.#encoder;
		if (!encoder) return;
		if (encoder.encodeQueueSize > MAX_QUEUE) {
			// the encoder does not keep up: this much is lost
			this.#restart();
			return;
		}
		if (this.#epoch === null) {
			this.#epoch = data.timestamp;
			this.#fedUs = data.timestamp;
		}
		const samples = planes(data, channels);
		this.#squares += power(samples);
		this.#count += samples.length;
		// the encoder takes only what it was configured for: these
		// channels, at its rate (each output sample of the resampler is
		// at the time of the input it stands for)
		const resampler = this.#resampler;
		let input: AudioData | null = data;
		if (resampler) {
			const made = resampler.push(samples, data.numberOfFrames);
			input = made.frames
				? new AudioData({
						format: 'f32-planar',
						sampleRate: 48000,
						numberOfFrames: made.frames,
						numberOfChannels: channels,
						timestamp: this.#epoch + (this.#resampled / 48000) * 1e6,
						data: made.samples,
					})
				: null;
			this.#resampled += made.frames;
		} else if (data.numberOfChannels !== channels)
			input = new AudioData({
				format: 'f32-planar',
				sampleRate: data.sampleRate,
				numberOfFrames: data.numberOfFrames,
				numberOfChannels: channels,
				timestamp: data.timestamp,
				data: samples,
			});
		try {
			if (input) encoder.encode(input);
		} catch (error) {
			this.#restart();
			return;
		} finally {
			if (input && input !== data) input.close();
		}
		this.#fedUs += duration;
		this.#fedAt = performance.now();
		if (this.#dtx) this.#leftOut(payload);
	}

	/**
	 * The frames an encoder told `usedtx` left out (WebCodecs' Opus encoder
	 * gives no output for a frame of silence libopus makes a one byte
	 * packet of). Chrome's own sender sends the first of them, that byte
	 * alone, so the far end's jitter buffer knows the silence for what it
	 * is (without it, it conceals all of it), and hands each of them to a
	 * transform of the sender as an empty frame, which is not sent; every
	 * 21st frame of a silence the encoder makes, as Chrome's does
	 * (measured on 157). A frame is taken to be left out once its sound
	 * and more (`DTX_WAIT_US`) are in the encoder with no output for it,
	 * after `DTX_QUIET_FRAMES` quiet ones.
	 */
	#leftOut(payload: Payload) {
		const epoch = this.#epoch;
		if (this.#gap === null || epoch === null || this.#quiet < DTX_QUIET_FRAMES)
			return;
		const base = Math.round(epoch * OPUS_UNITS);
		const now = performance.now();
		// (a frame a block at most: a block is half a frame, so a backlog is
		// soon made up)
		const index = (this.#gap - base) / OPUS_FRAME;
		const end = epoch + (index + 1) * FRAME_US + this.#lead;
		if (this.#fedUs < end) return;
		if (!this.#gapDue) this.#gapDue = now;
		if (this.#fedUs < end + DTX_WAIT_US || now - this.#gapDue < DTX_SETTLE_MS)
			return;
		const time = this.#gap;
		const age = this.#ageOf(epoch + index * FRAME_US);
		this.#gap += OPUS_FRAME;
		this.#gapDue = 0;
		if (this.#gapFirst) {
			this.#gapFirst = false;
			this.#send(
				payload.pt,
				48000,
				time,
				OPUS_FRAME,
				Uint8Array.of(this.#gapToc),
				age,
			);
		} else {
			// (with the level of its sound, as Chrome's)
			const level = levelOf(this.#squares, this.#count);
			this.#squares = 0;
			this.#count = 0;
			this.#write(
				{
					media: this.media,
					pt: payload.pt,
					flags: 0,
					level,
					orientation: ABSENT,
					time: BigInt(time + this.#shift + this.#offset),
					rid: '',
					payload: new Uint8Array(0),
				},
				Math.max(0, age),
			);
		}
	}

	/**
	 * How long ago, in ms, a frame whose first sample is at `start` (on the
	 * track's time, in microseconds) was captured, as Chrome dates it: when
	 * the block of the track that holds that sample was delivered (Chrome's
	 * sender stamps a frame with its first 10 ms block's capture time, so
	 * its frames reach a transform 10 ms after it, measured on 157)
	 */
	#ageOf(start: number): number {
		const epoch = this.#epoch ?? start;
		const block = this.#blockUs;
		const delivered =
			epoch + (Math.floor((start - epoch) / block + 1e-6) + 1) * block;
		return performance.now() - this.#fedAt + (this.#fedUs - delivered) / 1000;
	}

	#start(payload: Payload, rate: number, channels: number) {
		const key = `${rate}/${channels}/${payload.pt}`;
		if (this.#refused === key) return;
		const parameters = payload.parameters;
		const limit = Number(parameters.maxaveragebitrate);
		try {
			const encoder: AudioEncoder = new AudioEncoder({
				output: (chunk) => this.#chunk(encoder, payload, chunk),
				error: () => {
					if (this.#encoder === encoder) this.#restart();
				},
			});
			const resample = !OPUS_RATES.includes(rate);
			encoder.configure({
				codec: 'opus',
				sampleRate: resample ? 48000 : rate,
				numberOfChannels: channels,
				// the browser's own rates for a voice and for stereo
				bitrate:
					limit >= 6000 && limit <= 510000
						? limit
						: channels === 2
							? 64000
							: 32000,
				bitrateMode: parameters.cbr === '1' ? 'constant' : 'variable',
				opus: {
					format: 'opus',
					frameDuration: FRAME_US,
					application: 'voip',
					useinbandfec: parameters.useinbandfec === '1',
					usedtx: parameters.usedtx === '1',
				} as OpusEncoderConfig,
			});
			this.#encoder = encoder;
			this.#resampler = resample ? new Resampler(rate, 48000, channels) : null;
			this.#resampled = 0;
			this.#dtx = parameters.usedtx === '1';
			this.#rate = rate;
			this.#channels = channels;
		} catch (error) {
			this.#refused = key;
		}
	}

	#chunk(encoder: AudioEncoder, payload: Payload, chunk: EncodedAudioChunk) {
		if (encoder !== this.#encoder || this.#epoch === null) return;
		const bytes = new Uint8Array(chunk.byteLength);
		chunk.copyTo(bytes);
		// The encoder's time is the run's first timestamp and what it has
		// counted since, rounded to a microsecond. An encoder that leaves
		// silence out (usedtx) counts only the frames it makes, so its time
		// stands still while nothing is said: there the frame's time is
		// where the run has been fed to, and frames follow each other
		// unless that is well past them.
		let counted =
			Math.round(((chunk.timestamp - this.#epoch) * OPUS_UNITS) / OPUS_STEP) *
			OPUS_STEP;
		// (a frame placed where the run was fed to, after frames left out)
		let resumed = false;
		if (this.#dtx) {
			const fed =
				(Math.floor((this.#fedUs - this.#epoch) / FRAME_US) - 1) * OPUS_FRAME;
			const follows =
				this.#last === null
					? 0
					: this.#last - Math.round(this.#epoch * OPUS_UNITS);
			counted = fed - follows >= DTX_RESUME * OPUS_FRAME ? fed : follows;
			resumed = counted !== follows;
			this.#quiet =
				levelOf(this.#squares, this.#count) >= DTX_QUIET_LEVEL
					? this.#quiet + 1
					: 0;
		}
		this.#send(
			payload.pt,
			48000,
			Math.round(this.#epoch * OPUS_UNITS) + counted,
			Math.round((chunk.duration ?? FRAME_US) * OPUS_UNITS),
			bytes,
			this.#ageOf(this.#epoch + counted / OPUS_UNITS),
		);
		if (this.#dtx && bytes.length) {
			// (a frame that follows the last: its place on the track is known)
			if (!resumed) {
				const lead =
					this.#fedUs - this.#epoch - (counted / OPUS_FRAME + 1) * FRAME_US;
				if (lead >= this.#lead) this.#lead = Math.min(DTX_LEAD_MAX_US, lead);
				else this.#lead = Math.max(0, this.#lead - 100);
			}
			this.#gap = this.#last;
			// the same configuration and channels, one frame (code 0)
			this.#gapToc = bytes[0] & 0xfc;
			this.#gapFirst = true;
			this.#gapDue = 0;
		}
	}

	/** G.711 at 8 kHz or G.722 at 16 kHz, both encoded here: WebCodecs has neither encoder */
	#narrow(data: AudioData, payload: Payload, duration: number, rate: number) {
		if (data.sampleRate < rate) return;
		if (this.#epoch === null || this.#rate !== data.sampleRate || !this.#down) {
			const expected = this.#expected;
			this.#restart();
			this.#expected = expected;
			this.#rate = data.sampleRate;
			this.#epoch = data.timestamp;
			this.#fedUs = data.timestamp;
			this.#down = new Downsampler(data.sampleRate, rate);
			// G.722 predicts from what it sent before: one state per run
			if (rate === 16000) this.#g722 = new G722Encoder();
		}
		const samples = planes(data, 1);
		this.#squares += power(samples);
		this.#count += samples.length;
		const narrow = this.#down.push(samples);
		const law = payload.name.toUpperCase() === 'PCMA' ? 'PCMA' : 'PCMU';
		const frame = rate === 16000 ? G722_FRAME : G711_FRAME;
		const pcm = this.#pcm.subarray(0, frame);
		for (let at = 0; at < narrow.length;) {
			const take = Math.min(frame - this.#fill, narrow.length - at);
			pcm.set(narrow.subarray(at, at + take), this.#fill);
			this.#fill += take;
			at += take;
			if (this.#fill < frame) break;
			this.#fill = 0;
			const time =
				Math.round((this.#epoch * rate) / 1e6) + this.#made++ * frame;
			// the packet's first sample was read 20 ms before its last, its
			// first block a block after that (Chrome dates a frame from it)
			const age =
				20 + ((narrow.length - at) * 1000) / rate - this.#blockUs / 1000;
			const decided = this.#decide(pcm, time, rate);
			if (decided === 'speech')
				this.#send(
					payload.pt,
					rate,
					time,
					frame,
					this.#g722 ? g722Encode(this.#g722, pcm) : g711Encode(law, pcm),
					age,
				);
			else this.#send(payload.pt, rate, time, frame, decided, age, true);
		}
		this.#fedUs += duration;
		this.#fedAt = performance.now();
	}

	/**
	 * With comfort noise negotiated, what a packet of G.711 or G.722 is,
	 * as Chrome's AudioEncoderCng decides (WebRTC's voice detector in its
	 * normal mode, over the packet's two blocks of 10 ms): 'speech', or
	 * the comfort noise packet that goes in its place, or null for nothing
	 */
	#decide(
		pcm: Float32Array,
		time: number,
		rate: number,
	): 'speech' | Uint8Array | null {
		if (!this.#noise) return 'speech';
		this.#framer ??= new CngFramer(rate);
		// the samples as Chrome takes a track's into its 16 bits (measured
		// on 152 and 156: 32768 below zero, 32767 above, toward zero)
		const blocks = this.#blocks.subarray(0, pcm.length);
		for (let at = 0; at < pcm.length; at++) {
			const value = pcm[at] < -1 ? -1 : pcm[at] > 1 ? 1 : pcm[at];
			blocks[at] = Math.trunc(value * (value < 0 ? 32768 : 32767));
		}
		const half = pcm.length / 2;
		this.#framer.push(blocks.subarray(0, half), time);
		const packet = this.#framer.push(blocks.subarray(half), time + half);
		return !packet || packet.speech ? 'speech' : packet.sid;
	}

	/**
	 * A frame to the stack: encoded speech, or with `passive` a comfort
	 * noise packet (`payload`) or nothing (null), which a passive packet
	 * sends in place of the speech. Either way the frame's time passes
	 * (a telephone event under way goes out in its place) and its level
	 * is counted afresh, as Chrome's sender does with the empty frames of
	 * a silence.
	 */
	#send(
		pt: number,
		rate: number,
		time: number,
		length: number,
		payload: Uint8Array | null,
		age: number,
		passive = false,
	) {
		const now = performance.now();
		if (!this.#placed) {
			this.#placed = true;
			// The run's place on the sender's time. The first run starts
			// it. A later one starts where the clock says: the last frame
			// sent ended when it went out, and this one ends now. A run of
			// the same track that the track's own times put within a
			// tenth of a second of that keeps them (an encoder made
			// again in the middle of a sound).
			let place = 0;
			if (this.#sentRate) {
				const end = Math.round((this.#sentEnd * rate) / this.#sentRate);
				const step = rate / 400;
				place = Math.max(
					end,
					end +
						Math.round(((now - this.#sentAt) * rate) / 1000 / step) * step -
						length,
				);
				const kept = time + this.#shift;
				if (
					rate === this.#sentRate &&
					kept >= end &&
					Math.abs(kept - place) <= rate / 10
				)
					place = kept;
			}
			this.#shift = place - time;
		}
		const at = time + this.#shift;
		this.#sentEnd = at + length;
		this.#sentRate = rate;
		this.#sentAt = now;
		const level = levelOf(this.#squares, this.#count);
		this.#squares = 0;
		this.#count = 0;
		// with comfort noise the voice bit is the detector's: set on every
		// packet of speech, its silent hangover too (measured)
		let flags = level < 127 || this.#noise ? FLAG_VOICE : 0;
		// the first frame of a run, or after frames the encoder left out
		// (silence it did not send, comfort noise in its place)
		if (this.#last !== time) flags |= FLAG_TALKSPURT;
		if (!passive) this.#last = time + length;
		// a payload of 8000 Hz on the wire's clock (G.722's is half the
		// stack's count)
		const wire =
			this.#payload?.name.toLowerCase() === 'g722'
				? Math.floor((at + this.#offset) / 2)
				: at + this.#offset;
		const event = this.#event;
		if (event) {
			// a tone under way goes out in place of the frame
			const tones = this.#tones.frame(wire, event.clock, now);
			if (tones) {
				for (const tone of tones)
					this.#write(
						{
							media: this.media,
							pt: event.pt,
							flags: tone.marker ? FLAG_TALKSPURT : 0,
							level: ABSENT,
							orientation: ABSENT,
							time: BigInt(tone.time),
							rid: '',
							payload: tone.payload,
						},
						Math.max(0, age),
					);
				return;
			}
		}
		if (!payload) return;
		this.stats.frames++;
		this.stats.bytes += payload.length;
		// Chrome's comfort noise packets are never marked and say no voice
		// is speaking; the speech after them is marked
		const noise = passive ? this.#noise : null;
		this.#write(
			{
				media: this.media,
				pt: noise ? noise.pt : pt,
				flags: noise ? 0 : flags,
				level,
				orientation: ABSENT,
				time: BigInt(noise ? wire : at + this.#offset),
				rid: '',
				payload,
			},
			Math.max(0, age),
		);
	}
}

// --- receiving ---

/** decoded sound at 48 kHz: one plane after the other */
interface Sound {
	samples: Float32Array<ArrayBuffer>;
	frames: number;
	channels: number;
	/** when its packet came (performance.now()) */
	arrived?: number;
	/** a comfort noise packet: from its time on, noise plays until speech does */
	noise?: NoiseDescription;
	/** a telephone event's tones */
	tone?: boolean;
}

/** a comfort noise packet stands for this much at least */
const NOISE_MS = 20;
/** the rate comfort noise is made at after each speech codec, as Chrome's decoders run */
const NOISE_RATES = { opus: 48000, G711: 8000, G722: 16000 };
/** a telephone event is played 20 ms at a time */
const TONE_FRAME = 960;
/** DTMF's frequencies (RFC 4733, 3.2): the row and the column of each event code */
const ROWS = [697, 770, 852, 941];
const COLUMNS = [1209, 1336, 1477, 1633];
const KEYS = '31 00 01 02 10 11 12 20 21 22 30 32 03 13 23 33'.split(' ');

/**
 * `frames` samples of an event's two tones from `from` on (48 kHz), at the
 * levels Chrome's NetEq plays them (measured: 9.2 dB and, for the column's
 * tone, 6.2 dB below full scale more than the event's volume)
 */
function toneSamples(
	code: number,
	volume: number,
	from: number,
	frames: number,
): Float32Array<ArrayBuffer> {
	const key = KEYS[code];
	const low = ROWS[Number(key[0])];
	const high = COLUMNS[Number(key[1])];
	const a = 10 ** ((-9.2 - volume) / 20);
	const b = 10 ** ((-6.2 - volume) / 20);
	const out = new Float32Array(frames);
	for (let at = 0; at < frames; at++) {
		const t = (from + at) / 48000;
		out[at] =
			a * Math.sin(2 * Math.PI * low * t) +
			b * Math.sin(2 * Math.PI * high * t);
	}
	return out;
}
/** sound kept of what was played, for a frame that has to be made up: 40 ms */
const HISTORY = 1920;
/** the periods a made-up frame repeats are looked for between 10 and 20 ms */
const LAG_LOW = 480;
const LAG_HIGH = 960;
/** a frame played after made-up sound fades in over this many samples */
const MERGE = 120;
/** where a frame played after made-up sound starts is found over this many samples */
const ALIGN = 240;
/**
 * and starts at most this far in (2.5 ms): each loss shortens the delay by
 * about what NetEq's expand and merge take off it (measured with a tenth
 * of the packets lost and no copies: Chrome's 850 to 900 samples made up
 * a loss, its buffer kept at its lower limit; skipping up to a whole
 * period, 10 to 20 ms, held it 5 ms under Chrome's)
 */
const SKIP = 120;

/**
 * How much of its level made-up sound loses a frame: little for a sound
 * that repeats well (Chrome's goes on unmuted through 300 ms of packets
 * held up, measured), nearly half for one that does not
 */
function fadeOf(alike: number): number {
	return alike > 0.7 ? 0.05 : 0.45;
}

/**
 * How long a period of the last sound played is (`LAG_LOW` to `LAG_HIGH`
 * samples), and how alike its repeats are (normalized correlation)
 */
function periodOf(history: Float32Array): { lag: number; alike: number } {
	const end = history.length;
	let lag = LAG_HIGH;
	let alike = 0;
	for (let candidate = LAG_LOW; candidate <= LAG_HIGH; candidate++) {
		let cross = 0;
		let now = 0;
		let then = 0;
		for (let at = end - LAG_LOW; at < end; at++) {
			cross += history[at] * history[at - candidate];
			now += history[at] * history[at];
			then += history[at - candidate] * history[at - candidate];
		}
		const value = now && then ? cross / Math.sqrt(now * then) : 0;
		if (value > alike) {
			alike = value;
			lag = candidate;
		}
	}
	return { lag, alike };
}

/** how long after the last frame the receiver's clock stops */
const IDLE_MS = 2000;
/** a clock this far behind starts again from now (the worker stalled) */
const LAG_MS = 200;
/** written frames nobody has taken before more are not written */
const BACKLOG = 25;
/** a frame of the track, in samples at 48 kHz */
const TRACK_FRAME = 960;

/** a received frame, as the stack hands it over */
export interface Received {
	codec: string;
	/** the payload type, for a telephone event's clock */
	pt?: number;
	time: bigint;
	payload: Uint8Array;
	/** FLAG_CONTIGUOUS: nothing was lost before it; FLAG_TALKSPURT: it starts a talkspurt */
	flags?: number;
}

export interface ReceiverStats extends PlayoutStats {
	/** frames the stack handed over */
	frames: number;
	bytes: number;
	/** frames written to the track, silence among them */
	written: number;
	/** lost Opus packets made up (not rebuilt from a copy) */
	concealed: number;
	/** Opus packets that carried a copy of the one before (in-band FEC), as Chrome counts them */
	fecPacketsReceived: number;
	/** of those, the copies not needed: the packet they copy had come */
	fecPacketsDiscarded: number;
}

/**
 * What the wire's frames become on a track: decoded as they arrive, held
 * as long as the arrivals vary (playout.ts), and written a frame at a time
 * on the receiver's own clock, with silence where one is missing.
 */
export class AudioReceiver {
	#playout = new Playout<Sound>({ rate: 48 });
	#writer: WritableStreamDefaultWriter<AudioData> | null = null;
	#decoder: AudioDecoder | null = null;
	/** the frames the decoder has not answered yet: it answers in order */
	#waiting: { time: number; arrived: number }[] = [];
	/** a frame with two channels was seen: the track carries two from then on */
	#stereo = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	/** when the next frame is due on the track */
	#due = 0;
	/** the track's own time, in microseconds: a steady count of what was written */
	#clock: number | null = null;
	/** sound decoded or made up and not yet written (NetEq's sync buffer), planar */
	#pending: { samples: Float32Array; frames: number; channels: number }[] = [];
	#pendingFrames = 0;
	#heard = 0;
	#started = false;
	/** the last G.711 or G.722 sample, which the next packet's first is drawn from */
	#previous = 0;
	/** G.722 decodes from its own reconstruction: one state for the stream */
	#g722 = new G722Decoder();
	#counts = { frames: 0, bytes: 0, written: 0 };
	/** lost Opus packets made up (not rebuilt from a copy) */
	#concealed = 0;
	/** Opus packets with an FEC copy, and those whose copy rebuilt a lost one */
	#fec = { received: 0, used: 0 };
	/**
	 * What the sound is being decoded from: the clock comfort noise and
	 * telephone events are placed on (Chrome's sender stamps them on the
	 * audio's) and the rate the noise is made at (Chrome's NetEq makes it at
	 * the decoder's: white to 4 kHz after G.711, to 24 kHz after Opus)
	 */
	#speech: 'opus' | 'G711' | 'G722' = 'G711';
	/** the noise a comfort noise packet described */
	#noise = new ComfortNoise(8000);
	/** the clock of each telephone-event payload the section negotiated */
	#eventClocks = new Map<number, number>();
	/** the telephone event playing: where it starts on the track's count, how much is made */
	#tone: {
		start: number;
		code: number;
		volume: number;
		made: number;
	} | null = null;
	/** the last sound played, each channel's, for a frame to be made up */
	#history = [new Float32Array(HISTORY), new Float32Array(HISTORY)];
	/** sound being made up: the period repeated, where in it, and how many frames */
	#expansion: {
		period: Float32Array[];
		at: number;
		frames: number;
		alike: number;
	} | null = null;
	/**
	 * Sound has been played since the stream started: from then on the
	 * track has a frame every 20 ms, made up or silent where none came, as
	 * NetEq hands the sound card a frame every 10 ms
	 */
	#playing = false;
	/**
	 * The track has sound now: called when the first sound after a frame
	 * arrived is written to the track (Chrome's remote track unmutes when
	 * its first audio plays, not when its first packet comes), or at once
	 * where there is no track to write to
	 */
	onStart: (() => void) | null = null;
	/** a frame arrived and `onStart` waits for its sound to be written */
	#starting = false;
	/** the next frame heard is a start again (the section had stopped receiving) */
	rearm() {
		this.#started = false;
	}

	get stats(): ReceiverStats {
		return {
			...this.#playout.stats,
			...this.#counts,
			concealed: this.#concealed,
			fecPacketsReceived: this.#fec.received,
			fecPacketsDiscarded: this.#fec.received - this.#fec.used,
		};
	}

	/** what was played, as the receiver's stats entries tell it */
	#played = new PlayedCount();
	get played(): PlayedStats & {
		packetsDiscarded: number;
		fecPacketsReceived: number;
		fecPacketsDiscarded: number;
	} {
		const stats = this.#played.stats;
		const { removedMs, insertedMs, late } = this.#playout.stats;
		// (at the decoder's rate)
		const rate = NOISE_RATES[this.#speech];
		stats.removedSamplesForAcceleration = Math.round((removedMs * rate) / 1000);
		stats.insertedSamplesForDeceleration = Math.round(
			(insertedMs * rate) / 1000,
		);
		return {
			...stats,
			packetsDiscarded: late,
			// packets that carried an FEC copy, and those whose copy was not
			// needed, as NetEq counts them
			fecPacketsReceived: this.#fec.received,
			fecPacketsDiscarded: this.#fec.received - this.#fec.used,
		};
	}

	/** what the section negotiated: the telephone-event payloads' clocks */
	configure(payloads: Payload[]) {
		this.#eventClocks.clear();
		for (const payload of payloads)
			if (payload.name.toLowerCase() === 'telephone-event')
				this.#eventClocks.set(payload.pt, payload.clock);
	}

	/** the track's sink (a MediaStreamTrackGenerator's writable), or null */
	setTrack(writable: WritableStream<AudioData> | null) {
		// (a start nothing will be written for now is told at once)
		if (!writable && this.#starting) {
			this.#starting = false;
			this.onStart?.();
		}
		const old = this.#writer;
		this.#writer = null;
		old?.close().catch(() => {});
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#playout.clear();
		this.#expansion = null;
		this.#pending = [];
		this.#pendingFrames = 0;
		this.#reorder = [];
		this.#lastHeard = null;
		if (this.#reorderTimer !== null) clearTimeout(this.#reorderTimer);
		this.#reorderTimer = null;
		if (writable) this.#writer = writable.getWriter();
	}

	close() {
		this.setTrack(null);
		this.#closeDecoder();
	}

	#closeDecoder() {
		const decoder = this.#decoder;
		this.#decoder = null;
		this.#waiting = [];
		if (decoder && decoder.state !== 'closed') decoder.close();
	}

	/** a frame from the stack */
	frame(frame: Received, now = performance.now()) {
		this.#counts.frames++;
		this.#counts.bytes += frame.payload.length;
		if (!this.#started) {
			this.#started = true;
			if (this.#writer) this.#starting = true;
			else this.onStart?.();
		}
		if (!this.#writer) return;
		// the stack's count runs below zero when a sender's times jump back
		// (it reads them as a wrap the other way); as a signed number it
		// keeps its precision, and the playout buffer starts over
		const time = Number(BigInt.asIntN(64, frame.time));
		if (frame.codec === 'opus') {
			this.#speak('opus');
			this.#take(frame.payload, time, now, frame.flags ?? FLAG_CONTIGUOUS);
		} else if (frame.codec === 'PCMU' || frame.codec === 'PCMA') {
			this.#speak('G711');
			// 8 kHz on the wire, 48 kHz on the track
			this.#hold(
				time * 6,
				this.#widen(g711Decode(frame.codec, frame.payload), 6),
				1,
				now,
			);
		} else if (frame.codec === 'G722') {
			this.#speak('G722');
			// 16 kHz (the stack's count of it), 48 kHz on the track
			this.#hold(
				time * 3,
				this.#widen(g722Decode(this.#g722, frame.payload), 3),
				1,
				now,
			);
		} else if (frame.codec === 'CN') {
			// noise from the packet's time on, until speech comes again
			const noise = parseNoise(frame.payload);
			if (!noise) return;
			const frames = Math.round(NOISE_MS * 48);
			this.#playout.push(
				time * this.#scale(),
				frames,
				{ samples: new Float32Array(0), frames, channels: 1, noise },
				now,
				0,
				// (NetEq's delay manager leaves comfort noise and events out)
				true,
			);
		} else if (frame.codec === 'telephone-event') this.#event(frame, time, now);
		else return;
		this.#heard = now;
		if (this.#timer === null) {
			this.#due = now;
			this.#timer = setTimeout(this.#tick, 0);
		}
	}

	/** the speech codec now: comfort noise is made at its rate */
	#speak(codec: 'opus' | 'G711' | 'G722') {
		if (this.#speech === codec) return;
		this.#speech = codec;
		this.#noise = new ComfortNoise(NOISE_RATES[codec]);
	}

	/** a time on the stack's count of a noise or event payload, as the track counts it */
	#scale(): number {
		// stamped on the audio's RTP clock: Opus counts at 48 kHz, G.711
		// and G.722 at 8000 on the wire
		return this.#speech === 'opus' ? 1 : 6;
	}

	/**
	 * A telephone event (RFC 4733): Chrome's NetEq plays it as its two
	 * tones in place of the sound of its time, so does this, a frame at a
	 * time as its duration grows
	 */
	#event(frame: Received, time: number, now: number) {
		const bytes = frame.payload;
		if (bytes.length < 4 || bytes[0] >= TONES.length) return;
		const start = time * this.#scale();
		const end = (bytes[1] & 0x80) !== 0;
		const clock = this.#eventClocks.get(frame.pt ?? -1) ?? 8000;
		const length = Math.round((((bytes[2] << 8) | bytes[3]) * 48000) / clock);
		let tone = this.#tone;
		if (!tone || tone.start !== start || tone.code !== bytes[0])
			tone = this.#tone = {
				start,
				code: bytes[0],
				volume: bytes[1] & 0x3f,
				made: 0,
			};
		while (length - tone.made >= TONE_FRAME || (end && tone.made < length)) {
			const frames = Math.min(TONE_FRAME, length - tone.made);
			const samples = toneSamples(tone.code, tone.volume, tone.made, frames);
			this.#playout.push(
				start + tone.made,
				frames,
				{ samples, frames, channels: 1, tone: true },
				now,
				power(samples) / frames,
				true,
			);
			tone.made += frames;
		}
	}

	/** the last Opus packet decoded: its time and its first byte */
	#lastOpus: { time: number; toc: number } | null = null;
	/** the newest Opus packet that came, likewise */
	#lastHeard: { time: number; toc: number } | null = null;
	/**
	 * Packets that came after a hole, waiting for the packets of the hole
	 * (which may come out of order), and when they must be decoded at the
	 * latest
	 */
	#reorder: {
		payload: Uint8Array;
		time: number;
		now: number;
		flags: number;
	}[] = [];
	#reorderTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * A hole before a packet of `time`: the packets the decoder has not
	 * had and that would be concealed (not a talkspurt's start, or a
	 * silence an Opus DTX sender left out, or the one packet before it
	 * where its FEC copy rebuilds that: NetEq puts the copy in its buffer
	 * when the packet comes)
	 */
	#holeBefore(time: number, flags: number, payload: Uint8Array): boolean {
		const last = this.#lastOpus;
		if (!last || flags & FLAG_TALKSPURT) return false;
		const missing = (time - last.time) / OPUS_FRAME - 1;
		if (missing === 1 && last.toc >> 3 < 16 && hasLbrr(payload)) return false;
		return (
			Number.isInteger(missing) && missing >= 1 && missing <= CONCEAL_FRAMES
		);
	}

	/**
	 * An Opus packet from the stack. NetEq decodes a packet when it is to
	 * be played, so one that comes after the packet after it (out of order
	 * on the way) is played in its place; here the decoder takes them in
	 * order, so a packet after a hole waits for the hole's packets until
	 * they would have to be decoded to play in time, and the hole is
	 * concealed only then (measured: Chrome conceals nothing of packets
	 * that swap places within what its buffer holds).
	 */
	#take(payload: Uint8Array, time: number, now: number, flags: number) {
		// (its arrival, in the order they came, is what NetEq's delay
		// manager takes; a packet after a hole that carries a copy of the
		// packet before it counts that copy first, as a packet of the lost
		// one's time that came now, a packet late: where losses are rebuilt
		// the target is a packet longer, measured 40 ms against 20 with the
		// same loss and no copies)
		if (payload.length) {
			const heard = this.#lastHeard;
			const missing = heard ? (time - heard.time) / OPUS_FRAME - 1 : 0;
			if (
				heard &&
				!(flags & FLAG_TALKSPURT) &&
				Number.isInteger(missing) &&
				missing >= 1 &&
				missing <= CONCEAL_FRAMES &&
				heard.toc >> 3 < 16 &&
				hasLbrr(payload)
			)
				this.#playout.arrived(time - OPUS_FRAME, now);
			this.#playout.arrived(time, now);
			if (!heard || time > heard.time)
				this.#lastHeard = { time, toc: payload[0] };
		}
		// (one no newer than what was decoded came too late, or twice:
		// NetEq drops it)
		const last = this.#lastOpus;
		if (payload.length && last && time <= last.time) return;
		const queue = this.#reorder;
		if (
			!queue.length &&
			(!payload.length || !this.#holeBefore(time, flags, payload))
		) {
			this.#opus(payload, time, now, flags);
			return;
		}
		if (!payload.length) return;
		let at = queue.length;
		while (at > 0 && queue[at - 1].time > time) at--;
		if (at > 0 && queue[at - 1].time === time) return;
		queue.splice(at, 0, { payload, time, now, flags });
		this.#drain(false);
	}

	/** what waits and has no hole before it, in order; past its time, the first in any case */
	#drain(due: boolean) {
		const queue = this.#reorder;
		while (queue.length) {
			const next = queue[0];
			if (!due && this.#holeBefore(next.time, next.flags, next.payload)) break;
			due = false;
			queue.shift();
			this.#opus(next.payload, next.time, next.now, next.flags);
		}
		if (this.#reorderTimer !== null) clearTimeout(this.#reorderTimer);
		this.#reorderTimer = null;
		if (!queue.length) return;
		// the first packet of the hole is decoded, made up, in time to play:
		// the buffer is pulled at the track's next frame that the sound
		// waiting to be written does not fill
		const missing = (this.#lastOpus?.time ?? queue[0].time) + OPUS_FRAME;
		const now = performance.now();
		const pulling =
			Math.max(now, this.#due) +
			Math.floor(this.#pendingFrames / TRACK_FRAME) * (TRACK_FRAME / 48);
		const wait = Math.min(
			REORDER_MS,
			this.#playout.dueIn(missing, now, pulling) - DECODE_MS,
		);
		this.#reorderTimer = setTimeout(
			() => {
				this.#reorderTimer = null;
				this.#drain(true);
			},
			Math.max(0, wait),
		);
	}

	#opus(payload: Uint8Array, time: number, now: number, flags: number) {
		if (!payload.length) return;
		const last = this.#lastOpus;
		this.#lastOpus = { time, toc: payload[0] };
		// the stereo bit of the packet's first byte (RFC 6716, 3.1)
		if (payload[0] & 4 && !this.#stereo) {
			this.#stereo = true;
			this.#closeDecoder();
		}
		let decoder = this.#decoder;
		if (!decoder) {
			try {
				const made: AudioDecoder = new AudioDecoder({
					output: (data) => this.#decoded(made, data),
					error: () => {
						if (this.#decoder === made) this.#closeDecoder();
					},
				});
				made.configure({
					codec: 'opus',
					sampleRate: 48000,
					numberOfChannels: this.#stereo ? 2 : 1,
				});
				decoder = this.#decoder = made;
			} catch (error) {
				return;
			}
		}
		if (decoder.decodeQueueSize > MAX_QUEUE) return;
		const copy = hasLbrr(payload);
		if (copy) this.#fec.received++;
		// Packets were lost before this one: their time is made up when it
		// is due (the playout buffer has nothing for it), as NetEq's expand
		// makes it up rather than ask the decoder (libopus's concealment is
		// behind a field trial: docs/webrtc-over-wisp.md, section 16). The
		// last of them is rebuilt from this packet's copy of it when it
		// carries one, as NetEq does with libopus's FEC decode: only the
		// packet just before (a longer loss is made up up to it), and not
		// after a CELT-only packet, where libopus conceals instead. A loss
		// is a hole in the RTP times, as NetEq reads one, whatever the
		// sequence numbers say: Chrome's padding packets share the audio's
		// sequence (with the last packet's time), and the stack calls the
		// packet after a padding packet contiguous, a lost one before the
		// padding or not (measured). A longer hole
		// (an Opus DTX sender sends every 400 ms) and the start of a
		// talkspurt are silence the sender left out, not a loss.
		const missing = last ? (time - last.time) / OPUS_FRAME - 1 : 0;
		if (
			last &&
			!(flags & FLAG_TALKSPURT) &&
			Number.isInteger(missing) &&
			missing >= 1 &&
			missing <= CONCEAL_FRAMES
		) {
			const at = time - OPUS_FRAME;
			const rebuilt = copy && last.toc >> 3 < 16 ? repackLbrr(payload) : null;
			this.#concealed += rebuilt ? missing - 1 : missing;
			if (rebuilt) {
				// decoded, not concealed, in Chrome's counts (its arrival was
				// counted when this packet came)
				this.#fec.used++;
				this.#waiting.push({ time: at, arrived: now });
				try {
					decoder.decode(
						new EncodedAudioChunk({
							type: 'key',
							timestamp: Math.round(at / OPUS_UNITS),
							data: rebuilt,
						}),
					);
				} catch (error) {
					this.#closeDecoder();
					return;
				}
			}
		}
		this.#waiting.push({ time, arrived: now });
		try {
			decoder.decode(
				new EncodedAudioChunk({
					type: 'key',
					timestamp: Math.round(time / OPUS_UNITS),
					data: payload,
				}),
			);
		} catch (error) {
			this.#closeDecoder();
		}
	}

	#decoded(decoder: AudioDecoder, data: AudioData) {
		const waiting = decoder === this.#decoder ? this.#waiting.shift() : null;
		if (waiting) {
			const channels = data.numberOfChannels > 1 ? 2 : 1;
			this.#hold(
				waiting.time,
				planes(data, channels),
				channels,
				waiting.arrived,
				true,
			);
		}
		data.close();
	}

	/** a G.711 packet's samples at six times their rate, drawn in straight lines */
	#widen(samples: Float32Array, by: number): Float32Array<ArrayBuffer> {
		const out = new Float32Array(samples.length * by);
		let previous = this.#previous;
		for (let at = 0; at < samples.length; at++) {
			const step = (samples[at] - previous) / by;
			for (let k = 0; k < by; k++) out[at * by + k] = previous + step * (k + 1);
			previous = samples[at];
		}
		this.#previous = previous;
		return out;
	}

	#hold(
		time: number,
		samples: Float32Array<ArrayBuffer>,
		channels: number,
		arrived: number,
		counted = false,
	) {
		const frames = samples.length / channels;
		if (!frames) return;
		// a telephone event plays in place of the sound of its time
		const tone = this.#tone;
		if (tone && time >= tone.start && time < tone.start + tone.made) return;
		this.#playout.push(
			time,
			frames,
			{ samples, frames, channels, arrived },
			arrived,
			power(samples) / samples.length,
			counted,
		);
	}

	#tick = () => {
		this.#timer = null;
		const writer = this.#writer;
		if (!writer) return;
		const now = performance.now();
		if (now - this.#due > LAG_MS) this.#due = now;
		// A frame of the track every 20 ms, as NetEq hands the sound card
		// one every 10, from what was decoded and not played yet (its sync
		// buffer): a frame made shorter or longer moves when the frames
		// after it play, not when the track's frames are written
		while (this.#due <= now) {
			// before anything has played, the first frame plays when NetEq's
			// would, not on this clock's 20 ms
			const starts = this.#playing ? null : this.#playout.startsAt;
			if (starts !== null && starts > this.#due) {
				this.#due = starts;
				if (starts > now) break;
			}
			while (this.#pendingFrames < TRACK_FRAME && this.#produce(writer, now));
			if (this.#pendingFrames) this.#write(writer);
			this.#due += TRACK_FRAME / 48;
		}
		// a stream that went quiet stops the clock until it is heard again
		if (
			now - this.#heard > IDLE_MS &&
			!this.#playout.running &&
			!this.#noise.active
		) {
			this.#playing = false;
			this.#expansion = null;
			this.#pending = [];
			this.#pendingFrames = 0;
			return;
		}
		this.#timer = setTimeout(
			this.#tick,
			Math.max(0, this.#due - performance.now()),
		);
	};

	/**
	 * What plays after what is waiting to be written: the next frame,
	 * comfort noise, or sound made up for a frame that has not come
	 * (false once nothing is, before anything has played)
	 */
	#produce(
		writer: WritableStreamDefaultWriter<AudioData>,
		now: number,
	): boolean {
		const sound = this.#playout.pull(now, this.#noise.active);
		let ms = this.#playout.frameMs;
		// a buffer that fills again plays its first frame when NetEq's
		// would: what is made up meanwhile ends then
		const at = this.#due + this.#pendingFrames / 48;
		const starts = sound ? null : this.#playout.startsAt;
		if (starts !== null && starts > at && starts < at + ms)
			// (in eighths of a millisecond: whole samples at each rate
			// comfort noise is made at)
			ms = Math.max(1, Math.round((starts - at) * 8)) / 8;
		if (sound?.noise) this.#noise.update(sound.noise);
		else if (sound) this.#noise.stop();
		const channels = this.#stereo ? 2 : 1;
		// made-up sound ends where comfort noise takes over
		if (sound?.noise || (!sound && this.#noise.active)) this.#expansion = null;
		if (sound && !sound.noise) {
			// a pitch period out or in, where NetEq's decision logic would
			// take one out or put one in (and where its sound repeats well
			// enough; if not, the next frame is tried)
			const decision = this.#playout.decision;
			let { samples, frames: length } = sound;
			if (decision && !sound.tone) {
				const changed = stretch(
					samples,
					length,
					sound.channels,
					decision === 'expand',
					decision === 'fast',
				);
				if (changed) {
					this.#playout.stretched((changed.frames - length) / 48, now);
					({ samples, frames: length } = changed);
				}
			}
			const merged = this.#merge(samples, length, sound.channels, !!sound.tone);
			const frames = merged.length / sound.channels;
			this.#emit(writer, merged, frames, sound.channels, {
				concealed: false,
				// (to when it is decoded, as Chrome counts it)
				waited: now - (sound.arrived ?? now),
			});
			this.#playing = true;
			return true;
		}
		// the peer said what its silence sounds like: that, until it speaks
		// again (as Chrome's NetEq plays comfort noise)
		if (this.#noise.active) {
			this.#emit(writer, this.#noiseOf(ms, channels), ms * 48, channels, {
				concealed: true,
				waited: 0,
			});
			return true;
		}
		// A frame that has not come once the stream plays (late, from a
		// delay the buffer did not cover, or a pause) is made up from the
		// sound before it, as NetEq's expand makes it up, fading to silence;
		// before anything has played nothing is written.
		if (!this.#playing) return false;
		this.#emit(
			writer,
			this.#expand(Math.round(ms * 48), channels),
			Math.round(ms * 48),
			channels,
			{ concealed: true, waited: 0 },
		);
		return true;
	}

	/**
	 * `frames` samples made up for a frame that did not come: the last
	 * period of what was played, repeated (so a voice or a tone goes on in
	 * phase), fading slowly where the sound repeats well and fast where it
	 * does not, to nothing after a few frames
	 */
	#expand(frames: number, channels: number): Float32Array<ArrayBuffer> | null {
		if (!this.#expansion) {
			const { lag, alike } = periodOf(this.#history[0]);
			this.#expansion = {
				period: this.#history.map((history) => history.slice(-lag)),
				at: 0,
				frames: 0,
				alike,
			};
		}
		const out = this.#continue(frames, channels);
		this.#expansion.frames++;
		// faded out: silence, which NetEq counts as silent concealment
		return this.#faded() ? null : out;
	}

	/** the sound being made up has faded to nothing */
	#faded(): boolean {
		const expansion = this.#expansion;
		if (!expansion) return true;
		return fadeOf(expansion.alike) * expansion.frames >= 1;
	}

	/** the next `frames` samples of the sound being made up */
	#continue(frames: number, channels: number): Float32Array<ArrayBuffer> {
		const expansion = this.#expansion!;
		const out = new Float32Array(frames * channels);
		const lag = expansion.period[0].length;
		// a frame's worth of fading: a twentieth a frame for a sound that
		// repeats, nearly half for one that does not
		const step = fadeOf(expansion.alike);
		for (let at = 0; at < frames; at++) {
			const gain = Math.max(0, 1 - step * (expansion.frames + at / frames));
			const from = (expansion.at + at) % lag;
			for (let channel = 0; channel < channels; channel++)
				out[channel * frames + at] =
					gain * expansion.period[Math.min(channel, 1)][from];
		}
		expansion.at = (expansion.at + frames) % lag;
		this.#remember(out, frames, channels);
		return out;
	}

	/**
	 * A frame played after made-up sound: it starts where it fits the
	 * made-up sound best (within one of its periods, so a voice or a tone
	 * goes on in phase) and fades in from it, as NetEq merges the two
	 */
	#merge(
		samples: Float32Array<ArrayBuffer>,
		frames: number,
		channels: number,
		tone: boolean,
	): Float32Array<ArrayBuffer> {
		const expansion = this.#expansion;
		if (expansion) {
			let skip = 0;
			const period = expansion.period[0];
			const lag = period.length;
			if (!this.#faded() && expansion.alike > 0.7) {
				let best = -Infinity;
				for (
					let at = 0;
					at < Math.min(lag, SKIP) && at + ALIGN <= frames;
					at++
				) {
					let cross = 0;
					let power = 0;
					for (let k = 0; k < ALIGN; k++) {
						const made = period[(expansion.at + k) % lag];
						cross += samples[at + k] * made;
						power += samples[at + k] * samples[at + k];
					}
					const score = power ? cross / Math.sqrt(power) : 0;
					if (score > best) {
						best = score;
						skip = at;
					}
				}
			}
			const length = frames - skip;
			const fade = Math.min(MERGE, length);
			const tail = this.#continue(fade, channels);
			const out = new Float32Array(length * channels);
			for (let channel = 0; channel < channels; channel++) {
				out.set(
					samples.subarray(channel * frames + skip, (channel + 1) * frames),
					channel * length,
				);
				for (let at = 0; at < fade; at++) {
					const weight = at / fade;
					out[channel * length + at] =
						out[channel * length + at] * weight +
						tail[channel * fade + at] * (1 - weight);
				}
			}
			this.#expansion = null;
			samples = out;
			frames = length;
		}
		this.#remember(samples, frames, channels);
		// a telephone event's tones are not made longer: what is missing
		// after them stays silent, as before (unmeasured natively)
		if (tone) for (const history of this.#history) history.fill(0);
		return samples;
	}

	/** the sound played, kept for a frame to be made up */
	#remember(samples: Float32Array, frames: number, channels: number) {
		for (let channel = 0; channel < 2; channel++) {
			const history = this.#history[channel];
			const from = Math.min(channel, channels - 1) * frames;
			const take = Math.min(frames, HISTORY);
			history.copyWithin(0, take);
			history.set(
				samples.subarray(from + frames - take, from + frames),
				HISTORY - take,
			);
		}
	}

	/** `ms` of the comfort noise at 48 kHz, in `channels` */
	#noiseOf(ms: number, channels: number): Float32Array<ArrayBuffer> {
		const rate = NOISE_RATES[this.#speech];
		const made = this.#noise.make(Math.round((ms * rate) / 1000));
		const narrow = rate === 48000 ? made : this.#widen(made, 48000 / rate);
		if (channels === 1) return narrow;
		const out = new Float32Array(narrow.length * 2);
		out.set(narrow);
		out.set(narrow, narrow.length);
		return out;
	}

	#emit(
		writer: WritableStreamDefaultWriter<AudioData>,
		samples: Float32Array<ArrayBuffer> | null,
		frames: number,
		channels: number,
		played: { concealed: boolean; waited: number },
	) {
		this.#played.wrote(
			frames,
			samples &&
				Array.from({ length: channels }, (_, at) =>
					samples.subarray(at * frames, (at + 1) * frames),
				),
			played.concealed,
			NOISE_RATES[this.#speech],
			played.waited,
			this.#playout.stats.targetMs,
		);
		this.#pending.push({
			samples: samples ?? new Float32Array(frames * channels),
			frames,
			channels,
		});
		this.#pendingFrames += frames;
	}

	/** a track frame of what is waiting: `TRACK_FRAME` of it, or what there is of one channel count */
	#write(writer: WritableStreamDefaultWriter<AudioData>) {
		const pending = this.#pending;
		const channels = pending[0].channels;
		let frames = 0;
		for (const chunk of pending) {
			if (chunk.channels !== channels || frames >= TRACK_FRAME) break;
			frames += chunk.frames;
		}
		frames = Math.min(frames, TRACK_FRAME);
		const data = new Float32Array(frames * channels);
		let filled = 0;
		while (filled < frames) {
			const chunk = pending[0];
			const take = Math.min(chunk.frames, frames - filled);
			for (let channel = 0; channel < channels; channel++)
				data.set(
					chunk.samples.subarray(
						channel * chunk.frames,
						channel * chunk.frames + take,
					),
					channel * frames + filled,
				);
			filled += take;
			if (take === chunk.frames) pending.shift();
			else {
				const rest = chunk.frames - take;
				const left = new Float32Array(rest * channels);
				for (let channel = 0; channel < channels; channel++)
					left.set(
						chunk.samples.subarray(
							channel * chunk.frames + take,
							(channel + 1) * chunk.frames,
						),
						channel * rest,
					);
				pending[0] = { samples: left, frames: rest, channels };
			}
		}
		this.#pendingFrames -= frames;
		// nobody takes them (a track without a sink keeps none): not piled up
		if ((writer.desiredSize ?? 0) < -BACKLOG) return;
		this.#clock ??= performance.now() * 1000;
		const audio = new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfFrames: frames,
			numberOfChannels: channels,
			timestamp: Math.round(this.#clock),
			data,
		});
		this.#clock += (frames / 48000) * 1e6;
		this.#counts.written++;
		if (this.#starting) {
			this.#starting = false;
			this.onStart?.();
		}
		writer.write(audio).catch(() => {
			// the track ended
			if (this.#writer === writer) this.#writer = null;
		});
	}
}
