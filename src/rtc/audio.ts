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
import {
	AudioLevel,
	channelsOf,
	PlayedCount,
	type PlayedStats,
	type SourceStats,
} from './level';
import { Playout, type Operation, type PlayoutStats } from './playout';
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
/** sound being made up: the period repeated, where in it, how much of it, how alike its repeats */
interface Expansion {
	period: Float32Array[];
	at: number;
	made: number;
	alike: number;
	/** made from nothing (after a telephone event, whose tones are not made longer) */
	silent: boolean;
}

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
/**
 * The periods made-up sound repeats are looked for between 2.5 and 15 ms,
 * as NetEq's expand looks for them, over the last 10 ms
 */
const LAG_LOW = 120;
const LAG_HIGH = 720;
const LAG_WINDOW = 480;
/** NetEq's sync buffer: what it plays each time (10 ms), and the made-up sound it keeps past that */
const OUT = 480;
/** that in milliseconds: the sound card's 10 ms */
const TICK = OUT / 48;
const OVERLAP = 30;
/**
 * NetEq's merge: the made-up sound a frame after a hole is fitted to (its
 * 202 samples at 8 kHz), the most it fades in over (60 at 8 kHz), and
 * the rate it compares the two at (4 kHz)
 */
const MERGE_LENGTH = 1212;
const MERGE_FADE = 360;
const DOWN = 12;
/** a frame that comes once made-up sound played fades in over this many samples (NetEq's normal after expand) */
const NORMAL_FADE = 48;

/**
 * How much of its level made-up sound loses each 20 ms: little for a
 * sound that repeats well (Chrome's goes on unmuted through 300 ms of
 * packets held up, measured), nearly half for one that does not
 */
function fadeOf(alike: number): number {
	return alike > 0.7 ? 0.05 : 0.45;
}

/**
 * How long a period of the last sound played is (`LAG_LOW` to `LAG_HIGH`
 * samples: the shortest that repeats about as well as the best, so a
 * voice or a tone repeats its own period), and how alike its repeats are
 * (normalized correlation)
 */
function periodOf(history: Float32Array): { lag: number; alike: number } {
	const end = history.length;
	const scores = new Float64Array(LAG_HIGH + 1);
	let alike = 0;
	for (let candidate = LAG_LOW; candidate <= LAG_HIGH; candidate++) {
		let cross = 0;
		let now = 0;
		let then = 0;
		for (let at = end - LAG_WINDOW; at < end; at++) {
			cross += history[at] * history[at - candidate];
			now += history[at] * history[at];
			then += history[at - candidate] * history[at - candidate];
		}
		scores[candidate] = now && then ? cross / Math.sqrt(now * then) : 0;
		alike = Math.max(alike, scores[candidate]);
	}
	let lag = LAG_LOW;
	while (lag < LAG_HIGH && scores[lag] < alike * 0.98) lag++;
	// (the top of that peak)
	while (lag < LAG_HIGH && scores[lag + 1] > scores[lag]) lag++;
	return { lag, alike };
}

