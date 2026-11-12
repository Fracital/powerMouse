// A connection's video in the worker (docs/webrtc-over-wisp.md, section
// 16). As with sound (audio.ts), the page hands over the two ends of a
// track as streams: a MediaStreamTrackProcessor's readable of what it
// sends, a MediaStreamTrackGenerator's writable for what it receives. Here
// the pictures are encoded and decoded with WebCodecs, and the stack
// packetizes and depacketizes; what crosses to it is whole encoded frames
// with their RTP time on the 90 kHz clock.
import type { FrameWriter, Received, SenderStats } from './audio';
import type { Payload } from './formats';
import { ABSENT, FLAG_CONTIGUOUS, FLAG_KEYFRAME } from './records';

/** video RTP time: 90 kHz, units a microsecond */
const VIDEO_UNITS = 0.09;
/**
 * Frames an encoder or a decoder may have waiting: past it the picture
 * is behind, and a frame is let go rather than queued (Chrome's realtime
 * encoder drops frames the same way)
 */
const ENCODE_QUEUE = 2;
const DECODE_QUEUE = 8;
/**
 * The least time between two keyframe requests of a receiver: Chrome's
 * receive stream asks again no sooner (kMaxWaitForKeyFrameMs)
 */
const KEYFRAME_WAIT_MS = 200;
/**
 * The color-space RTP extension's numbers (ITU-T H.273) for WebCodecs'
 * names. Chrome's encoder says what it encoded in (156 encodes a canvas in
 * BT.709 at full range, 152 in BT.601 at limited range, measured), its
 * sender states it in the extension, and its receiver reads a picture
 * without one as BT.601 at limited range: so the extension goes with each
 * keyframe, and a received picture is decoded as its extension says.
 */
const PRIMARIES: Record<string, number> = {
	bt709: 1,
	bt470bg: 5,
	smpte170m: 6,
	bt2020: 9,
	smpte432: 12,
};
const TRANSFERS: Record<string, number> = {
	bt709: 1,
	smpte170m: 6,
	linear: 8,
	'iec61966-2-1': 13,
	pq: 16,
	hlg: 18,
};
const MATRICES: Record<string, number> = {
	rgb: 0,
	bt709: 1,
	bt470bg: 5,
	smpte170m: 6,
	'bt2020-ncl': 9,
};
/** what a picture without the extension is, to Chrome's receiver */
const UNSTATED: VideoColorSpaceInit = {
	primaries: 'smpte170m',
	transfer: 'smpte170m',
	matrix: 'smpte170m',
	fullRange: false,
};
/** a color space as the extension's four bytes in one number, 0 for one it cannot state */
export function colourBytes(space: VideoColorSpaceInit | undefined): number {
	if (!space) return 0;
	const primaries = PRIMARIES[space.primaries ?? ''];
	const transfer = TRANSFERS[space.transfer ?? ''];
	const matrix = MATRICES[space.matrix ?? ''];
	if (primaries === undefined || transfer === undefined || matrix === undefined)
		return 0;
	// the range (1 limited, 2 full) above the chroma siting, unstated
	const range =
		space.fullRange === true ? 2 : space.fullRange === false ? 1 : 0;
	return (
		((primaries << 24) | (transfer << 16) | (matrix << 8) | (range << 4)) >>> 0
	);
}
/** the extension's four bytes as a color space, null for none */
export function colourSpace(bytes: number): VideoColorSpaceInit | null {
	if (!bytes) return null;
	const name = (table: Record<string, number>, code: number) =>
		Object.keys(table).find((key) => table[key] === code) ?? null;
	const range = (bytes >>> 4) & 3;
	return {
		primaries: name(PRIMARIES, bytes >>> 24) as VideoColorPrimaries | null,
		transfer: name(
			TRANSFERS,
			(bytes >>> 16) & 255,
		) as VideoTransferCharacteristics | null,
		matrix: name(
			MATRICES,
			(bytes >>> 8) & 255,
		) as VideoMatrixCoefficients | null,
		fullRange: range === 2 ? true : range === 1 ? false : null,
	};
}

/** what a picture of this many pixels is sent at, at most (WebRTC's GetMaxDefaultVideoBitrateKbps) */
function maxBitrate(pixels: number): number {
	if (pixels <= 320 * 240) return 600000;
	if (pixels <= 640 * 480) return 1700000;
	if (pixels <= 960 * 540) return 2000000;
	return 2500000;
}

/**
 * WebCodecs' name for what a payload carries, or null for one it is not
 * given: VP8; VP9 of the profile the `a=fmtp` line names (Chrome offers 0
 * and 2); H.264 of its `profile-level-id`, in Annex B (start codes, the
 * parameter sets in band), which is what the stack packetizes; AV1 of its
 * `profile` and `level-idx`, 8-bit at the main tier. Measured on Chrome
 * 152 and 156: each of these encodes and decodes in software.
 */
