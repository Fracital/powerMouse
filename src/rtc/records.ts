// The stack's boundary (rust/rtc/src/lib.rs): records in and out of the
// wasm instance, and the few exports it has. Text records are `key=value`
// fields separated by 0x1f; datagrams, channel data and media frames are
// binary.

export const SEP = '\x1f';

export const OUT_TRANSMIT = 1;
export const OUT_EVENT = 2;
export const OUT_CHANNEL_DATA = 3;
export const OUT_TIMEOUT = 4;
export const OUT_RESULT = 5;
export const OUT_MEDIA_DATA = 6;

export const IN_DATAGRAM = 1;
export const IN_CONTROL = 2;
export const IN_CHANNEL_SEND = 3;
export const IN_MEDIA_WRITE = 4;

// frame flags (rust/rtc/src/media.rs)
/** a keyframe (received frames: the stack reads it off the payload) */
export const FLAG_KEYFRAME = 1;
/** nothing was lost between this frame and the one before it (received frames) */
export const FLAG_CONTIGUOUS = 2;
/** the first frame after a silence */
export const FLAG_TALKSPURT = 4;
/** the audio level says a voice is speaking */
export const FLAG_VOICE = 8;
/** a picture's dependency descriptor goes with it (`Frame.svc`) */
export const FLAG_DESCRIBED = 16;
/** a received picture's next layer follows in another frame */
export const FLAG_PART = 32;
/** "none" for a frame's level and orientation */
export const ABSENT = 255;

/** what a received frame's payload type carries (`codec_id` in the crate) */
export const CODECS: Record<number, string> = {
	1: 'opus',
	2: 'PCMU',
	3: 'PCMA',
	4: 'G722',
	5: 'CN',
	6: 'telephone-event',
	10: 'VP8',
	11: 'VP9',
	12: 'H264',
	13: 'AV1',
	14: 'H265',
};

export interface StackExports {
	memory: WebAssembly.Memory;
	_initialize?: () => void;
	a(len: number): number;
	f(ptr: number, len: number): void;
	c(ptr: number, len: number): number;
	i(id: number, kind: number, ptr: number, len: number): number;
	t(id: number): number;
	o(id: number): number;
	p(): number;
	d(id: number): void;
	l(ptr: number, len: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** a text record from fields; a value may hold anything but the separator */
export function encodeText(
	fields: Record<string, string | number>,
): Uint8Array {
	const parts: string[] = [];
	for (const key in fields) parts.push(`${key}=${fields[key]}`);
	return encoder.encode(parts.join(SEP));
}

export function decodeText(bytes: Uint8Array): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	for (const part of decoder.decode(bytes).split(SEP)) {
		const at = part.indexOf('=');
		if (at !== -1) out[part.slice(0, at)] = part.slice(at + 1);
	}
	return out;
}

/** `[proto u8][src len u16][src][dst len u16][dst][bytes]` */
export function encodeDatagram(
	proto: 'udp' | 'tcp',
	source: string,
	destination: string,
	payload: Uint8Array,
): Uint8Array {
	const src = encoder.encode(source);
	const dst = encoder.encode(destination);
	const out = new Uint8Array(5 + src.length + dst.length + payload.length);
	const view = new DataView(out.buffer);
	out[0] = proto === 'udp' ? 1 : 2;
	view.setUint16(1, src.length);
	out.set(src, 3);
	view.setUint16(3 + src.length, dst.length);
	out.set(dst, 5 + src.length);
	out.set(payload, 5 + src.length + dst.length);
	return out;
}

export interface Transmit {
	proto: 'udp' | 'tcp';
	source: string;
	destination: string;
	payload: Uint8Array;
}

/** the payload of an OUT_TRANSMIT record (after its tag) */
export function decodeTransmit(bytes: Uint8Array): Transmit {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const srcLen = view.getUint16(1);
	const source = decoder.decode(bytes.subarray(3, 3 + srcLen));
	const dstLen = view.getUint16(3 + srcLen);
	const at = 5 + srcLen;
	const destination = decoder.decode(bytes.subarray(at, at + dstLen));
	return {
		proto: bytes[0] === 1 ? 'udp' : 'tcp',
		source,
		destination,
		payload: bytes.subarray(at + dstLen),
	};
}

/** `[channel u16][binary u8][bytes]` */
export function encodeChannelSend(
	channel: number,
	binary: boolean,
	payload: Uint8Array,
): Uint8Array {
	const out = new Uint8Array(3 + payload.length);
	new DataView(out.buffer).setUint16(0, channel);
	out[2] = binary ? 1 : 0;
	out.set(payload, 3);
	return out;
}

export function decodeChannelData(bytes: Uint8Array): {
	channel: number;
	binary: boolean;
	payload: Uint8Array;
} {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		channel: view.getUint16(0),
		binary: bytes[2] === 1,
		payload: bytes.subarray(3),
	};
}

