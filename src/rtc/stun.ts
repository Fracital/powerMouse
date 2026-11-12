// STUN messages (RFC 8489) as the worker writes and reads them: the Binding
// request behind each srflx candidate, and the TURN client's requests and
// indications (src/rtc/turn.ts). A Binding request is retransmitted on the
// RFC's schedule (RTO 500 ms doubling, seven requests, given up after
// 39.5 s), which is the timing Chrome's 701 "STUN binding request timed
// out" shows.

const MAGIC = 0x2112a442;

export const BINDING_REQUEST = 0x0001;
export const BINDING_SUCCESS = 0x0101;
export const BINDING_ERROR = 0x0111;

export const ATTR_MAPPED_ADDRESS = 0x0001;
export const ATTR_USERNAME = 0x0006;
export const ATTR_MESSAGE_INTEGRITY = 0x0008;
export const ATTR_ERROR_CODE = 0x0009;
export const ATTR_CHANNEL_NUMBER = 0x000c;
export const ATTR_LIFETIME = 0x000d;
export const ATTR_XOR_PEER_ADDRESS = 0x0012;
export const ATTR_DATA = 0x0013;
export const ATTR_REALM = 0x0014;
export const ATTR_NONCE = 0x0015;
export const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
export const ATTR_REQUESTED_TRANSPORT = 0x0019;
export const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

/** the send times of the seven requests, ms after the first; the client gives up 8 s after the last */
export const STUN_SCHEDULE_MS = [0, 500, 1500, 3500, 7500, 15500, 31500];
export const STUN_GIVE_UP_MS = 39500;

export interface Address {
	address: string;
	port: number;
}

export const joinAddress = (host: string, port: number | string) =>
	host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
export function splitAddress(address: string): { host: string; port: number } {
	const at = address.lastIndexOf(':');
	let host = address.slice(0, at);
	if (host.startsWith('[')) host = host.slice(1, -1);
	return { host, port: Number(address.slice(at + 1)) };
}

export type Attribute = [type: number, value: Uint8Array];

export function transactionId(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(12));
}

/** a STUN message: the header, then each attribute padded to four bytes */
export function stunMessage(
	type: number,
	id: Uint8Array,
	attributes: Attribute[] = [],
): Uint8Array {
	let size = 0;
	for (const [, value] of attributes) size += 4 + ((value.length + 3) & ~3);
	const bytes = new Uint8Array(20 + size);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, type);
	view.setUint16(2, size);
	view.setUint32(4, MAGIC);
	bytes.set(id, 8);
	let at = 20;
	for (const [attribute, value] of attributes) {
		view.setUint16(at, attribute);
		view.setUint16(at + 2, value.length);
		bytes.set(value, at + 4);
		at += 4 + ((value.length + 3) & ~3);
	}
	return bytes;
}

export function bindingRequest(): { bytes: Uint8Array; id: Uint8Array } {
	const id = transactionId();
	return { bytes: stunMessage(BINDING_REQUEST, id), id };
}

/** whether `bytes` is a STUN message with this transaction id */
export function isAnswerTo(bytes: Uint8Array, id: Uint8Array): boolean {
	if (bytes.length < 20) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(4) !== MAGIC) return false;
	for (let at = 0; at < 12; at++) if (bytes[8 + at] !== id[at]) return false;
	return true;
}

export interface StunMessage {
	type: number;
	id: Uint8Array;
	attributes: Attribute[];
	/** where each attribute starts in the message, for the integrity check's prefix */
	offsets: number[];
}

/** a STUN message's parts, `null` for bytes that are not one */
export function parseStun(bytes: Uint8Array): StunMessage | null {
	if (bytes.length < 20 || bytes[0] & 0xc0) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(4) !== MAGIC) return null;
	const end = Math.min(bytes.length, 20 + view.getUint16(2));
	const attributes: Attribute[] = [];
	const offsets: number[] = [];
	let at = 20;
	while (at + 4 <= end) {
		const size = view.getUint16(at + 2);
		if (at + 4 + size > end) break;
		attributes.push([
			view.getUint16(at),
			bytes.subarray(at + 4, at + 4 + size),
		]);
		offsets.push(at);
		at += 4 + ((size + 3) & ~3);
	}
	return {
		type: view.getUint16(0),
		id: bytes.slice(8, 20),
		attributes,
		offsets,
	};
}