export function videoCodec(payload: Payload): string | null {
	const parameters = payload.parameters;
	switch (payload.name.toUpperCase()) {
		case 'VP8':
			return 'vp8';
		case 'VP9': {
			const profile = Number(parameters['profile-id'] ?? 0);
			if (profile === 0) return 'vp09.00.10.08';
			if (profile === 2) return 'vp09.02.10.10';
			return null;
		}
		case 'H264': {
			const id = (parameters['profile-level-id'] ?? '42001f').toLowerCase();
			return /^[0-9a-f]{6}$/.test(id) ? `avc1.${id}` : null;
		}
		case 'AV1': {
			const profile = Number(parameters.profile ?? 0);
			const level = Number(parameters['level-idx'] ?? 5);
			if (profile > 2 || !(level >= 0 && level < 32)) return null;
			return `av01.${profile}.${String(level).padStart(2, '0')}M.08`;
		}
		default:
			return null;
	}
}

/**
 * Whether this side sends a payload: one it encodes, and for H.264 only
 * in packetization mode 1, which is how the stack packetizes it (mode 0
 * sends each NAL unit in a packet of its own, which an encoder that
 * cannot bound its NAL units does not make)
 */
export function sendable(payload: Payload): boolean {
	if (videoCodec(payload) === null) return false;
	return (
		payload.name.toUpperCase() !== 'H264' ||
		payload.parameters['packetization-mode'] === '1'
	);
}

/**
 * What a track's pictures become on the wire. The track is read whether
 * or not anything is sent (a track nobody reads stops); a picture is
 * encoded only while the section sends and the connection is up.
 */
export class VideoSender {
	/** the stack's index of the section this sends on */
	media: number;
	#write: FrameWriter;
	#payload: Payload | null = null;
	#codec: string | null = null;
	#active = false;
	#reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
	#encoder: VideoEncoder | null = null;
	/** what the encoder was made for: codec, width and height */
	#made = '';
	/** a configuration the browser refused, not to be tried on every frame */
	#refused = '';
	/** the next picture is a keyframe: the first of an encoder, or one the peer asked for */
	#keyframe = true;
	/** RTP times start at a number of the sender's own */
	#offset = crypto.getRandomValues(new Uint32Array(1))[0];
	/**
	 * The sender's own time, in microseconds: a track's timestamps start
	 * anywhere (a track the page writes itself starts at zero), so a run
	 * of one track goes on from the last picture sent, by as much as the
	 * clock moved since, and within a run follows the track's timestamps
	 */
	#shift: number | null = null;
	#sentUs = 0;
	#sentAt = 0;
	#sent = false;
	/** when each picture under way was read, by its timestamp: its age when it goes out */
	#readAt = new Map<number, number>();
	/** the color space the encoder last said it encoded in (the extension's bytes) */
	#colour = 0;
	stats: SenderStats = { frames: 0, bytes: 0 };

	constructor(media: number, write: FrameWriter) {
		this.media = media;
		this.#write = write;
	}

	/** the track's pictures (a MediaStreamTrackProcessor's readable), or null for no track */
	setTrack(readable: ReadableStream<VideoFrame> | null) {
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
		const payload = payloads.find(sendable) ?? null;
		if (JSON.stringify(payload) === JSON.stringify(this.#payload)) return;
		this.#payload = payload;
		this.#codec = payload && videoCodec(payload);
		this.#restart();
	}

	/** a video sender has no RTCDTMFSender */
	get canTone(): boolean {
		return false;
	}

	tone() {}

	/** whether the section sends now (its direction, and a connection that is up) */
	setActive(active: boolean) {
		if (this.#active === active) return;
		this.#active = active;
		this.#restart();
	}

	/** the peer asked for a keyframe (PLI or FIR): the next picture is one */
	keyframe() {
		this.#keyframe = true;
	}

	close() {
		this.setTrack(null);
	}

	async #pump(reader: ReadableStreamDefaultReader<VideoFrame>) {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (this.#reader === reader) this.#input(value);
				else value.close();
				if (this.#reader !== reader) break;
			}
		} catch (error) {
			// the track ended
		}
	}

	/** a new run: the encoder goes, and the next picture is a keyframe at its own time */
	#restart() {
		const encoder = this.#encoder;
		this.#encoder = null;
		this.#made = '';
		if (encoder && encoder.state !== 'closed') encoder.close();
		this.#keyframe = true;
		this.#shift = null;
		this.#readAt.clear();
	}

