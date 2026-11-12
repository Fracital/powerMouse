// MD5 (RFC 1321), for the one place the web still asks for it: a TURN
// server's long-term credential key is MD5(username ":" realm ":" password)
// (RFC 8489, section 9.2.2), and WebCrypto has no MD5.

const SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
	9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
	16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
	21,
];
const SINES = new Uint32Array(64);
for (let i = 0; i < 64; i++)
	SINES[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

export function md5(input: Uint8Array): Uint8Array {
	const length = input.length;
	const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
	padded.set(input);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, (length << 3) >>> 0, true);
	view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const words = new Uint32Array(16);
	for (let at = 0; at < padded.length; at += 64) {
		for (let i = 0; i < 16; i++) words[i] = view.getUint32(at + i * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) & 15;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) & 15;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) & 15;
			}
			const sum = (a + f + SINES[i] + words[g]) >>> 0;
			a = d;
			d = c;
			c = b;
			b = (b + ((sum << SHIFTS[i]) | (sum >>> (32 - SHIFTS[i])))) >>> 0;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	const out = new Uint8Array(16);
	const result = new DataView(out.buffer);
	result.setUint32(0, a0, true);
	result.setUint32(4, b0, true);
	result.setUint32(8, c0, true);
	result.setUint32(12, d0, true);
	return out;
}
