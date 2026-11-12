// The xor codec's wire (docs/codec.md): what a routed URL's last segment
// is under `codec: 'xor'`. The text's bytes, each XORed with a byte of a
// stream drawn from the controller's key, in the URL-safe base64 alphabet
// without padding: no character of the URL stands in its route, where the
// codec before this one XORed one character in four (or none, with one key
// in fifteen) and left the rest as written.
//
// The bytes of a text: its characters when every one is ASCII (what a URL
// serializes to), else 0xFF and then every UTF-16 code unit, high byte
// first, so any string comes back as it was, a surrogate with no other
// half included.
//
// The stream: byte `n` is XORed with byte `n & 3` (from the low end) of
// `word(n >> 2)`, `word(j) = mix(mix(a + j * 0x9E3779B9) ^ b)` in 32-bit
// arithmetic, `a` and `b` the halves of the key, `mix` MurmurHash3's
// finalizer.
//
// Two things write this wire and they write the same bytes for every text
// and key: the module (rust/codec, `codec.wasm`, src/wasm/codec.ts)
// wherever a realm has it, and `seal` and `open` here wherever it does not
// (a realm that may not compile one, a text before the first instance).
// rust/host/codec.mjs and the codec suite hold the two together.

/** the URL-safe base64 alphabet */
const ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CODES = new Uint8Array(64);
/** a character code's six bits; 0xFF for one outside the alphabet */
const SIX = new Uint8Array(128).fill(0xff);
for (let at = 0; at < 64; at++) {
	CODES[at] = ALPHABET.charCodeAt(at);
	SIX[CODES[at]] = at;
}

/** what leads the bytes of a text that is not all ASCII */
const WIDE = 0xff;

function mix(x: number): number {
	x ^= x >>> 16;
	x = Math.imul(x, 0x85ebca6b);
	x ^= x >>> 13;
	x = Math.imul(x, 0xc2b2ae35);
	return x ^ (x >>> 16);
}

/** word `j` of the stream of the key `a`, `b` (an int32) */
export function streamWord(a: number, b: number, j: number): number {
	return mix(mix((a + Math.imul(j, 0x9e3779b9)) | 0) ^ b);
}

/**
 * The bytes of `text` written to `bytes` from its start, when every
 * character is ASCII and they fit: how many, or -1
 */
export function asciiInto(text: string, bytes: Uint8Array): number {
	const length = text.length;
	if (length > bytes.length) return -1;
	for (let at = 0; at < length; at++) {
		const unit = text.charCodeAt(at);
		if (unit > 0x7f) return -1;
		bytes[at] = unit;
	}
	return length;
}

/** the bytes of `text` (see the top of the file) */
export function bytesOf(text: string): Uint8Array {
	const ascii = new Uint8Array(text.length);
	if (asciiInto(text, ascii) !== -1) return ascii;
	const bytes = new Uint8Array(1 + text.length * 2);
	bytes[0] = WIDE;
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		bytes[1 + at * 2] = unit >> 8;
		bytes[2 + at * 2] = unit & 0xff;
	}
	return bytes;
}

/** ASCII bytes as a string */
export function asciiText(bytes: Uint8Array): string {
	let text = '';
	// (an argument list has a limit; a URL is rarely past the first piece)
	for (let at = 0; at < bytes.length; at += 8192)
		text += String.fromCharCode.apply(
			null,
			bytes.subarray(at, at + 8192) as unknown as number[],
		);
	return text;
}

/**
 * The text `bytes` are the bytes of, or null when they are no text's: a
 * byte past ASCII without the lead, half a code unit, or the lead before
 * what is all ASCII (which is written without it: a text has one form)
 */
export function textOf(bytes: Uint8Array): string | null {
	if (bytes[0] !== WIDE) {
		for (let at = 0; at < bytes.length; at++) if (bytes[at] > 0x7f) return null;
		return asciiText(bytes);
	}
	if (bytes.length % 2 === 0) return null;
	let text = '';
	let wide = false;
	const units: number[] = [];
	for (let at = 1; at < bytes.length; at += 2) {
		const unit = (bytes[at] << 8) | bytes[at + 1];
		if (unit > 0x7f) wide = true;
		units.push(unit);
		if (units.length === 8192) {
			text += String.fromCharCode.apply(null, units);
			units.length = 0;
		}
	}
	if (!wide) return null;
	return text + String.fromCharCode.apply(null, units);
}

