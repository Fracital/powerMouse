/**
 * The order in which Blink's HTTPHeaderMap hands a subresource's fields to
 * the network stack: it is a WTF HashMap keyed by case-folded name, and it
 * iterates in bucket order, so the fields come out in the order of their
 * hashes, not in the order they were set. With only the three default
 * client hints that order looks fixed (sec-ch-ua-platform, User-Agent,
 * sec-ch-ua, sec-ch-ua-mobile); a site that asks for more hints sees them
 * interleaved with User-Agent, and a fingerprint of the field order (JA4H)
 * sees exactly where.
 *
 * Reproduced from Chromium's sources and checked against Chrome 152's
 * requests (headerOrder.ts, client-hints suites): the hash is rapidhash
 * over the name's UTF-16 code units, lowered, kept to 24 bits
 * (wtf/text/string_hasher.h, case_folding_hash.h); the table starts at 8
 * buckets, doubles when half full and rehashes in bucket order, and probes
 * by triangular steps (wtf/hash_table.h).
 */

const MASK64 = (1n << 64n) - 1n;
const SEED = 0xbdd89aa982704029n;
const SECRET = [0x2d358dccaa6c78a5n, 0x8bb84b93962eacc9n, 0x4b33a62ed433d4a3n];

function multiply(a: bigint, b: bigint): [bigint, bigint] {
	const product = a * b;
	return [product & MASK64, product >> 64n];
}

function mix(a: bigint, b: bigint): bigint {
	const [low, high] = multiply(a, b);
	return low ^ high;
}

function read(bytes: number[], offset: number, length: number): bigint {
	let value = 0n;
	for (let i = length - 1; i >= 0; i--)
		value = (value << 8n) | BigInt(bytes[offset + i]);
	return value;
}

/** rapidhash (third_party/rapidhash/rapidhash.h) of `bytes` */
function rapidhash(bytes: number[]): bigint {
	const length = bytes.length;
	const len = BigInt(length);
	let seed = SEED;
	seed ^= mix(seed ^ SECRET[0], SECRET[1]) ^ len;
	let a: bigint;
	let b: bigint;
	if (length <= 16) {
		if (length >= 4) {
			const last = length - 4;
			a = (read(bytes, 0, 4) << 32n) | read(bytes, last, 4);
			const delta = (length & 24) >> (length >> 3);
			b = (read(bytes, delta, 4) << 32n) | read(bytes, last - delta, 4);
		} else if (length > 0) {
			a =
				(BigInt(bytes[0]) << 56n) |
				(BigInt(bytes[length >> 1]) << 32n) |
				BigInt(bytes[length - 1]);
			b = 0n;
		} else a = b = 0n;
	} else {
		let left = length;
		let p = 0;
		if (left > 48) {
			let see1 = seed;
			let see2 = seed;
			do {
				seed = mix(read(bytes, p, 8) ^ SECRET[0], read(bytes, p + 8, 8) ^ seed);
				see1 = mix(
					read(bytes, p + 16, 8) ^ SECRET[1],
					read(bytes, p + 24, 8) ^ see1,
				);
				see2 = mix(
					read(bytes, p + 32, 8) ^ SECRET[2],
					read(bytes, p + 40, 8) ^ see2,
				);
				p += 48;
				left -= 48;
			} while (left >= 48);
			seed ^= see1 ^ see2;
		}
		if (left > 16) {
			seed = mix(
				read(bytes, p, 8) ^ SECRET[2],
				read(bytes, p + 8, 8) ^ seed ^ SECRET[1],
			);
			if (left > 32)
				seed = mix(
					read(bytes, p + 16, 8) ^ SECRET[2],
					read(bytes, p + 24, 8) ^ seed,
				);
		}
		a = read(bytes, p + left - 16, 8);
		b = read(bytes, p + left - 8, 8);
	}
	a ^= SECRET[1];
	b ^= seed;
	[a, b] = multiply(a, b);
	return mix(a ^ SECRET[0] ^ len, b ^ SECRET[1]);
}

const hashes = new Map<string, number>();

/** DeprecatedCaseFoldingHash of a field name (ASCII), as WTF keeps it */
export function blinkHeaderHash(name: string): number {
	const lower = name.toLowerCase();
	let hash = hashes.get(lower);
	if (hash !== undefined) return hash;
	// the case-folding reader always hashes UTF-16 code units
	const bytes: number[] = [];
	for (let i = 0; i < lower.length; i++) {
		const unit = lower.charCodeAt(i);
		bytes.push(unit & 0xff, unit >> 8);
	}
	// a single code unit is read differently (ReadSmall folds one unit)
	const result =
		lower.length === 1
			? rapidhashSmall(lower.charCodeAt(0))
			: Number(rapidhash(bytes) & 0xffffffn);
	hash = result || 0x800000;
	hashes.set(lower, hash);
	return hash;
}

function rapidhashSmall(unit: number): number {
	// rapidhash with len 2 whose ReadSmall returns the folded unit itself
	let seed = SEED;
	seed ^= mix(seed ^ SECRET[0], SECRET[1]) ^ 2n;
	let a = BigInt(unit) ^ SECRET[1];
	let b = seed;
	[a, b] = multiply(a, b);
	return Number(mix(a ^ SECRET[0] ^ 2n, b ^ SECRET[1]) & 0xffffffn);
}

/** the names as a Blink HTTPHeaderMap that had them set in this order iterates them */
export function blinkHeaderMapOrder(names: string[]): string[] {
	let table: (string | undefined)[] = [];
	let count = 0;
	const insert = (into: (string | undefined)[], name: string) => {
		const mask = into.length - 1;
		let i = blinkHeaderHash(name) & mask;
		let probe = 0;
		while (into[i] !== undefined) {
			probe++;
			i = (i + probe) & mask;
		}
		into[i] = name;
	};
	for (const name of names) {
		if (!table.length) table = new Array(8);
		insert(table, name);
		count++;
		if (count * 2 >= table.length) {
			const old = table;
			table = new Array(old.length * 2);
			for (const kept of old) if (kept !== undefined) insert(table, kept);
		}
	}
	return table.filter((name): name is string => name !== undefined);
}
