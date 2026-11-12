// The stack's boundary (rust/rtc/src/lib.rs): records in and out of the
// wasm instance, and the few exports it has. Text records are `key=value`
// fields separated by 0x1f; datagrams and channel data are binary.

export const SEP = '\x1f';

export const OUT_TRANSMIT = 1;
export const OUT_EVENT = 2;
export const OUT_CHANNEL_DATA = 3;
export const OUT_TIMEOUT = 4;
export const OUT_RESULT = 5;

export const IN_DATAGRAM = 1;
export const IN_CONTROL = 2;
export const IN_CHANNEL_SEND = 3;

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

export const text = {
	encode: (value: string) => encoder.encode(value),
	decode: (bytes: Uint8Array) => decoder.decode(bytes),
};
