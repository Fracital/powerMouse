// SHA-256, SHA-384 and SHA-512 of a string's UTF-8 bytes, synchronously,
// as base64: what a policy's hash source names an inline script or style
// by (src/csp.ts). The page's inline code is rewritten, so the browser's
// own hash of it is not the page's; the inject compares the page's text
// while it decides (crypto.subtle answers only later, after the element
// has run or not).

/**
 * The round constants, made at the first digest: the first 64 fractional
 * bits of the cube roots of the first 80 primes (SHA-256 takes the high 32
 * of the first 64), exact by bisection
 */
let K512: Uint32Array | null = null;
function constants(): Uint32Array {
	if (K512) return K512;
	const made = new Uint32Array(160);
	const primes: number[] = [];
	for (let n = 2; primes.length < 80; n++)
		if (primes.every((p) => n % p)) primes.push(n);
	primes.forEach((prime, i) => {
		const target = BigInt(prime) << 192n;
		let lo = BigInt(Math.floor(Math.cbrt(prime))) << 64n;
		let hi = lo + (1n << 64n);
		while (hi - lo > 1n) {
			const mid = (lo + hi) >> 1n;
			if (mid * mid * mid <= target) lo = mid;
			else hi = mid;
		}
		made[i * 2] = Number((lo >> 32n) & 0xffffffffn);
		made[i * 2 + 1] = Number(lo & 0xffffffffn);
	});
	return (K512 = made);
}

const encoder = new TextEncoder();

function padded(bytes: Uint8Array, block: number): DataView {
	const lengthBytes = block === 64 ? 8 : 16;
	const total = Math.ceil((bytes.length + 1 + lengthBytes) / block) * block;
	const buffer = new Uint8Array(total);
	buffer.set(bytes);
	buffer[bytes.length] = 0x80;
	const view = new DataView(buffer.buffer);
	const bits = bytes.length * 8;
	view.setUint32(total - 4, bits >>> 0);
	view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
	return view;
}

function base64(words: Uint32Array, count: number): string {
	let binary = '';
	for (let i = 0; i < count; i++)
		for (let shift = 24; shift >= 0; shift -= 8)
			binary += String.fromCharCode((words[i] >>> shift) & 0xff);
	return btoa(binary);
}

function sha256(bytes: Uint8Array): string {
	const h = Uint32Array.of(
		0x6a09e667,
		0xbb67ae85,
		0x3c6ef372,
		0xa54ff53a,
		0x510e527f,
		0x9b05688c,
		0x1f83d9ab,
		0x5be0cd19,
	);
	const view = padded(bytes, 64);
	const k512 = constants();
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let offset = 0; offset < view.byteLength; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15];
			const b = w[i - 2];
			w[i] =
				(rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) +
				w[i - 7] +
				(rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
				w[i - 16];
		}
		let [a, b, c, d, e, f, g, k] = h;
		for (let i = 0; i < 64; i++) {
			const t1 =
				(k +
					(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
					((e & f) ^ (~e & g)) +
					k512[i * 2] +
					w[i]) >>>
				0;
			const t2 =
				((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
					((a & b) ^ (a & c) ^ (b & c))) >>>
				0;
			k = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		[a, b, c, d, e, f, g, k].forEach((value, i) => (h[i] = h[i] + value));
	}
	return base64(h, 8);
}

/** SHA-512 (or SHA-384, `short`) over 32-bit halves: [high, low] pairs */
function sha512(bytes: Uint8Array, short: boolean): string {
	const h = Uint32Array.from(
		short
			? [
					0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a,
					0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31,
					0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d,
					0xbefa4fa4,
				]
			: [
					0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372,
					0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1,
					0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19,
					0x137e2179,
				],
	);
	const view = padded(bytes, 128);
	const k512 = constants();
	const w = new Uint32Array(160);
	// 64-bit arithmetic on [high, low] pairs
	const add = (...pairs: [number, number][]): [number, number] => {
		let high = 0;
		let low = 0;
		for (const [h1, l1] of pairs) {
			low += l1 >>> 0;
			high += (h1 >>> 0) + Math.floor(low / 2 ** 32);
			low >>>= 0;
		}
		return [high >>> 0, low >>> 0];
	};
	const rotr = ([high, low]: [number, number], n: number): [number, number] =>
		n < 32
			? [(high >>> n) | (low << (32 - n)), (low >>> n) | (high << (32 - n))]
			: [
					(low >>> (n - 32)) | (high << (64 - n)),
					(high >>> (n - 32)) | (low << (64 - n)),
				];
	const shr = ([high, low]: [number, number], n: number): [number, number] => [
		high >>> n,
		(low >>> n) | (high << (32 - n)),
	];
	const xor = (...pairs: [number, number][]): [number, number] =>
		pairs.reduce(([h1, l1], [h2, l2]) => [h1 ^ h2, l1 ^ l2], [0, 0]);
	const at = (array: Uint32Array, i: number): [number, number] => [
		array[i * 2],
		array[i * 2 + 1],
	];
	for (let offset = 0; offset < view.byteLength; offset += 128) {
		for (let i = 0; i < 32; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 80; i++) {
			const a = at(w, i - 15);
			const b = at(w, i - 2);
			const [high, low] = add(
				xor(rotr(b, 19), rotr(b, 61), shr(b, 6)),
				at(w, i - 7),
				xor(rotr(a, 1), rotr(a, 8), shr(a, 7)),
				at(w, i - 16),
			);
			w[i * 2] = high;
			w[i * 2 + 1] = low;
		}
		const v = Array.from({ length: 8 }, (_, i) => at(h, i));
		for (let i = 0; i < 80; i++) {
			const [a, b, c, d, e, f, g, k] = v;
			const t1 = add(
				k,
				xor(rotr(e, 14), rotr(e, 18), rotr(e, 41)),
				xor([e[0] & f[0], e[1] & f[1]], [~e[0] & g[0], ~e[1] & g[1]]),
				at(k512, i),
				at(w, i),
			);
			const t2 = add(
				xor(rotr(a, 28), rotr(a, 34), rotr(a, 39)),
				xor(
					[a[0] & b[0], a[1] & b[1]],
					[a[0] & c[0], a[1] & c[1]],
					[b[0] & c[0], b[1] & c[1]],
				),
			);
			v.splice(0, 8, add(t1, t2), a, b, c, add(d, t1), e, f, g);
		}
		v.forEach((pair, i) => {
			const [high, low] = add(at(h, i), pair);
			h[i * 2] = high;
			h[i * 2 + 1] = low;
		});
	}
	return base64(h, short ? 12 : 16);
}

/** the base64 digest of `text`'s UTF-8 bytes by `algorithm` (sha256, sha384, sha512) */
export function digest(
	algorithm: 'sha256' | 'sha384' | 'sha512',
	text: string,
): string {
	const bytes = encoder.encode(text);
	return algorithm === 'sha256'
		? sha256(bytes)
		: sha512(bytes, algorithm === 'sha384');
}
