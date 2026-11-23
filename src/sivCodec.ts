// The siv codec (docs/codec.md, "The siv codec"): routes the host's server
// cannot read. The xor codec keeps a route from showing its URL, but its
// stream is the same for every URL under a key, so one URL a reader knows
// or guesses (every route starts with `https://`) gives the stream back for
// the others, and a server that sees a few routes reads them. A Tor-mode
// route that reaches the server (a request no service worker answers: a
// forced reload, a document no worker controls) must tell it nothing, so
// its routes are encrypted: deterministic authenticated encryption, the SIV
// construction (RFC 5297) with HMAC-SHA-256 as its PRF.
//
// The text's bytes (xorWire's, so any string comes back as it was) are
// padded to a multiple of 16 (0x80, then zeros: a route shows its length
// only to that); the IV is the first 16 bytes of their HMAC under the first
// half of the key, and they are encrypted with AES-256 in CTR mode from that
// IV (its last 32 bits counting the blocks) under the second half; the seal
// is the IV and the ciphertext in the URL-safe base64 alphabet. The same
// text is the same seal (a route stays one URL to the browser's caches, as
// under xor), two texts share no stream, and a seal whose IV does not match
// what it opens to is no seal.
//
// The key (64 random bytes, 128 hex digits) is drawn in the service worker
// and kept in its database like any codec's, and the proxied realms get it
// with their config; nothing sent to the host carries it. crypto-js and
// this file are in the full inject bundles only, as the aes and base64
// codecs' crypto-js is: the light ones take ./sivCodecStub.ts for it
// (build.js), and the service worker never hands them to a document or a
// worker of this codec (src/routeURL.ts cryptoInject).
import AES from 'crypto-js/aes';
import CryptoJS from 'crypto-js/core';
import HmacSHA256 from 'crypto-js/hmac-sha256';
import GenericCodec from './Codecs';
import { base64, bytesOf, textOf, unbase64 } from './xorWire';

// (AES is imported for the algorithm it registers, CryptoJS.algo.AES)
void AES;

/** `bytes` as crypto-js's big-endian words */
function wordsOf(bytes: Uint8Array): CryptoJS.lib.WordArray {
	const words: number[] = [];
	for (let at = 0; at < bytes.length; at += 4)
		words.push(
			(bytes[at] << 24) |
				((bytes[at + 1] ?? 0) << 16) |
				((bytes[at + 2] ?? 0) << 8) |
				(bytes[at + 3] ?? 0),
		);
	return CryptoJS.lib.WordArray.create(words, bytes.length);
}

/** byte `at` of crypto-js's big-endian `words` */
const byteOfWords = (words: number[], at: number) =>
	(words[at >>> 2] >>> (24 - 8 * (at & 3))) & 0xff;

/** the bytes of the synthetic IV, which leads a seal, and of a block */
const SIV_BYTES = 16;

/** crypto-js's AES as its modes use it: one block of four words encrypted where it stands */
interface BlockEncryptor {
	encryptBlock(words: number[], offset: number): void;
}

export class SIVCodec extends GenericCodec {
	#keys?: { mac: CryptoJS.lib.WordArray; block: BlockEncryptor };
	static generateKey(): string {
		const bytes = new Uint8Array(64);
		crypto.getRandomValues(bytes);
		let key = '';
		for (const byte of bytes) key += byte.toString(16).padStart(2, '0');
		return key;
	}
	/** whether `key` is one generateKey makes: 128 lower-case hex digits */
	static validKey(key: unknown): key is string {
		return typeof key === 'string' && /^[0-9a-f]{128}$/.test(key);
	}
	/** the key's halves, made at the first seal */
	#made() {
		return (this.#keys ??= {
			mac: CryptoJS.enc.Hex.parse(this.key.slice(0, 64)),
			block: CryptoJS.algo.AES.createEncryptor(
				CryptoJS.enc.Hex.parse(this.key.slice(64, 128)),
			) as unknown as BlockEncryptor,
		});
	}
	/** the synthetic IV of the padded text `bytes` */
	#iv(bytes: Uint8Array): Uint8Array {
		const mac = HmacSHA256(wordsOf(bytes), this.#made().mac).words;
		const iv = new Uint8Array(SIV_BYTES);
		for (let at = 0; at < SIV_BYTES; at++) iv[at] = byteOfWords(mac, at);
		return iv;
	}
	/** `bytes` encrypted in CTR mode from `iv` (or decrypted: it is its own inverse) */
	#crypt(bytes: Uint8Array, iv: Uint8Array): Uint8Array {
		const { block } = this.#made();
		const start = wordsOf(iv).words;
		const out = new Uint8Array(bytes.length);
		const counter = [0, 0, 0, 0];
		for (let at = 0; at < bytes.length; at += SIV_BYTES) {
			counter[0] = start[0];
			counter[1] = start[1];
			counter[2] = start[2];
			counter[3] = (start[3] + at / SIV_BYTES) | 0;
			block.encryptBlock(counter, 0);
			for (let byte = 0; byte < SIV_BYTES; byte++)
				out[at + byte] = bytes[at + byte] ^ byteOfWords(counter, byte);
		}
		return out;
	}
	encode(input: string): string {
		const bytes = bytesOf(input);
		const padded = new Uint8Array((bytes.length & ~15) + SIV_BYTES);
		padded.set(bytes);
		padded[bytes.length] = 0x80;
		const iv = this.#iv(padded);
		const sealed = new Uint8Array(SIV_BYTES + padded.length);
		sealed.set(iv);
		sealed.set(this.#crypt(padded, iv), SIV_BYTES);
		return base64(sealed);
	}
	/** the text `input` seals; empty for what is no seal, so nothing reads a URL out of it */
	decode(input: string): string {
		const bytes = unbase64(input);
		if (!bytes || bytes.length < 2 * SIV_BYTES || bytes.length % SIV_BYTES)
			return '';
		const iv = bytes.subarray(0, SIV_BYTES);
		const padded = this.#crypt(bytes.subarray(SIV_BYTES), iv);
		const check = this.#iv(padded);
		let differs = 0;
		for (let at = 0; at < SIV_BYTES; at++) differs |= check[at] ^ iv[at];
		if (differs) return '';
		let end = padded.length - 1;
		while (end > 0 && padded[end] === 0) end--;
		if (padded[end] !== 0x80) return '';
		return textOf(padded.subarray(0, end)) ?? '';
	}
}
