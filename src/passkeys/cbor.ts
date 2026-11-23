// CBOR as CTAP2 writes it (the "CTAP2 canonical CBOR encoding form"):
// definite lengths, the shortest form of every integer, and a map's keys
// sorted by their encoded length and then bytewise. Only what an
// authenticator's output needs: integers, booleans, byte strings, text
// strings, arrays and maps.

export type CBORValue =
	| number
	| boolean
	| string
	| Uint8Array
	| CBORValue[]
	| Map<number | string, CBORValue>;

function head(major: number, value: number): number[] {
	const type = major << 5;
	if (value < 24) return [type | value];
	if (value < 0x100) return [type | 24, value];
	if (value < 0x10000) return [type | 25, value >> 8, value & 0xff];
	return [
		type | 26,
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	];
}

function compare(a: Uint8Array, b: Uint8Array): number {
	if (a.length !== b.length) return a.length - b.length;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

export function concat(parts: ArrayLike<number>[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function encodeCBOR(value: CBORValue): Uint8Array {
	// the simple values true and false (major type 7)
	if (typeof value === 'boolean') return new Uint8Array([value ? 0xf5 : 0xf4]);
	if (typeof value === 'number')
		return new Uint8Array(value < 0 ? head(1, -1 - value) : head(0, value));
	if (typeof value === 'string') {
		const text = new TextEncoder().encode(value);
		return concat([head(3, text.length), text]);
	}
	if (value instanceof Uint8Array)
		return concat([head(2, value.length), value]);
	if (value instanceof Map) {
		const entries: [Uint8Array, Uint8Array][] = [];
		for (const [key, item] of value)
			entries.push([encodeCBOR(key), encodeCBOR(item)]);
		entries.sort((a, b) => compare(a[0], b[0]));
		return concat([head(5, entries.length), ...entries.flat()]);
	}
	return concat([head(4, value.length), ...value.map(encodeCBOR)]);
}