/** `bytes` XORed in place with the stream of the key `a`, `b` from its first byte */
function mask(bytes: Uint8Array, a: number, b: number): Uint8Array {
	let word = 0;
	for (let at = 0; at < bytes.length; at++) {
		if ((at & 3) === 0) word = streamWord(a, b, at >>> 2);
		bytes[at] ^= word >>> (8 * (at & 3));
	}
	return bytes;
}

/** `bytes` in the URL-safe base64 alphabet, without padding */
export function base64(bytes: Uint8Array): string {
	const length = bytes.length;
	const rest = length % 3;
	const whole = length - rest;
	const out = new Uint8Array((whole / 3) * 4 + (rest ? rest + 1 : 0));
	let written = 0;
	let at = 0;
	for (; at < whole; at += 3) {
		const bits = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
		out[written++] = CODES[bits >> 18];
		out[written++] = CODES[(bits >> 12) & 63];
		out[written++] = CODES[(bits >> 6) & 63];
		out[written++] = CODES[bits & 63];
	}
	if (rest) {
		const bits = (bytes[at] << 16) | (rest === 2 ? bytes[at + 1] << 8 : 0);
		out[written] = CODES[bits >> 18];
		out[written + 1] = CODES[(bits >> 12) & 63];
		if (rest === 2) out[written + 2] = CODES[(bits >> 6) & 63];
	}
	return asciiText(out);
}

/**
 * The bytes `text` is the base64 of, or null when it is none as `base64`
 * writes it: a character outside the alphabet, a length it never has, bits
 * set after the last byte
 */
export function unbase64(text: string): Uint8Array | null {
	const length = text.length;
	const rest = length % 4;
	if (rest === 1) return null;
	const whole = length - rest;
	const bytes = new Uint8Array((whole / 4) * 3 + (rest ? rest - 1 : 0));
	// every character's six bits are OR-ed here: one outside the alphabet
	// leaves a bit above them set
	let seen = 0;
	const six = (at: number): number => {
		const code = text.charCodeAt(at);
		const value = code < 128 ? SIX[code] : 0xff;
		seen |= value;
		return value & 63;
	};
	let written = 0;
	let at = 0;
	for (; at < whole; at += 4) {
		const bits =
			(six(at) << 18) | (six(at + 1) << 12) | (six(at + 2) << 6) | six(at + 3);
		bytes[written++] = bits >> 16;
		bytes[written++] = bits >> 8;
		bytes[written++] = bits;
	}
	if (rest) {
		const bits =
			(six(at) << 18) |
			(six(at + 1) << 12) |
			(rest === 3 ? six(at + 2) << 6 : 0);
		if (bits & (rest === 3 ? 0xff : 0xffff)) return null;
		bytes[written] = bits >> 16;
		if (rest === 3) bytes[written + 1] = bits >> 8;
	}
	return seen & 0xc0 ? null : bytes;
}

/**
 * `bytes` sealed under the key `a`, `b`: the JavaScript side of the wire.
 * The bytes are the caller's to give up (they are XORed where they stand).
 */
export function seal(bytes: Uint8Array, a: number, b: number): string {
	return base64(mask(bytes, a, b));
}

/**
 * The bytes the seal `text` holds under the key `a`, `b`, or null when it
 * is no seal (see `unbase64`)
 */
export function open(text: string, a: number, b: number): Uint8Array | null {
	const bytes = unbase64(text);
	return bytes && mask(bytes, a, b);
}

/** the key's two halves, `a` then `b`, of its 16 hex digits (0 for what is none) */
export function keyHalves(key: string): [number, number] {
	return [
		parseInt(key.slice(0, 8), 16) | 0,
		parseInt(key.slice(8, 16), 16) | 0,
	];
}

/** whether `key` is a key of this wire: 16 lower-case hex digits */
export function validKey(key: unknown): key is string {
	return typeof key === 'string' && /^[0-9a-f]{16}$/.test(key);
}

/** a new key, from the platform's random source */
export function generateKey(): string {
	const words = new Uint32Array(2);
	crypto.getRandomValues(words);
	return (
		words[0].toString(16).padStart(8, '0') +
		words[1].toString(16).padStart(8, '0')
	);
}
