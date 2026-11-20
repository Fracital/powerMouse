// Chromium's CRX3_WITH_PUBLISHER_PROOF (components/crx_file/crx_verifier.cc).
// The signature covers the signed header and the ZIP, not just the manifest.
import { idFromBytes } from '../../extensions/crx';

const PUBLISHER =
	'61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';
const invalid = (): never => {
	throw new Error('Invalid Chrome Web Store package signature');
};

/** CRX3's protobuf messages use length-delimited fields. Reject truncated or unsupported encodings. */
function fields(bytes: Uint8Array) {
	let at = 0;
	const uint = () => {
		let n = 0;
		for (let shift = 0; at < bytes.length && shift < 35; shift += 7) {
			const byte = bytes[at++];
			n += (byte & 127) * 2 ** shift;
			if (byte < 128) return n;
		}
		return invalid();
	};
	const out = new Map<number, Uint8Array[]>();
	while (at < bytes.length) {
		const tag = uint();
		if (tag % 8 !== 2 || tag < 8) invalid();
		const size = uint();
		if (size > bytes.length - at) invalid();
		const id = Math.floor(tag / 8);
		const list = out.get(id) ?? [];
		list.push(bytes.subarray(at, at + size));
		out.set(id, list);
		at += size;
	}
	return out;
}

/** Exactly one value: no ambiguity between the verifier and the ZIP reader. */
function one(fields: Map<number, Uint8Array[]>, tag: number) {
	const list = fields.get(tag);
	return list?.length === 1 ? list[0] : invalid();
}

/** A DER ECDSA P-256 signature to WebCrypto's two fixed-width integers. */
function ecdsaSignature(der: Uint8Array) {
	if (der[0] !== 48 || der[1] !== der.length - 2) invalid();
	const raw = new Uint8Array(64);
	let at = 2;
	for (const end of [32, 64]) {
		if (der[at++] !== 2) invalid();
		const size = der[at++];
		if (!size || size > 33 || at + size > der.length || der[at] >= 128)
			invalid();
		let n = der.subarray(at, at + size);
		at += size;
		if (n.length > 1 && n[0] === 0) {
			if (n[1] < 128) invalid();
			n = n.subarray(1);
		}
		if (n.length > 32) invalid();
		raw.set(n, end - n.length);
	}
	if (at !== der.length) invalid();
	return raw;
}

export async function verifyStorePackage(bytes: Uint8Array, expected: string) {
	if (bytes.length < 12) invalid();
	const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = 12 + header.getUint32(8, true);
	if (
		header.getUint32(0, true) !== 0x34327243 ||
		header.getUint32(4, true) !== 3 ||
		end >= bytes.length
	)
		invalid();
	const encoded = bytes.subarray(12, end);
	for (
		let at = encoded.indexOf(0x50);
		at !== -1;
		at = encoded.indexOf(0x50, at + 1)
	) {
		if (
			encoded[at + 1] === 0x4b &&
			[0x506, 0x607, 0x606].includes(encoded[at + 2] * 256 + encoded[at + 3])
		)
			invalid();
	}
	const proofs = fields(encoded);
	const signed = one(proofs, 10000);
	const id = one(fields(signed), 1);
	if (id.length !== 16 || idFromBytes(id) !== expected) invalid();
	const prefix = new TextEncoder().encode('CRX3 SignedData\0');
	const data = new Uint8Array(
		prefix.length + 4 + signed.length + bytes.length - end,
	);
	data.set(prefix);
	new DataView(data.buffer).setUint32(prefix.length, signed.length, true);
	data.set(signed, prefix.length + 4);
	data.set(bytes.subarray(end), prefix.length + 4 + signed.length);
	let developer = false;
	let publisher = false;
	for (const type of [2, 3]) {
		for (const proof of proofs.get(type) ?? []) {
			const values = fields(proof);
			const spki = one(values, 1) as Uint8Array<ArrayBuffer>;
			const signature = one(values, 2) as Uint8Array<ArrayBuffer>;
			const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
			const rsa = type === 2;
			const key = await crypto.subtle.importKey(
				'spki',
				spki,
				rsa
					? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
					: { name: 'ECDSA', namedCurve: 'P-256' },
				false,
				['verify'],
			);
			if (
				!(await crypto.subtle.verify(
					rsa ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash: 'SHA-256' },
					key,
					rsa ? signature : ecdsaSignature(signature),
					data,
				))
			)
				invalid();
			developer ||= idFromBytes(hash) === expected;
			publisher ||=
				Array.from(hash, (n) => n.toString(16).padStart(2, '0')).join('') ===
				PUBLISHER;
		}
	}
	if (!developer || !publisher) invalid();
}
