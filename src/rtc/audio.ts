// A connection's audio in the worker (docs/webrtc-over-wisp.md, section
// 16). The page hands over the two ends of a track as streams (a
// MediaStreamTrackProcessor's readable for what it sends, a
// MediaStreamTrackGenerator's writable for what it receives); here the
// sound is encoded and decoded (WebCodecs for Opus, G.711 by hand) and the
// stack packetizes and depacketizes. What crosses to the stack is whole
// encoded frames with their RTP time.
import type { Payload } from './formats';
import { Downsampler, g711Decode, g711Encode } from './g711';
import { Playout, type PlayoutStats } from './playout';
import { ABSENT, FLAG_TALKSPURT, FLAG_VOICE, type Frame } from './records';

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
/** frames an encoder that leaves silence out must have skipped before its time is moved on */
const DTX_RESUME = 5;
/** a G.711 packet: 20 ms at 8 kHz */
const G711_FRAME = 160;

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
	/** the encoder leaves silence out (the peer's `usedtx=1`) */
	#dtx = false;
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
	#pcm = new Float32Array(G711_FRAME);
	#fill = 0;
	#made = 0;
	stats: SenderStats = { frames: 0, bytes: 0 };

	constructor(media: number, write: FrameWriter) {
		this.media = media;
		this.#write = write;
	}

	/** the track's frames (a MediaStreamTrackProcessor's readable), or null for no track */
	setTrack(readable: ReadableStream<AudioData> | null) {
		const old = this.#reader;
		this.#reader = null;
		old?.cancel().catch(() => {});
		this.#restart();
		if (!readable) return;
		const reader = readable.getReader();
		this.#reader = reader;
		void this.#pump(reader);
	}

	/** the payload to send: the first the section negotiated that can be encoded here */
	configure(payloads: Payload[]) {
		const payload =
			payloads.find((candidate) =>
				['opus', 'pcmu', 'pcma'].includes(candidate.name.toLowerCase()),
			) ?? null;
		if (JSON.stringify(payload) === JSON.stringify(this.#payload)) return;
		this.#payload = payload;
		this.#restart();
	}

	/** whether the section sends now (its direction, and a connection that is up) */
	setActive(active: boolean) {
		if (this.#active === active) return;
		this.#active = active;
		this.#restart();
	}

	close() {
		this.setTrack(null);
	}

	async #pump(reader: ReadableStreamDefaultReader<AudioData>) {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				try {
					if (this.#reader === reader) this.#input(value);
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
		this.#fill = 0;
		this.#made = 0;
		this.#squares = 0;
		this.#count = 0;
	}

	#input(data: AudioData) {
		const payload = this.#payload;
		if (!this.#active || !payload) return;
		const duration = (data.numberOfFrames / data.sampleRate) * 1e6;
		// the track stopped for a while (muted, a source that paused): what
		// comes now is a new run, at its own time
		if (
			this.#expected !== null &&
			Math.abs(data.timestamp - this.#expected) > GAP_US
		)
			this.#restart();
		this.#expected = data.timestamp + duration;
		if (payload.name.toLowerCase() === 'opus')
			this.#opus(data, payload, duration);
		else this.#g711(data, payload, duration);
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
		// the encoder takes only what it was configured for
		const input =
			data.numberOfChannels === channels
				? data
				: new AudioData({
						format: 'f32-planar',
						sampleRate: data.sampleRate,
						numberOfFrames: data.numberOfFrames,
						numberOfChannels: channels,
						timestamp: data.timestamp,
						data: samples,
					});
		try {
			encoder.encode(input);
		} catch (error) {
			this.#restart();
			return;
		} finally {
			if (input !== data) input.close();
		}
		this.#fedUs += duration;
		this.#fedAt = performance.now();
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
			encoder.configure({
				codec: 'opus',
				sampleRate: rate,
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
		if (this.#dtx) {
			const fed =
				(Math.floor((this.#fedUs - this.#epoch) / FRAME_US) - 1) * OPUS_FRAME;
			const follows =
				this.#last === null
					? 0
					: this.#last - Math.round(this.#epoch * OPUS_UNITS);
			counted = fed - follows >= DTX_RESUME * OPUS_FRAME ? fed : follows;
		}
		this.#send(
			payload.pt,
			48000,
			Math.round(this.#epoch * OPUS_UNITS) + counted,
			Math.round((chunk.duration ?? FRAME_US) * OPUS_UNITS),
			bytes,
			performance.now() -
				this.#fedAt +
				(this.#fedUs - this.#epoch - counted / OPUS_UNITS) / 1000,
		);
	}

	#g711(data: AudioData, payload: Payload, duration: number) {
		if (data.sampleRate < 8000) return;
		if (this.#epoch === null || this.#rate !== data.sampleRate || !this.#down) {
			const expected = this.#expected;
			this.#restart();
			this.#expected = expected;
			this.#rate = data.sampleRate;
			this.#epoch = data.timestamp;
			this.#fedUs = data.timestamp;
			this.#down = new Downsampler(data.sampleRate, 8000);
		}
		const samples = planes(data, 1);
		this.#squares += power(samples);
		this.#count += samples.length;
		const narrow = this.#down.push(samples);
		const law = payload.name.toUpperCase() === 'PCMA' ? 'PCMA' : 'PCMU';
		for (let at = 0; at < narrow.length;) {
			const take = Math.min(G711_FRAME - this.#fill, narrow.length - at);
			this.#pcm.set(narrow.subarray(at, at + take), this.#fill);
			this.#fill += take;
			at += take;
			if (this.#fill < G711_FRAME) break;
			this.#fill = 0;
			this.#send(
				payload.pt,
				8000,
				Math.round(this.#epoch * 0.008) + this.#made++ * G711_FRAME,
				G711_FRAME,
				g711Encode(law, this.#pcm),
				// the packet's first sample was read 20 ms before its last
				20 + (narrow.length - at) / 8,
			);
		}
		this.#fedUs += duration;
		this.#fedAt = performance.now();
	}

	#send(
		pt: number,
		rate: number,
		time: number,
		length: number,
		payload: Uint8Array,
		age: number,
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
		let flags = level < 127 ? FLAG_VOICE : 0;
		// the first frame of a run, or after frames the encoder left out
		// (silence it did not send)
		if (this.#last !== time) flags |= FLAG_TALKSPURT;
		this.#last = time + length;
		this.stats.frames++;
		this.stats.bytes += payload.length;
		this.#write(
			{
				media: this.media,
				pt,
				flags,
				level,
				orientation: ABSENT,
				time: BigInt(at + this.#offset),
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
}

/** how long after the last frame the receiver's clock stops */
const IDLE_MS = 2000;
/** a clock this far behind starts again from now (the worker stalled) */
const LAG_MS = 200;
/** written frames nobody has taken before more are not written */
const BACKLOG = 25;

/** a received frame, as the stack hands it over */
export interface Received {
	codec: string;
	time: bigint;
	payload: Uint8Array;
}

export interface ReceiverStats extends PlayoutStats {
	/** frames the stack handed over */
	frames: number;
	bytes: number;
	/** frames written to the track, silence among them */
	written: number;
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
	#heard = 0;
	#started = false;
	/** the last G.711 sample, which the next packet's first is drawn from */
	#previous = 0;
	#counts = { frames: 0, bytes: 0, written: 0 };
	/** the first frame arrived: the track has sound now */
	onStart: (() => void) | null = null;
	/** the next frame heard is a start again (the section had stopped receiving) */
	rearm() {
		this.#started = false;
	}

	get stats(): ReceiverStats {
		return { ...this.#playout.stats, ...this.#counts };
	}

	/** the track's sink (a MediaStreamTrackGenerator's writable), or null */
	setTrack(writable: WritableStream<AudioData> | null) {
		const old = this.#writer;
		this.#writer = null;
		old?.close().catch(() => {});
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#playout.clear();
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
			this.onStart?.();
		}
		if (!this.#writer) return;
		const time = Number(frame.time);
		if (frame.codec === 'opus') this.#opus(frame.payload, time, now);
		else if (frame.codec === 'PCMU' || frame.codec === 'PCMA')
			// 8 kHz on the wire, 48 kHz on the track
			this.#hold(
				time * 6,
				this.#widen(g711Decode(frame.codec, frame.payload)),
				1,
				now,
			);
		else return;
		this.#heard = now;
		if (this.#timer === null) {
			this.#due = now;
			this.#timer = setTimeout(this.#tick, 0);
		}
	}

	#opus(payload: Uint8Array, time: number, now: number) {
		if (!payload.length) return;
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
			);
		}
		data.close();
	}

	/** a G.711 packet's samples at six times their rate, drawn in straight lines */
	#widen(samples: Float32Array): Float32Array<ArrayBuffer> {
		const out = new Float32Array(samples.length * 6);
		let previous = this.#previous;
		for (let at = 0; at < samples.length; at++) {
			const step = (samples[at] - previous) / 6;
			for (let k = 0; k < 6; k++) out[at * 6 + k] = previous + step * (k + 1);
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
	) {
		const frames = samples.length / channels;
		if (!frames) return;
		this.#playout.push(
			time,
			frames,
			{ samples, frames, channels },
			arrived,
			power(samples) / samples.length,
		);
	}

	#tick = () => {
		this.#timer = null;
		const writer = this.#writer;
		if (!writer) return;
		const now = performance.now();
		if (now - this.#due > LAG_MS) this.#due = now;
		while (this.#due <= now) {
			const sound = this.#playout.pull(now);
			const ms = sound ? sound.frames / 48 : this.#playout.frameMs;
			if (sound)
				this.#emit(writer, sound.samples, sound.frames, sound.channels);
			// a frame that is missing while the stream plays is silence of
			// its length; a stream that is not playing writes nothing
			else if (this.#playout.running)
				this.#emit(writer, null, Math.round(ms * 48), this.#stereo ? 2 : 1);
			this.#due += ms;
		}
		// a stream that went quiet stops the clock until it is heard again
		if (now - this.#heard > IDLE_MS && !this.#playout.running) return;
		this.#timer = setTimeout(
			this.#tick,
			Math.max(0, this.#due - performance.now()),
		);
	};

	#emit(
		writer: WritableStreamDefaultWriter<AudioData>,
		samples: Float32Array<ArrayBuffer> | null,
		frames: number,
		channels: number,
	) {
		// nobody takes them (a track without a sink keeps none): not piled up
		if ((writer.desiredSize ?? 0) < -BACKLOG) return;
		this.#clock ??= performance.now() * 1000;
		const data = new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfFrames: frames,
			numberOfChannels: channels,
			timestamp: Math.round(this.#clock),
			data: samples ?? new Float32Array(frames * channels),
		});
		this.#clock += (frames / 48000) * 1e6;
		this.#counts.written++;
		writer.write(data).catch(() => {
			// the track ended
			if (this.#writer === writer) this.#writer = null;
		});
	}
}
