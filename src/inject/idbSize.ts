// What an IndexedDB database takes in Chrome's quota, as near as a page can
// tell from its values (StorageEstimate module). Measured in Chrome 152 with
// an on-disk profile: a database counts 592 bytes, an object store 352 more,
// and a record about 210 bytes past its value, which counts its serialized
// size; a value of more than 64 KiB is kept compressed with snappy (a
// megabyte of zeros: 50,929 bytes; of random bytes: 1,050,221). An
// off-the-record profile counts in pages instead, which no estimate here
// follows.

export const DATABASE_BYTES = 592;
export const STORE_BYTES = 352;
export const RECORD_BYTES = 210;
/** values serialized to more than this are compressed */
const COMPRESS_OVER = 64 * 1024;
/** how deep the sizing walks into a value */
const DEPTH = 8;
/** the most bytes of one value read to estimate its compression; the rest is scaled */
const SCAN_BYTES = 4 * 1024 * 1024;

const tagOf = Object.prototype.toString;

/** the bytes of a part of a value: a view of binary data, or a string's code units */
type Bytes = { length: number; at(index: number): number };

/** the size of a varint holding `value` */
function varint(value: number): number {
	let size = 1;
	while (value >= 0x80) {
		value = Math.floor(value / 0x80);
		size++;
	}
	return size;
}

/** a snappy literal of `length` bytes: its tag, its length and the bytes */
function literal(length: number): number {
	if (length <= 0) return 0;
	return (
		length + (length <= 60 ? 1 : length < 0x100 ? 2 : length < 0x10000 ? 3 : 4)
	);
}

/** a snappy copy of `length` bytes from `offset` back */
function copy(offset: number, length: number): number {
	let size = 0;
	while (length >= 68) {
		size += 3;
		length -= 64;
	}
	if (length > 64) {
		size += 3;
		length -= 60;
	}
	return size + (length < 12 && offset < 2048 ? 2 : 3);
}

/**
 * The size snappy compresses `bytes` to, by its algorithm (64 KiB blocks, a
 * 4-byte hash of each position, the skip that speeds through what does not
 * match), without making the output
 */
export function snappySize(bytes: Bytes): number {
	const load = (at: number) =>
		bytes.at(at) |
		(bytes.at(at + 1) << 8) |
		(bytes.at(at + 2) << 16) |
		(bytes.at(at + 3) << 24);
	const hash = (value: number) => Math.imul(value, 0x1e35a7bd) >>> 18;
	let total = varint(bytes.length);
	for (let start = 0; start < bytes.length; start += 0x10000) {
		const end = Math.min(bytes.length, start + 0x10000);
		const length = end - start;
		if (length < 15) {
			total += literal(length);
			continue;
		}
		const table = new Map<number, number>();
		const limit = end - 15;
		let emitted = start;
		let ip = start + 1;
		let next = hash(load(ip));
		outer: for (;;) {
			let skip = 32;
			let nextIp = ip;
			let candidate: number;
			do {
				ip = nextIp;
				const current = next;
				nextIp = ip + (skip++ >> 5);
				if (nextIp > limit) break outer;
				next = hash(load(nextIp));
				candidate = table.get(current) ?? start;
				table.set(current, ip);
			} while (load(ip) !== load(candidate));
			total += literal(ip - emitted);
			for (;;) {
				const base = ip;
				let matched = 4;
				while (
					ip + matched < end &&
					bytes.at(candidate + matched) === bytes.at(ip + matched)
				)
					matched++;
				ip += matched;
				total += copy(base - candidate, matched);
				emitted = ip;
				if (ip >= limit) break outer;
				table.set(hash(load(ip - 1)), ip - 1);
				const current = hash(load(ip));
				candidate = table.get(current) ?? start;
				table.set(current, ip);
				if (load(ip) !== load(candidate)) {
					ip++;
					next = hash(load(ip));
					break;
				}
			}
		}
		total += literal(end - emitted);
	}
	return total;
}

/** a part's compressed size, reading at most SCAN_BYTES of it */
function compressed(bytes: Bytes): number {
	if (bytes.length <= SCAN_BYTES) return snappySize(bytes);
	const head = snappySize({ length: SCAN_BYTES, at: bytes.at });
	return Math.round((head / SCAN_BYTES) * bytes.length);
}

/**
 * A value as V8 serializes it, roughly: its size, and the parts of it that
 * are long runs of bytes (binary data, strings), which compression can
 * shrink. Told apart by their tags: a value read in a frame's realm is of
 * that realm's classes.
 */
function measure(
	value: unknown,
	parts: Bytes[],
	seen: Set<object>,
	depth: number,
): number {
	switch (typeof value) {
		case 'string': {
			let wide = false;
			for (let i = 0; i < value.length && !wide; i++)
				wide = value.charCodeAt(i) > 0xff;
			const length = wide ? value.length * 2 : value.length;
			if (length > 256)
				parts.push({
					length,
					at: wide
						? (index) =>
								(value.charCodeAt(index >> 1) >> ((index & 1) * 8)) & 0xff
						: (index) => value.charCodeAt(index) & 0xff,
				});
			return 1 + varint(length) + length;
		}
		case 'number':
			return Number.isInteger(value) && Math.abs(value) < 2 ** 30
				? 1 + varint(Math.abs(value) * 2)
				: 9;
		case 'bigint':
			return 10;
		case 'boolean':
		case 'undefined':
			return 1;
		case 'object':
			break;
		default:
			return 0;
	}
	if (value === null) return 1;
	if (seen.has(value) || depth > DEPTH) return 2;
	seen.add(value);
	const tag = Reflect.apply(tagOf, value, []) as string;
	if (ArrayBuffer.isView(value)) {
		const view = new Uint8Array(
			value.buffer as ArrayBuffer,
			value.byteOffset,
			value.byteLength,
		);
		if (view.length > 256)
			parts.push({ length: view.length, at: (index) => view[index] ?? 0 });
		return view.length + 8;
	}
	if (tag === '[object ArrayBuffer]') {
		const view = new Uint8Array(value as ArrayBuffer);
		if (view.length > 256)
			parts.push({ length: view.length, at: (index) => view[index] ?? 0 });
		return view.length + 4;
	}
	if (tag === '[object Blob]' || tag === '[object File]')
		return (value as Blob).size + 32;
	let size = 3;
	if (tag === '[object Map]')
		for (const [key, entry] of value as Map<unknown, unknown>)
			size +=
				measure(key, parts, seen, depth + 1) +
				measure(entry, parts, seen, depth + 1);
	else if (tag === '[object Set]')
		for (const entry of value as Set<unknown>)
			size += measure(entry, parts, seen, depth + 1);
	else
		for (const key of Object.keys(value))
			size +=
				measure(key, parts, seen, depth + 1) +
				measure(
					(value as Record<string, unknown>)[key],
					parts,
					seen,
					depth + 1,
				);
	return size;
}

/** what one record takes: its overhead, its key, and its value, compressed when large */
export function recordSize(key: unknown, value: unknown): number {
	const parts: Bytes[] = [];
	const serialized = measure(value, parts, new Set(), 0);
	let size = serialized;
	if (serialized > COMPRESS_OVER) {
		let raw = 0;
		let packed = 0;
		for (const part of parts) {
			raw += part.length;
			packed += compressed(part);
		}
		size = serialized - raw + packed;
	}
	return RECORD_BYTES + measure(key, [], new Set(), 0) + size;
}