/** an encoded frame, to send or as received */
export interface Frame {
	/** the media section, by the stack's index */
	media: number;
	pt: number;
	flags: number;
	/** the audio level in -dBov (0 loudest, 127 silence), or ABSENT */
	level: number;
	/** the rotation as `urn:3gpp:video-orientation` numbers it, or ABSENT */
	orientation: number;
	/**
	 * A picture's color space as the color-space extension states it, its
	 * four bytes as one number (primaries, transfer, matrix, range and
	 * chroma siting); 0 or none for none
	 */
	colour?: number;
	/** the frame's time in units of its payload's clock */
	time: bigint;
	/** the simulcast layer, '' for none */
	rid: string;
	payload: Uint8Array;
	/** a received frame's RTP sequence number (its first packet's) */
	seq?: number;
	/** a picture's size for the page's encoded transform: a sent one's as encoded, a received one's as the stack read it */
	width?: number;
	height?: number;
	/** what a picture's dependency descriptor says, with FLAG_DESCRIBED */
	svc?: Svc;
}

/**
 * A picture's place among the others (its dependency descriptor): its id
 * (a received one's counted on past the wire's 16 bits), the ids of the
 * pictures it depends on, its layers; a sent one's temporal layers and
 * how many pictures back the base layer's last one is (its chain)
 */
export interface Svc {
	id: number;
	deps: number[];
	spatial?: number;
	temporal: number;
	layers?: number;
	chain?: number;
}

/**
 * `[media u8][pt u8][flags u8][level u8][orientation u8][colour u32][age ms u16][time u64][rid len u8][rid][svc][bytes]`:
 * `age` is how long ago the frame was captured; `svc` (FLAG_DESCRIBED) is
 * `[temporal layers u8][temporal u8][id u16][chain u8][count u8][how far back each dependency is, u8...][width u16][height u16]`
 * (the size the structure states)
 */
export function encodeFrame(frame: Frame, age: number): Uint8Array {
	const rid = encoder.encode(frame.rid);
	const svc = frame.flags & FLAG_DESCRIBED ? frame.svc : undefined;
	const deps = svc ? svc.deps : [];
	const head = 20 + rid.length + (svc ? 10 + deps.length : 0);
	const out = new Uint8Array(head + frame.payload.length);
	const view = new DataView(out.buffer);
	out[0] = frame.media;
	out[1] = frame.pt;
	out[2] = svc ? frame.flags : frame.flags & ~FLAG_DESCRIBED;
	out[3] = frame.level;
	out[4] = frame.orientation;
	view.setUint32(5, frame.colour ?? 0);
	view.setUint16(9, Math.max(0, Math.min(65535, Math.round(age))));
	view.setBigUint64(11, frame.time);
	out[19] = rid.length;
	out.set(rid, 20);
	if (svc) {
		let at = 20 + rid.length;
		out[at++] = svc.layers ?? 1;
		out[at++] = svc.temporal;
		view.setUint16(at, svc.id & 0xffff);
		out[at + 2] = Math.min(255, svc.chain ?? 0);
		out[at + 3] = deps.length;
		at += 4;
		for (const dep of deps)
			out[at++] = Math.max(1, Math.min(255, svc.id - dep));
		view.setUint16(at, frame.width ?? 0);
		view.setUint16(at + 2, frame.height ?? 0);
	}
	out.set(frame.payload, head);
	return out;
}

/**
 * the payload of an OUT_MEDIA_DATA record (after its tag):
 * `[media u8][pt u8][codec u8][flags u8][level u8][orientation u8][colour u32][time u64][seq u16][rid len u8][rid][width u16][height u16][svc][bytes]`,
 * the size the one Chrome reads (0 by 0 for none), `svc` (FLAG_DESCRIBED)
 * `[id u32][spatial u8][temporal u8][count u8][dependencies u32...]`
 */
export function decodeMediaData(bytes: Uint8Array): Frame & { codec: string } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ridLen = bytes[20];
	let at = 25 + ridLen;
	let svc: Svc | undefined;
	if (bytes[3] & FLAG_DESCRIBED) {
		const deps = [];
		for (let n = 0; n < bytes[at + 6]; n++)
			deps.push(view.getUint32(at + 7 + 4 * n));
		svc = {
			id: view.getUint32(at),
			deps,
			spatial: bytes[at + 4],
			temporal: bytes[at + 5],
		};
		at += 7 + 4 * deps.length;
	}
	return {
		media: bytes[0],
		pt: bytes[1],
		codec: CODECS[bytes[2]] ?? '',
		flags: bytes[3],
		level: bytes[4],
		orientation: bytes[5],
		colour: view.getUint32(6),
		time: view.getBigUint64(10),
		seq: view.getUint16(18),
		rid: decoder.decode(bytes.subarray(21, 21 + ridLen)),
		width: view.getUint16(21 + ridLen),
		height: view.getUint16(23 + ridLen),
		payload: bytes.subarray(at),
		...(svc && { svc }),
	};
}

export const text = {
	encode: (value: string) => encoder.encode(value),
	decode: (bytes: Uint8Array) => decoder.decode(bytes),
};
