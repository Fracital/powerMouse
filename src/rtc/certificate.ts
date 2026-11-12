// The DTLS certificate of a connection: an ECDSA P-256 key from WebCrypto
// and a self-signed X.509 certificate written here (DER by hand: the stack's
// crypto backend verifies and signs but generates none), as Chrome's own
// (subject and issuer `CN=WebRTC`, valid from a day ago for thirty days,
// ecdsa-with-SHA256). The stack takes the certificate DER and the PKCS#8
// key DER; the fingerprint in the SDP is the stack's SHA-256 of the DER.

export interface Certificate {
	/** the certificate, DER */
	certificate: Uint8Array;
	/** the private key, PKCS#8 DER */
	privateKey: Uint8Array;
	/** `sha-256 AA:BB:...` as it reads in `a=fingerprint` */
	fingerprint: string;
	expires: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// --- DER ---

function length(len: number): number[] {
	if (len < 0x80) return [len];
	const bytes: number[] = [];
	for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
	return [0x80 | bytes.length, ...bytes];
}
function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const head = [tag, ...length(total)];
	const out = new Uint8Array(head.length + total);
	out.set(head);
	let at = head.length;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts);
/**
 * A non-negative INTEGER from its big-endian bytes, as DER has it: in the
 * fewest bytes, with a zero byte first only where the first would read as
 * a sign. A parser of the far end refuses any other (dimpl's, OpenSSL's),
 * and with it the certificate and the handshake.
 */
function integer(bytes: Uint8Array): Uint8Array {
	let at = 0;
	while (at < bytes.length - 1 && bytes[at] === 0 && !(bytes[at + 1] & 0x80))
		at++;
	const value = bytes.subarray(at);
	return tlv(0x02, value[0] & 0x80 ? new Uint8Array([0, ...value]) : value);
}
const bitString = (bytes: Uint8Array) =>
	tlv(0x03, new Uint8Array([0, ...bytes]));
const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 | n, inner);
const nul = new Uint8Array([0x05, 0x00]);
function oid(dotted: string): Uint8Array {
	const parts = dotted.split('.').map(Number);
	const bytes: number[] = [parts[0] * 40 + parts[1]];
	for (const part of parts.slice(2)) {
		const chunk: number[] = [part & 0x7f];
		for (let n = part >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
		bytes.push(...chunk);
	}
	return tlv(0x06, new Uint8Array(bytes));
}
function utcTime(at: number): Uint8Array {
	const d = new Date(at);
	const two = (n: number) => String(n).padStart(2, '0');
	const text = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(
		d.getUTCDate(),
	)}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
	return tlv(0x17, new TextEncoder().encode(text));
}

const ECDSA_WITH_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const COMMON_NAME = oid('2.5.4.3');

/** an ECDSA signature from WebCrypto's raw r||s to DER */
function derSignature(raw: Uint8Array): Uint8Array {
	const half = raw.length / 2;
	return seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

const hex = (bytes: Uint8Array) =>
	[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function generateCertificate(): Promise<Certificate> {
	const keys = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	);
	const spki = new Uint8Array(
		await crypto.subtle.exportKey('spki', keys.publicKey),
	);
	const privateKey = new Uint8Array(
		await crypto.subtle.exportKey('pkcs8', keys.privateKey),
	);
	// 64 random bits, as Chrome's: eight bytes, or nine with the sign byte
	const serial = crypto.getRandomValues(new Uint8Array(8));
	const name = seq(set(seq(COMMON_NAME, utf8('WebRTC'))));
	const notBefore = Date.now() - DAY_MS;
	const expires = Date.now() + 30 * DAY_MS;
	const tbs = seq(
		explicit(0, integer(new Uint8Array([2]))),
		integer(serial),
		ECDSA_WITH_SHA256,
		name,
		seq(utcTime(notBefore), utcTime(expires)),
		name,
		spki,
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			keys.privateKey,
			tbs as BufferSource,
		),
	);
	const certificate = seq(
		tbs,
		ECDSA_WITH_SHA256,
		bitString(derSignature(signature)),
	);
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', certificate as BufferSource),
	);
	const fingerprint = `sha-256 ${[...digest]
		.map((b) => b.toString(16).padStart(2, '0').toUpperCase())
		.join(':')}`;
	return { certificate, privateKey, fingerprint, expires };
}

export { hex, nul };
