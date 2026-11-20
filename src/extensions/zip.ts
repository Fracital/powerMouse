// A ZIP reader for extension packages, with the browser's
// DecompressionStream for deflate: no ZIP64, no encryption, which is what
// extensions use. Ported from STicks (src/zip.ts).
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ZipEntry {
	name: string;
	/** 0 stored, 8 deflate */
	method: number;
	/** the stored bytes' size, and the file's own */
	compressedSize: number;
	size: number;
	/** where the stored bytes start in the archive */
	dataOffset(): number;
	read(): Promise<Uint8Array>;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** the files of a ZIP archive (directories left out) */
export function readZip(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (
		let at = bytes.length - 22;
		at >= Math.max(0, bytes.length - 22 - 0xffff);
		at--
	)
		if (view.getUint32(at, true) === EOCD) {
			end = at;
			break;
		}
	if (end < 0) throw new Error('it is not a zip archive');
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const decoder = new TextDecoder();
	const entries: ZipEntry[] = [];
	for (let index = 0; index < count; index++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL)
			throw new Error('its zip central directory is corrupt');
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const compressedSize = view.getUint32(at + 20, true);
		const size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extraLength + commentLength;
		if (name.endsWith('/')) continue;
		if (flags & 1) throw new Error(`${name} is encrypted`);
		if (compressedSize === 0xffffffff || size === 0xffffffff)
			throw new Error('ZIP64 archives are not supported');
		if (method !== 0 && method !== 8)
			throw new Error(`${name} uses unsupported compression ${method}`);
		const dataOffset = () => {
			if (view.getUint32(local, true) !== LOCAL)
				throw new Error(`its zip entry ${name} is corrupt`);
			return (
				local +
				30 +
				view.getUint16(local + 26, true) +
				view.getUint16(local + 28, true)
			);
		};
		entries.push({
			name,
			method,
			compressedSize,
			size,
			dataOffset,
			read: async () => {
				const start = dataOffset();
				const data = bytes.subarray(start, start + compressedSize);
				return method === 0 ? data.slice() : inflate(data);
			},
		});
	}
	return entries;
}
