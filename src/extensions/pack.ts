// Chrome's Pack extension (docs/extensions.md "Packing"): an unpacked
// extension's files as a zip (deflated where that is smaller), wrapped as a
// CRX3 signed with an RSA-2048 key over SHA-256, as Chrome's CRXCreator
// writes it. A new key comes back as PKCS#8 PEM, Chrome's .pem; a key given
// in that form signs again, so the package keeps its id.
import { idFromBytes } from './crx';

const CRX_MAGIC = 'Cr24';
const SIGNATURE_CONTEXT = 'CRX3 SignedData\x00';

// ---- the zip ---------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let index = 0; index < bytes.length; index++)
		crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
	if (typeof CompressionStream === 'undefined') return null;
	try {
		const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
			.stream()
			.pipeThrough(new CompressionStream('deflate-raw'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch (error) {
		return null;
	}
}

/** a zip of the files, by their paths (no directories, no ZIP64) */
export async function writeZip(
	files: Record<string, Uint8Array>,
): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	// (an MS-DOS time of 1980-01-01 00:00, so a package of the same files is the same bytes)
	const date = (0 << 9) | (1 << 5) | 1;
	for (const name of Object.keys(files).sort()) {
		const data = files[name];
		const path = encoder.encode(name);
		const crc = crc32(data);
		const packed = await deflate(data);
		const method = packed && packed.length < data.length ? 8 : 0;
		const body = method === 8 ? packed! : data;
		const local = new Uint8Array(30 + path.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, method, true);
		lv.setUint16(10, 0, true);
		lv.setUint16(12, date, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, body.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, path.length, true);
		lv.setUint16(28, 0, true);
		local.set(path, 30);
		const entry = new Uint8Array(46 + path.length);
		const cv = new DataView(entry.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, method, true);
		cv.setUint16(12, 0, true);
		cv.setUint16(14, date, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, body.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, path.length, true);
		cv.setUint32(42, offset, true);
		entry.set(path, 46);
		locals.push(local, body);
		central.push(entry);
		offset += local.length + body.length;
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, central.length, true);
	ev.setUint16(10, central.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	return concat([...locals, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

// ---- the CRX3 --------------------------------------------------------------

function varint(value: number): Uint8Array {
	const out: number[] = [];
	while (value > 0x7f) {
		out.push((value & 0x7f) | 0x80);
		value = Math.floor(value / 128);
	}
	out.push(value);
	return new Uint8Array(out);
}

/** a protobuf length-delimited field */
function field(number: number, bytes: Uint8Array): Uint8Array {
	return concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value, true);
	return out;
}

const base64 = (bytes: Uint8Array) => {
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(text);
};

function pem(der: Uint8Array): string {
	const lines = base64(der).match(/.{1,64}/g) ?? [];
	return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

function fromPem(text: string): Uint8Array {
	const body = text
		.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
		.replace(/\s+/g, '');
	const raw = atob(body);
	const out = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index++)
		out[index] = raw.charCodeAt(index);
	return out;
}

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** the key pair to sign with: the PEM given (PKCS#8), or a new RSA-2048 one */
async function keyPair(given?: string): Promise<{
	privateKey: CryptoKey;
	publicKey: Uint8Array;
	made: string | null;
}> {
	if (given) {
		if (!/-----BEGIN PRIVATE KEY-----/.test(given))
			throw new Error(
				'The private key must be PKCS#8 PEM (-----BEGIN PRIVATE KEY-----), as Chrome writes its .pem.',
			);
		let privateKey: CryptoKey;
		try {
			privateKey = await crypto.subtle.importKey(
				'pkcs8',
				fromPem(given) as Uint8Array<ArrayBuffer>,
				ALGORITHM,
				true,
				['sign'],
			);
		} catch (error) {
			throw new Error('The private key is not an RSA key Chrome could use.', {
				cause: error,
			});
		}
		// the public half, from the private key's own parameters
		const jwk = await crypto.subtle.exportKey('jwk', privateKey);
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true },
			ALGORITHM,
			true,
			['verify'],
		);
		return {
			privateKey,
			publicKey: new Uint8Array(
				await crypto.subtle.exportKey('spki', publicKey),
			),
			made: null,
		};
	}
	const pair = await crypto.subtle.generateKey(
		{
			...ALGORITHM,
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		['sign', 'verify'],
	);
	return {
		privateKey: pair.privateKey,
		publicKey: new Uint8Array(
			await crypto.subtle.exportKey('spki', pair.publicKey),
		),
		made: pem(
			new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
		),
	};
}

/**
 * An unpacked extension's files as a signed CRX3: its bytes, the new key
 * (null when one was given) and the id the key gives
 */
export async function packExtension(
	files: Record<string, Uint8Array>,
	key?: string,
): Promise<{ crx: Uint8Array; key: string | null; id: string }> {
	if (!files['manifest.json'])
		throw new Error('An extension to pack needs a manifest.json at its root.');
	const zip = await writeZip(files);
	const { privateKey, publicKey, made } = await keyPair(key);
	const hash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', publicKey as Uint8Array<ArrayBuffer>),
	);
	const crxId = hash.subarray(0, 16);
	// SignedData { crx_id = 1 }
	const signedData = field(1, crxId);
	const signed = concat([
		new TextEncoder().encode(SIGNATURE_CONTEXT),
		u32(signedData.length),
		signedData,
		zip,
	]);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			ALGORITHM,
			privateKey,
			signed as Uint8Array<ArrayBuffer>,
		),
	);
	// CrxFileHeader { sha256_with_rsa = 2: AsymmetricKeyProof { public_key = 1, signature = 2 }, signed_header_data = 10000 }
	const header = concat([
		field(2, concat([field(1, publicKey), field(2, signature)])),
		field(10000, signedData),
	]);
	const crx = concat([
		new TextEncoder().encode(CRX_MAGIC),
		u32(3),
		u32(header.length),
		header,
		zip,
	]);
	return { crx, key: made, id: idFromBytes(hash) };
}
