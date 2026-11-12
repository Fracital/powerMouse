// the three parts the codecs use, not the whole library: every realm that
// loads the bundle (each proxied frame) evaluates what is imported, and the
// rest (SHA-3, RIPEMD, TripleDES, Blowfish, ...) was about 100 KB of heap
import AES from 'crypto-js/aes';
import Base64 from 'crypto-js/enc-base64';
import Utf8 from 'crypto-js/enc-utf8';
import MD5 from 'crypto-js/md5';
import { openText, sealText } from './wasm/codec';
import { generateKey, keyHalves, validKey } from './xorWire';

const encodeChar = '$';
const validChars =
	'-_~:0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function validCodecURI(uri: string) {
	for (let i = 0; i < uri.length; i++) {
		if (!validChars.includes(uri[i])) {
			return false;
		}
	}
	return true;
}

export function encodeCodecURI(input: string) {
	let result = '';
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (validChars.includes(char) && char !== encodeChar) {
			result += char;
		} else {
			const code = input.charCodeAt(i);
			result += encodeChar + code.toString(16).padStart(2, '0');
		}
	}
	return result;
}

export function decodeCodecURI(uri: string) {
	let result = '';
	for (let i = 0; i < uri.length; i++) {
		const char = uri[i];
		if (char === encodeChar) {
			const code = parseInt(uri.slice(i + 1, i + 3), 16);
			const decoded = String.fromCharCode(code);
			result += decoded;
			i += 2;
		} else {
			result += char;
		}
	}
	return result;
}

export default class GenericCodec {
	key: string;
	constructor(key: string) {
		this.key = key;
	}
	static generateKey(): string {
		return '';
	}
	encode(input: string): string {
		return encodeCodecURI(input);
	}
	/**
	 * `input` encoded to the same text every time: a link route's
	 * (src/visited.ts), which the browser's history is asked for by its
	 * exact URL. Every codec decodes it with `decode`.
	 */
	encodeStable(input: string): string {
		return this.encode(input);
	}
	decode(input: string): string {
		input = decodeCodecURI(input);
		return input;
	}
}

/**
 * The xor codec (docs/codec.md, src/xorWire.ts): every byte of the URL
 * XORed with a stream drawn from the key, in the URL-safe base64 alphabet.
 * The key is 16 hex digits, the stream's two halves. Sealed and opened in
 * the codec module where the realm has one (src/wasm/codec.ts), in
 * JavaScript otherwise: the same text either way.
 */
export class XORCodec extends GenericCodec {
	readonly #a: number;
	readonly #b: number;
	constructor(key: string) {
		super(key);
		[this.#a, this.#b] = keyHalves(key);
	}
	static generateKey(): string {
		return generateKey();
	}
	/** whether `key` is one generateKey makes (a key of the codec before this one is not) */
	static validKey(key: unknown): key is string {
		return validKey(key);
	}
	encode(input: string): string {
		return sealText(input, this.#a, this.#b);
	}
	/** the text `input` seals; empty for what is no seal, so nothing reads a URL out of it */
	decode(input: string): string {
		return openText(input, this.#a, this.#b) ?? '';
	}
}

export class AESCodec extends GenericCodec {
	static generateKey(): string {
		return Math.random().toString(36).slice(2);
	}
	encode(input: string): string {
		const result = AES.encrypt(input, this.key).toString();
		return encodeCodecURI(result);
	}
	// (the salt, random for `encode`, is the input's own: equal inputs
	// read equal, which is all a link route shows and what it is for)
	encodeStable(input: string): string {
		const salt = MD5(`${this.key}\n${input}`);
		salt.sigBytes = 8;
		salt.clamp();
		return encodeCodecURI(AES.encrypt(input, this.key, { salt }).toString());
	}
	decode(input: string): string {
		input = decodeCodecURI(input);
		return AES.decrypt(input, this.key).toString(Utf8);
	}
}

export class Base64Codec {
	key: string;
	constructor(key: string) {
		this.key = key;
	}
	static generateKey(): string {
		return '';
	}
	encode(input: string): string {
		return encodeCodecURI(Base64.stringify(Utf8.parse(input)));
	}
	encodeStable(input: string): string {
		return this.encode(input);
	}
	decode(input: string): string {
		input = decodeCodecURI(input);
		return Utf8.stringify(Base64.parse(input));
	}
}
