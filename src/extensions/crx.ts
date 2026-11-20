// Reading a .crx (versions 2 and 3) down to its zip, and Chrome's extension
// id: the first 16 bytes of the SHA-256 of the public key, as hex mapped
// 0-f to a-p. Ported from STicks (src/crx.ts).
const MAGIC = 0x34327243; // "Cr24"

export interface CrxParts {
	zip: Uint8Array;
	/** the id the CRX3 header declares (32 letters a-p) */
	crxId: string | null;
	/** the CRX2 public key */
	publicKey: Uint8Array | null;
}

/** an extension id: 32 letters a-p */
export const EXTENSION_ID = /^[a-p]{32}$/;

/** Chrome's id alphabet over the first 16 bytes of a hash */
export function idFromBytes(bytes: Uint8Array): string {
	let id = '';
	for (const byte of bytes.subarray(0, 16))
		id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
	return id;
}

/** the id of a public key (manifest `key`, a CRX2 key) */
export async function idFromKey(key: Uint8Array): Promise<string> {
	return idFromBytes(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', key as Uint8Array<ArrayBuffer>),
		),
	);
}

/**
 * The id of an extension that carries no key, from a text of its own (its
 * name and file name): stable across reinstalls of the same package, as
 * Chrome's unpacked ids are stable for one path
 */
export async function idFromText(text: string): Promise<string> {
	return idFromKey(new TextEncoder().encode(text));
}

function readVarint(bytes: Uint8Array, at: number): [number, number] {
	let value = 0;
	let shift = 0;
	for (;;) {
		if (at >= bytes.length) throw new Error('truncated crx header');
		const byte = bytes[at++];
		value += (byte & 0x7f) * 2 ** shift;
		if (!(byte & 0x80)) return [value, at];
		shift += 7;
	}
}

/** the first length-delimited field `field` of a protobuf message */
function protobufField(bytes: Uint8Array, field: number): Uint8Array | null {
	let at = 0;
	while (at < bytes.length) {
		const [key, next] = readVarint(bytes, at);
		at = next;
		const type = key & 7;
		const number = Math.floor(key / 8);
		if (type === 2) {
			const [length, start] = readVarint(bytes, at);
			if (number === field) return bytes.subarray(start, start + length);
			at = start + length;
		} else if (type === 0) at = readVarint(bytes, at)[1];
		else if (type === 5) at += 4;
		else if (type === 1) at += 8;
		else return null;
	}
	return null;
}

/** whether the bytes start as a .crx does */
export function isCrx(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 16 &&
		new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC
	);
}

/** split a .crx into its zip and what its header says of the id; a plain .zip passes through */
export function parseCrx(bytes: Uint8Array): CrxParts {
	if (!isCrx(bytes)) return { zip: bytes, crxId: null, publicKey: null };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint32(4, true);
	if (version === 2) {
		const keyLength = view.getUint32(8, true);
		const signatureLength = view.getUint32(12, true);
		return {
			zip: bytes.subarray(16 + keyLength + signatureLength),
			crxId: null,
			publicKey: bytes.subarray(16, 16 + keyLength),
		};
	}
	if (version === 3) {
		const headerLength = view.getUint32(8, true);
		const header = bytes.subarray(12, 12 + headerLength);
		let crxId: string | null = null;
		try {
			// CrxFileHeader.signed_header_data (10000) is a SignedData whose
			// crx_id (1) is the id's 16 bytes
			const signed = protobufField(header, 10000);
			const id = signed && protobufField(signed, 1);
			if (id && id.length === 16) crxId = idFromBytes(id);
		} catch (error) {
			crxId = null;
		}
		return { zip: bytes.subarray(12 + headerLength), crxId, publicKey: null };
	}
	throw new Error(
		`this .crx is version ${version}; STomp reads versions 2 and 3`,
	);
}