	#input(frame: VideoFrame) {
		const codec = this.#codec;
		if (!this.#active || !codec) {
			frame.close();
			return;
		}
		// H.264 is made of 2x2 blocks of colour: an odd size is cut down
		const even = codec.startsWith('avc1.');
		const width = even ? frame.displayWidth & ~1 : frame.displayWidth;
		const height = even ? frame.displayHeight & ~1 : frame.displayHeight;
		const made = `${codec}/${width}x${height}`;
		if (!this.#encoder || this.#made !== made) {
			this.#restart();
			this.#start(codec, width, height, made);
		}
		const encoder = this.#encoder;
		// a picture the encoder cannot take now is let go: the next one is
		// newer
		if (!encoder || encoder.encodeQueueSize > ENCODE_QUEUE) {
			frame.close();
			return;
		}
		const now = performance.now();
		if (this.#shift === null) {
			this.#shift =
				(this.#sent ? this.#sentUs + (now - this.#sentAt) * 1000 : 0) -
				frame.timestamp;
		}
		this.#readAt.set(frame.timestamp, now);
		let input = frame;
		try {
			if (width !== frame.displayWidth || height !== frame.displayHeight)
				input = new VideoFrame(frame, {
					visibleRect: { x: 0, y: 0, width, height },
					displayWidth: width,
					displayHeight: height,
				});
			encoder.encode(input, { keyFrame: this.#keyframe });
			this.#keyframe = false;
		} catch (error) {
			this.#restart();
		} finally {
			if (input !== frame) input.close();
			frame.close();
		}
	}

	#start(codec: string, width: number, height: number, made: string) {
		if (this.#refused === made) return;
		try {
			const encoder: VideoEncoder = new VideoEncoder({
				output: (chunk, metadata) => {
					// what the encoder encoded in, told with its keyframes
					const space = metadata?.decoderConfig?.colorSpace;
					if (space) this.#colour = colourBytes(space);
					this.#chunk(encoder, chunk);
				},
				error: () => {
					if (this.#encoder === encoder) this.#restart();
				},
			});
			encoder.configure({
				codec,
				width,
				height,
				bitrate: maxBitrate(width * height),
				latencyMode: 'realtime',
				...(codec.startsWith('avc1.')
					? { avc: { format: 'annexb' as const } }
					: {}),
			});
			this.#encoder = encoder;
			this.#made = made;
		} catch (error) {
			this.#refused = made;
		}
	}

	#chunk(encoder: VideoEncoder, chunk: EncodedVideoChunk) {
		const payload = this.#payload;
		if (encoder !== this.#encoder || !payload || this.#shift === null) return;
		const readAt = this.#readAt.get(chunk.timestamp);
		this.#readAt.delete(chunk.timestamp);
		const bytes = new Uint8Array(chunk.byteLength);
		chunk.copyTo(bytes);
		const now = performance.now();
		const us = chunk.timestamp + this.#shift;
		this.#sent = true;
		this.#sentUs = us;
		this.#sentAt = now;
		this.stats.frames++;
		this.stats.bytes += bytes.length;
		this.#write(
			{
				media: this.media,
				pt: payload.pt,
				flags: 0,
				level: ABSENT,
				orientation: ABSENT,
				colour: chunk.type === 'key' ? this.#colour : 0,
				time: BigInt(Math.round(us * VIDEO_UNITS) + this.#offset),
				rid: '',
				payload: bytes,
			},
			readAt === undefined ? 0 : Math.max(0, now - readAt),
		);
	}
}

export interface VideoReceiverStats {
	/** frames the stack handed over */
	frames: number;
	bytes: number;
	/** pictures decoded and written to the track */
	decoded: number;
	keyframes: number;
	/** frames let go: undecodable before a keyframe, or behind */
	dropped: number;
	/** keyframe requests sent */
	requests: number;
}

/**
 * What the wire's frames become on a track: each one decoded as it
 * arrives and the picture written. A frame that cannot be decoded (the
 * first is not a keyframe, something before it was lost, the decoder
 * failed) has the peer asked for a keyframe, and the frames up to it are
 * let go.
 */
export class VideoReceiver {
	#writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
	#decoder: VideoDecoder | null = null;
	/** what the decoder was configured for: the codec, and the color space */
	#codec = '';
	#space = '';
	/** the color space the peer last stated (the extension's bytes), 0 before it has */
	#colour = 0;
	/** nothing can be decoded before a keyframe */
	#needKey = true;
	#askedAt = -Infinity;
	/** the pictures' timestamps: when they arrived, in microseconds, always growing */
	#lastUs = 0;
	#started = false;
	#counts: VideoReceiverStats = {
		frames: 0,
		bytes: 0,
		decoded: 0,
		keyframes: 0,
		dropped: 0,
		requests: 0,
	};
	/** the payloads the section negotiated, by number: what each one's frames are decoded as */
	#payloads = new Map<number, Payload>();
	/** the first frame arrived: the track has pictures now */
	onStart: (() => void) | null = null;
	/** ask the peer for a keyframe (a PLI) */
	onKeyframe: (() => void) | null = null;

	get stats(): VideoReceiverStats {
		return { ...this.#counts };
	}

	/** the next frame heard is a start again (the section had stopped receiving) */
	rearm() {
		this.#started = false;
	}

	configure(payloads: Payload[]) {
		this.#payloads.clear();
		for (const payload of payloads) this.#payloads.set(payload.pt, payload);
	}

	/** the track's sink (a MediaStreamTrackGenerator's writable), or null */
	setTrack(writable: WritableStream<VideoFrame> | null) {
		const old = this.#writer;
		this.#writer = null;
		old?.close().catch(() => {});
		if (writable) this.#writer = writable.getWriter();
	}

	close() {
		this.setTrack(null);
		this.#closeDecoder();
	}

	#closeDecoder() {
		const decoder = this.#decoder;
		this.#decoder = null;
		this.#codec = '';
		this.#space = '';
		this.#needKey = true;
		if (decoder && decoder.state !== 'closed') decoder.close();
	}

	#ask(now: number) {
		if (now - this.#askedAt < KEYFRAME_WAIT_MS) return;
		this.#askedAt = now;
		this.#counts.requests++;
		this.onKeyframe?.();
	}

	/** a frame from the stack */
	frame(frame: Received & { colour?: number }, now = performance.now()) {
		this.#counts.frames++;
		this.#counts.bytes += frame.payload.length;
		if (!this.#started) {
			this.#started = true;
			this.onStart?.();
		}
		if (!this.#writer) return;
		const flags = frame.flags ?? 0;
		const key = (flags & FLAG_KEYFRAME) !== 0;
		const payload =
			frame.pt === undefined ? undefined : this.#payloads.get(frame.pt);
		const codec = payload
			? videoCodec(payload)
			: frame.codec.toUpperCase() === 'VP8'
				? 'vp8'
				: null;
		if (!codec) return;
		// something before it was lost: what follows cannot be decoded
		// until a keyframe
		if (!key && (flags & FLAG_CONTIGUOUS) === 0) this.#needKey = true;
		if (this.#needKey && !key) {
			this.#counts.dropped++;
			this.#ask(now);
			return;
		}
		if (frame.colour) this.#colour = frame.colour;
		const space = colourSpace(this.#colour) ?? UNSTATED;
		const spaceKey = JSON.stringify(space);
		if (
			key &&
			(!this.#decoder || this.#codec !== codec || this.#space !== spaceKey)
		) {
			this.#closeDecoder();
			this.#start(codec, space, spaceKey);
		}
		const decoder = this.#decoder;
		if (!decoder) {
			this.#counts.dropped++;
			return;
		}
		if (decoder.decodeQueueSize > DECODE_QUEUE) {
			// behind: let it go and start again from a keyframe
			this.#counts.dropped++;
			this.#needKey = true;
			this.#ask(now);
			return;
		}
		const us = Math.max(this.#lastUs + 1, Math.round(now * 1000));
		this.#lastUs = us;
		try {
			decoder.decode(
				new EncodedVideoChunk({
					type: key ? 'key' : 'delta',
					timestamp: us,
					data: frame.payload,
				}),
			);
			this.#needKey = false;
			if (key) this.#counts.keyframes++;
		} catch (error) {
			this.#closeDecoder();
			this.#ask(now);
		}
	}

	#start(codec: string, space: VideoColorSpaceInit, spaceKey: string) {
		try {
			const decoder: VideoDecoder = new VideoDecoder({
				output: (picture) => this.#decoded(decoder, picture),
				error: () => {
					if (this.#decoder !== decoder) return;
					this.#closeDecoder();
					this.#ask(performance.now());
				},
			});
			decoder.configure({ codec, optimizeForLatency: true, colorSpace: space });
			this.#decoder = decoder;
			this.#codec = codec;
			this.#space = spaceKey;
		} catch (error) {
			this.#decoder = null;
		}
	}

	#decoded(decoder: VideoDecoder, picture: VideoFrame) {
		const writer = this.#writer;
		// a sink that has not taken the last pictures is not given more
		if (
			decoder !== this.#decoder ||
			!writer ||
			(writer.desiredSize !== null && writer.desiredSize <= 0)
		) {
			picture.close();
			return;
		}
		this.#counts.decoded++;
		writer.write(picture).catch(() => picture.close());
	}
}