export function attributeOf(
	message: StunMessage,
	type: number,
): Uint8Array | null {
	for (const [attribute, value] of message.attributes)
		if (attribute === type) return value;
	return null;
}

/** the code of an ERROR-CODE attribute (401, 438, ...), `null` without one */
export function errorOf(message: StunMessage): number | null {
	const value = attributeOf(message, ATTR_ERROR_CODE);
	if (!value || value.length < 4) return null;
	return (value[2] & 0x07) * 100 + value[3];
}

/** the mask an XOR address is folded with: the magic cookie, then the transaction id */
function mask(id: Uint8Array): Uint8Array {
	const out = new Uint8Array(16);
	new DataView(out.buffer).setUint32(0, MAGIC);
	out.set(id, 4);
	return out;
}

/** an address attribute's value, XORed (XOR-MAPPED, XOR-PEER, XOR-RELAYED) or plain (MAPPED) */
export function decodeAddress(
	value: Uint8Array,
	id: Uint8Array,
	xor = true,
): Address | null {
	if (value.length < 8) return null;
	const fold = xor ? mask(id) : new Uint8Array(16);
	const port = ((value[2] ^ fold[0]) << 8) | (value[3] ^ fold[1]);
	if (value[1] === 0x01) {
		const octets: number[] = [];
		for (let k = 0; k < 4; k++) octets.push(value[4 + k] ^ fold[k]);
		return { address: octets.join('.'), port };
	}
	if (value[1] === 0x02 && value.length >= 20) {
		const words: string[] = [];
		for (let k = 0; k < 8; k++)
			words.push(
				(
					((value[4 + k * 2] ^ fold[k * 2]) << 8) |
					(value[5 + k * 2] ^ fold[k * 2 + 1])
				).toString(16),
			);
		return { address: words.join(':'), port };
	}
	return null;
}

/** the bytes of an IPv6 address in text (with `::`), `null` for anything else */
function ipv6Bytes(text: string): Uint8Array | null {
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const words = [...head, ...new Array<string>(missing).fill('0'), ...tail];
	const out = new Uint8Array(16);
	for (let k = 0; k < 8; k++) {
		const word = parseInt(words[k], 16);
		if (!/^[0-9a-fA-F]{1,4}$/.test(words[k])) return null;
		out[k * 2] = word >> 8;
		out[k * 2 + 1] = word & 0xff;
	}
	return out;
}

/** an XOR address attribute's value for `host:port`, `null` when the host is a name */
export function encodeAddress(
	host: string,
	port: number,
	id: Uint8Array,
): Uint8Array | null {
	const fold = mask(id);
	let raw: Uint8Array;
	if (host.includes(':')) {
		const bytes = ipv6Bytes(host);
		if (!bytes) return null;
		raw = bytes;
	} else {
		const parts = host.split('.');
		if (parts.length !== 4) return null;
		raw = new Uint8Array(4);
		for (let k = 0; k < 4; k++) {
			if (!/^\d{1,3}$/.test(parts[k]) || Number(parts[k]) > 255) return null;
			raw[k] = Number(parts[k]);
		}
	}
	const out = new Uint8Array(4 + raw.length);
	out[1] = raw.length === 4 ? 0x01 : 0x02;
	out[2] = (port >> 8) ^ fold[0];
	out[3] = (port & 0xff) ^ fold[1];
	for (let k = 0; k < raw.length; k++) out[4 + k] = raw[k] ^ fold[k];
	return out;
}

/**
 * The reflexive address a Binding answer carries, `{ error }` for an error
 * answer, `null` for one without an address
 */
export function reflexiveOf(
	bytes: Uint8Array,
): Address | { error: number } | null {
	const message = parseStun(bytes);
	if (
		!message ||
		(message.type !== BINDING_SUCCESS && message.type !== BINDING_ERROR)
	)
		return null;
	const error = errorOf(message);
	if (error !== null) return { error };
	const xored = attributeOf(message, ATTR_XOR_MAPPED_ADDRESS);
	if (xored) return decodeAddress(xored, message.id);
	const plain = attributeOf(message, ATTR_MAPPED_ADDRESS);
	return plain ? decodeAddress(plain, message.id, false) : null;
}