/** how long after the last frame the receiver's clock stops */
const IDLE_MS = 2000;
/** a clock this far behind starts again from now (the worker stalled) */
const LAG_MS = 200;
/** written frames nobody has taken before more are not written */
const BACKLOG = 50;

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
	/**
	 * The copy an Opus packet carries of the one before it (in-band FEC,
	 * rust/rtc/src/lbrr.rs), as a packet of its own, or null
	 */
	#copyOf: (packet: Uint8Array) => Uint8Array | null;
	constructor(copyOf: (packet: Uint8Array) => Uint8Array | null = () => null) {
		this.#copyOf = copyOf;
	}
	#playout = new Playout<Sound>({ rate: 48 });
	#writer: WritableStreamDefaultWriter<AudioData> | null = null;
	#decoder: AudioDecoder | null = null;
	/** the frames the decoder has not answered yet: it answers in order */
	#waiting: { time: number; arrived: number }[] = [];
	/** a frame with two channels was seen: the track carries two from then on */
	#stereo = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	/** when the next 10 ms are due on the track */
	#due = 0;
	/** the track's own time, in microseconds: a steady count of what was written */
	#clock: number | null = null;
	/**
	 * sound decoded or made up and not yet written (NetEq's sync buffer),
	 * each channel's: a stream starts with its overlap of silence, as
	 * NetEq's does, so its first frame lasts until the second has come
	 */
	#future: Float32Array[] = [new Float32Array(OVERLAP)];
	#futureFrames = OVERLAP;
	/** what made the sound last put in it, and how many 10 ms it has been made up for (comfort noise too) */
	#mode: Operation | 'noise' | null = null;
	#noiseTicks: number | null = null;
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
	/** sound being made up */
	#expansion: Expansion | null = null;
	/**
	 * Sound has been played since the stream started: from then on the
	 * track has 10 ms every 10 ms, made up or silent where none came, as
	 * NetEq hands the sound card 10 ms every 10 ms
	 */
	#playing = false;
	/** the last frame played was a telephone event's tones */
	#toned = false;
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
		this.#stop();
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
		now = this.#ticked(now);
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
			this.#take(
				frame.payload,
				frame.payload.length ? this.#copyOf(frame.payload) : null,
				time,
				now,
				frame.flags ?? FLAG_CONTIGUOUS,
			);
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
				// (NetEq's delay manager leaves comfort noise and events out)
				true,
			);
		} else if (frame.codec === 'telephone-event') this.#event(frame, time, now);
		else return;
		this.#heard = now;
		this.#wake();
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
		copy: Uint8Array | null;
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
	#holeBefore(time: number, flags: number, copy: Uint8Array | null): boolean {
		const last = this.#lastOpus;
		if (!last || flags & FLAG_TALKSPURT) return false;
		const missing = (time - last.time) / OPUS_FRAME - 1;
		if (missing === 1 && last.toc >> 3 < 16 && copy) return false;
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
	#take(
		payload: Uint8Array,
		copy: Uint8Array | null,
		time: number,
		now: number,
		flags: number,
	) {
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
				copy
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
			(!payload.length || !this.#holeBefore(time, flags, copy))
		) {
			this.#opus(payload, copy, time, now, flags);
			return;
		}
		if (!payload.length) return;
		let at = queue.length;
		while (at > 0 && queue[at - 1].time > time) at--;
		if (at > 0 && queue[at - 1].time === time) return;
		queue.splice(at, 0, { payload, copy, time, now, flags });
		this.#drain(false);
	}

	/** what waits and has no hole before it, in order; past its time, the first in any case */
	#drain(due: boolean) {
		const queue = this.#reorder;
		while (queue.length) {
			const next = queue[0];
			if (!due && this.#holeBefore(next.time, next.flags, next.copy)) break;
			due = false;
			queue.shift();
			this.#opus(next.payload, next.copy, next.time, next.now, next.flags);
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
			Math.floor(Math.max(0, this.#futureFrames - OVERLAP) / OUT) * (OUT / 48);
		const wait = Math.min(
			REORDER_MS,
			this.#playout.dueIn(
				missing,
				now,
				pulling,
				this.#waiting[0]?.time ?? this.#lastOpus?.time,
			) - DECODE_MS,
		);
		this.#reorderTimer = setTimeout(
			() => {
				this.#reorderTimer = null;
				this.#drain(true);
			},
			Math.max(0, wait),
		);
	}

	#opus(
		payload: Uint8Array,
		copy: Uint8Array | null,
		time: number,
		now: number,
		flags: number,
	) {
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
			const rebuilt = last.toc >> 3 < 16 ? copy : null;
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
			counted,
		);
		this.#wake();
	}

	#tick = () => {
		this.#timer = null;
		const writer = this.#writer;
		if (!writer) return;
		const now = performance.now();
		// (a clock far behind, from a worker that stalled, starts again from now)
		if (now - this.#due > LAG_MS) this.#due = now;
		// Every 10 ms, as the sound card asks NetEq: 10 ms from the sync
		// buffer, which is filled as NetEq fills it when it runs short; a
		// frame made shorter or longer moves when the frames after it play.
		// Before the stream's first frame nothing plays: the clock stops
		// until it comes, and goes on at its next 10 ms.
		while (this.#due <= now) {
			const played = this.#getAudio(writer, this.#due);
			this.#due += TICK;
			if (!played) return;
		}
		// a stream that went quiet stops the clock until it is heard again
		if (
			now - this.#heard > IDLE_MS &&
			!this.#playout.held &&
			!this.#noise.active
		) {
			this.#stop();
			return;
		}
		this.#timer = setTimeout(
			this.#tick,
			Math.max(0, this.#due - performance.now()),
		);
	};

	/**
	 * The clock goes on at its next 10 ms: the sound card asks every 10 ms
	 * whether or not anything plays, so a frame that comes to a stopped
	 * clock plays at the next of those (as Chrome's first sound comes 0 to
	 * 10 ms after its first packet)
	 */
	#wake() {
		if (this.#timer !== null || !this.#writer) return;
		const now = performance.now();
		if (this.#due < now)
			this.#due += Math.ceil((now - this.#due) / TICK) * TICK;
		this.#timer = setTimeout(this.#tick, Math.max(0, this.#due - now));
	}

	/**
	 * The time of the last of those 10 ms at `now`: NetEq's clock, which
	 * counts when a packet came, and how long it waited, in its ticks (a
	 * tick whose timer has not fired yet has not happened: a worker's
	 * timers fire late, and a packet that comes before it counts at the
	 * one before, as NetEq counts it before its next GetAudio)
	 */
	#ticked(now: number): number {
		const due = this.#due;
		return now < due || this.#timer !== null
			? due - TICK
			: due + Math.floor((now - due) / TICK) * TICK;
	}

	/** the stream stopped: what is not played is let go, and its next frame plays at once */
	#stop() {
		this.#playing = false;
		this.#expansion = null;
		this.#future = [new Float32Array(OVERLAP)];
		this.#futureFrames = OVERLAP;
		this.#toned = false;
		this.#mode = null;
		this.#noiseTicks = null;
		this.#playout.reset();
	}

	/**
	 * NetEq's GetAudio: when the sync buffer runs short, what its
	 * decision logic says (play the next frame, made shorter or longer,
	 * make up sound for one that has not come, or merge made-up sound
	 * into the frame after a hole), then 10 ms of it to the track; false
	 * before the stream has played anything and has nothing to play
	 */
	#getAudio(
		writer: WritableStreamDefaultWriter<AudioData>,
		now: number,
	): boolean {
		if (this.#futureFrames - OVERLAP < OUT) {
			const expansion = this.#expansion;
			const op = this.#playout.decide(
				now,
				this.#futureFrames,
				this.#mode,
				(this.#noiseTicks ?? 0) * OUT,
				!!expansion && this.#gain(expansion) < 0.5,
			);
			const sound = op === 'expand' ? null : this.#playout.take();
			if (sound) this.#play(sound, op, now);
			else if (!this.#playing) return false;
			else if (this.#noise.active) {
				// the peer said what its silence sounds like: that, until it
				// speaks again (as Chrome's NetEq plays comfort noise)
				this.#expansion = null;
				this.#mode = 'noise';
				while (this.#futureFrames - OVERLAP < OUT) this.#appendNoise();
			} else {
				// A frame that has not come (late, from a delay the buffer
				// did not cover, or lost) is made up from the sound before
				// it, as NetEq's expand makes it up, a period at a time,
				// fading to silence
				this.#mode = 'expand';
				while (this.#futureFrames - OVERLAP < OUT) this.#expand();
			}
			// (NetEq's count of what it made up starts again with each
			// comfort noise packet)
			if (sound?.noise) this.#noiseTicks = 0;
			else if (this.#mode === 'expand' || this.#mode === 'noise')
				this.#noiseTicks ??= 0;
			else this.#noiseTicks = null;
		}
		this.#output(writer);
		if (this.#noiseTicks !== null) this.#noiseTicks++;
		return true;
	}

	/** a frame the decision plays */
	#play(sound: Sound, op: Operation, now: number) {
		const expansion = this.#expansion;
		this.#expansion = null;
		this.#playing = true;
		if (sound.noise) {
			this.#noise.update(sound.noise);
			this.#mode = 'noise';
			this.#appendNoise(sound.frames);
			this.#toned = false;
			return;
		}
		this.#noise.stop();
		this.#mode = op;
		let { samples, frames } = sound;
		const channels = sound.channels;
		// a pitch period out or in, where NetEq's decision logic takes one
		// out or puts one in (and where its sound repeats well enough; if
		// not, it is tried again at the next)
		if (
			!sound.tone &&
			(op === 'accelerate' || op === 'fast' || op === 'preemptive')
		) {
			const changed = stretch(
				samples,
				frames,
				channels,
				op === 'preemptive',
				op === 'fast',
			);
			if (changed) {
				this.#playout.stretched((changed.frames - frames) / 48, now);
				({ samples, frames } = changed);
			}
		}
		// (to when it is taken out of the buffer, on NetEq's 10 ms ticks,
		// as Chrome counts it)
		const waited = Math.max(0, now - (sound.arrived ?? now));
		const planes = Array.from({ length: channels }, (_, channel) =>
			samples.subarray(channel * frames, (channel + 1) * frames),
		);
		const toned = this.#toned;
		this.#toned = !!sound.tone;
		if (sound.tone && !toned) {
			// An event's tones replace the sound of their time from the
			// track's next 10 ms frame on, at their own level: what is left
			// of the sound before them is not played, nor merged or faded
			// into them (Chrome's receiver plays tones a whole 10 ms frame
			// at a time, measured; cut in mid-frame, their edge reads as
			// another digit)
			if (expansion)
				this.#played.correct(
					-Math.min(this.#futureFrames, expansion.made),
					NOISE_RATES[this.#speech],
				);
			this.#future = [];
			this.#futureFrames = 0;
		} else if (toned || expansion?.silent) {
			// after a telephone event: the tones play out, the silence made
			// up after them and not played yet gives way to the frame, and
			// a frame of sound comes in from silence over its length (Chrome's
			// receiver brings the sound back after tones over 10 to 15 ms,
			// measured)
			if (expansion) {
				const dropped = Math.min(this.#futureFrames, expansion.made);
				const keep = this.#futureFrames - dropped;
				this.#future = this.#future.map((plane) => plane.subarray(0, keep));
				this.#futureFrames = keep;
				this.#played.correct(-dropped, NOISE_RATES[this.#speech]);
			}
			if (!sound.tone)
				for (const plane of planes)
					for (let at = 0; at < frames; at++) plane[at] *= at / frames;
		} else if (expansion) {
			if (op === 'merge') this.#merge(expansion, planes, frames);
			else this.#rampIn(expansion, planes, frames, NORMAL_FADE, 0);
		}
		this.#append(planes, frames, { concealed: false, waited });
		// a telephone event's tones are not made longer: what is missing
		// after them stays silent, as before (unmeasured natively)
		if (sound.tone) for (const history of this.#history) history.fill(0);
	}

	/** how loud made-up sound still is (NetEq's mute factor) */
	#gain(expansion: Expansion): number {
		return Math.max(0, 1 - (fadeOf(expansion.alike) * expansion.made) / 960);
	}

	/** a period of made-up sound, or of silence once it has faded */
	#expand() {
		let expansion = this.#expansion;
		if (!expansion) {
			const { lag, alike } = periodOf(this.#history[0]);
			expansion = this.#expansion = {
				period: this.#history.map((history) => history.slice(-lag)),
				at: 0,
				made: 0,
				alike,
				silent: this.#history[0].every((value) => value === 0),
			};
		}
		const lag = expansion.period[0].length;
		const silent = this.#gain(expansion) <= 0;
		const planes = this.#continue(expansion, lag, this.#stereo ? 2 : 1);
		this.#append(planes, lag, { concealed: true, waited: 0, silent });
	}

	/** the next `frames` samples of the sound being made up, each channel's */
	#continue(
		expansion: Expansion,
		frames: number,
		channels: number,
	): Float32Array[] {
		const lag = expansion.period[0].length;
		// a twentieth each 20 ms for a sound that repeats, nearly half for
		// one that does not
		const step = fadeOf(expansion.alike) / 960;
		const out = Array.from(
			{ length: channels },
			() => new Float32Array(frames),
		);
		for (let at = 0; at < frames; at++) {
			const gain = Math.max(0, 1 - step * (expansion.made + at));
			const from = (expansion.at + at) % lag;
			for (let channel = 0; channel < channels; channel++)
				out[channel][at] = gain * expansion.period[Math.min(channel, 1)][from];
		}
		expansion.at = (expansion.at + frames) % lag;
		expansion.made += frames;
		return out;
	}

	/**
	 * A frame after made-up sound comes in at the made-up sound's level
	 * (or at its own, where it is quieter: `level`), back to its own
	 * within the frame, and fades in from more of the made-up sound over
	 * `fade` samples from `from` in `made` (NetEq's normal and merge)
	 */
	#rampIn(
		expansion: Expansion,
		planes: Float32Array[],
		frames: number,
		fade: number,
		level: number,
		made?: Float32Array[],
		from = 0,
	) {
		const mute = Math.max(this.#gain(expansion), level);
		made ??= this.#continue(expansion, fade, planes.length);
		const step = Math.max(0.00065, (1 - mute) / frames);
		fade = Math.min(fade, frames);
		for (let channel = 0; channel < planes.length; channel++) {
			const plane = planes[channel];
			const other = made[Math.min(channel, made.length - 1)];
			for (let at = 0; at < frames; at++) {
				if (mute < 1) plane[at] *= Math.min(1, mute + step * at);
				if (at < fade) {
					const weight = (at + 1) / (fade + 1);
					plane[at] = plane[at] * weight + other[from + at] * (1 - weight);
				}
			}
		}
	}

	/**
	 * NetEq's merge of made-up sound into the frame after a hole: the sound
	 * made up and not played yet, and more of it, is where the frame fits
	 * it best (within a period of it, on the first channel at 4 kHz) and
	 * fades into the frame from there; the made-up sound before that point
	 * plays first. So each loss moves the delay by how far that point is
	 * from what was made up past the last 10 ms played.
	 */
	#merge(expansion: Expansion, planes: Float32Array[], frames: number) {
		const old = this.#futureFrames;
		const channels = planes.length;
		const more = this.#continue(
			expansion,
			Math.max(0, MERGE_LENGTH - old),
			channels,
		);
		const made = Array.from({ length: channels }, (_, channel) => {
			const out = new Float32Array(old + more[0].length);
			out.set(this.#future[Math.min(channel, this.#future.length - 1)] ?? []);
			out.set(more[channel], old);
			return out;
		});
		const length = made[0].length;
		const input = planes[0];
		const reference = made[0];
		const down = (signal: Float32Array, count: number) =>
			Array.from({ length: count }, (_, at) => {
				let sum = 0;
				for (let k = 0; k < DOWN; k++) sum += signal[at * DOWN + k] ?? 0;
				return sum / DOWN;
			});
		const inputDown = down(input, OUT / DOWN);
		const madeDown = down(reference, Math.floor(MERGE_LENGTH / DOWN));
		const start = Math.max(0, Math.max(old, OUT + OVERLAP) - frames);
		const lags = Math.min(60, expansion.period[0].length / DOWN + 1);
		const fit = (
			lag: number,
			signal: number[],
			other: number[],
			count: number,
		) => {
			let sum = 0;
			for (let at = 0; at < count; at++)
				sum += signal[at] * (other[lag + at] ?? 0);
			return sum;
		};
		const first = Math.ceil(start / DOWN);
		const end = Math.min(first + lags, madeDown.length - inputDown.length + 1);
		let best = first;
		let score = -Infinity;
		for (let lag = first; lag < end; lag++) {
			const got = fit(lag, inputDown, madeDown, inputDown.length);
			if (got > score) {
				score = got;
				best = lag;
			}
		}
		// (to the sample)
		const coarse = best * DOWN;
		best = coarse;
		score = -Infinity;
		for (
			let at = Math.max(start, coarse - DOWN / 2);
			at <= coarse + DOWN / 2 && at < length;
			at++
		) {
			let sum = 0;
			for (let k = 0; k < OUT / 2 && at + k < length; k++)
				sum += input[k] * reference[at + k];
			if (sum > score) {
				score = sum;
				best = at;
			}
		}
		// the frame at the made-up sound's level where it is louder
		// (NetEq's signal scaling), over the first 8 ms
		let loud = 0;
		let quiet = 0;
		for (let at = 0; at < Math.min(384, frames); at++) {
			loud += input[at] * input[at];
			quiet += reference[at] * reference[at];
		}
		const level = loud > quiet ? Math.sqrt(quiet / loud) : 1;
		this.#rampIn(
			expansion,
			planes,
			frames,
			Math.min(MERGE_FADE, length - best),
			level,
			made,
			best,
		);
		// the made-up sound before that point plays, and what was made past it does not
		this.#future = made.map((plane) => plane.subarray(0, best));
		this.#futureFrames = best;
		this.#played.correct(best - old, NOISE_RATES[this.#speech]);
	}

	/** comfort noise, 10 ms of it or `frames` */
	#appendNoise(frames = OUT) {
		const rate = NOISE_RATES[this.#speech];
		const made = this.#noise.make(Math.round((frames * rate) / 48000));
		const plane = rate === 48000 ? made : this.#widen(made, 48000 / rate);
		this.#append(
			Array.from({ length: this.#stereo ? 2 : 1 }, () => plane),
			plane.length,
			{ concealed: true, waited: 0 },
		);
	}

	/** sound into the sync buffer (NetEq counts it as it is made) */
	#append(
		planes: Float32Array[],
		frames: number,
		made: { concealed: boolean; waited: number; silent?: boolean },
	) {
		const channels = planes.length;
		const old = this.#future;
		this.#future = Array.from({ length: channels }, (_, channel) => {
			const out = new Float32Array(this.#futureFrames + frames);
			// (a stream that turns stereo: its one channel twice)
			if (old.length) out.set(old[Math.min(channel, old.length - 1)]);
			out.set(planes[channel].subarray(0, frames), this.#futureFrames);
			return out;
		});
		this.#futureFrames += frames;
		this.#remember(planes, frames);
		this.#played.made(
			frames,
			made.concealed,
			!!made.silent,
			NOISE_RATES[this.#speech],
			made.waited,
			this.#playout.stats.targetMs,
		);
	}

	/** the sound played, kept for a frame to be made up */
	#remember(planes: Float32Array[], frames: number) {
		for (let channel = 0; channel < 2; channel++) {
			const history = this.#history[channel];
			const plane = planes[Math.min(channel, planes.length - 1)];
			const take = Math.min(frames, HISTORY);
			history.copyWithin(0, take);
			history.set(plane.subarray(frames - take, frames), HISTORY - take);
		}
	}

	/** 10 ms of the sync buffer to the track */
	#output(writer: WritableStreamDefaultWriter<AudioData>) {
		const channels = this.#future.length || 1;
		const data = new Float32Array(OUT * channels);
		for (let channel = 0; channel < this.#future.length; channel++) {
			const plane = this.#future[channel];
			data.set(plane.subarray(0, OUT), channel * OUT);
			this.#future[channel] = plane.subarray(OUT);
		}
		this.#futureFrames = Math.max(0, this.#futureFrames - OUT);
		this.#played.played(
			Array.from({ length: channels }, (_, channel) =>
				data.subarray(channel * OUT, (channel + 1) * OUT),
			),
			OUT,
			NOISE_RATES[this.#speech],
		);
		// nobody takes them (a track without a sink keeps none): not piled up
		if ((writer.desiredSize ?? 0) < -BACKLOG) return;
		this.#clock ??= performance.now() * 1000;
		const audio = new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfFrames: OUT,
			numberOfChannels: channels,
			timestamp: Math.round(this.#clock),
			data,
		});
		this.#clock += (OUT / 48000) * 1e6;
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
