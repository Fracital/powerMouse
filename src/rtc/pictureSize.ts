/**
 * The picture size a received keyframe states, as Chrome's depacketizers
 * read it for a receiver's encoded transform (`getMetadata()`'s width and
 * height; 0 for a delta frame, and for AV1, whose depacketizer reads no
 * size): VP8's keyframe header, VP9's uncompressed header, H.264's
 * sequence parameter set (cropped). Null where the bytes say no size.
 */
export function pictureSize(
	codec: string,
	bytes: Uint8Array,
): [number, number] | null {
	try {
		if (codec === 'VP8') return vp8(bytes);
		if (codec === 'VP9') return vp9(bytes);
		if (codec === 'H264') return h264(bytes);
	} catch (error) {
		// a header cut short
	}
	return null;
}

function vp8(bytes: Uint8Array): [number, number] | null {
	// a keyframe: bit 0 clear, then the start code 9d 01 2a
	if (bytes.length < 10 || bytes[0] & 1) return null;
	if (bytes[3] !== 0x9d || bytes[4] !== 0x01 || bytes[5] !== 0x2a) return null;
	return [
		(bytes[6] | (bytes[7] << 8)) & 0x3fff,
		(bytes[8] | (bytes[9] << 8)) & 0x3fff,
	];
}

/** reads bits, most significant first; past the end throws */
class Bits {
	#bytes: Uint8Array;
	#at = 0;
	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}
	bit() {
		const byte = this.#bytes[this.#at >> 3];
		if (byte === undefined) throw new RangeError('short');
		return (byte >> (7 - (this.#at++ & 7))) & 1;
	}
	bits(n: number) {
		let value = 0;
		for (let i = 0; i < n; i++) value = value * 2 + this.bit();
		return value;
	}
	/** an Exp-Golomb number, unsigned */
	ue() {
		let zeros = 0;
		while (!this.bit()) if (++zeros > 31) throw new RangeError('long');
		return 2 ** zeros - 1 + this.bits(zeros);
	}
	se() {
		const value = this.ue();
		return value & 1 ? (value + 1) / 2 : -value / 2;
	}
}

function vp9(bytes: Uint8Array): [number, number] | null {
	const bits = new Bits(bytes);
	if (bits.bits(2) !== 2) return null;
	const profile = bits.bit() | (bits.bit() << 1);
	if (profile === 3) bits.bit();
	// a frame shown again, or not a keyframe
	if (bits.bit() || bits.bit()) return null;
	bits.bits(2);
	if (bits.bits(24) !== 0x498342) return null;
	if (profile >= 2) bits.bit();
	// color space: not RGB has a range bit
	if (bits.bits(3) !== 7) {
		bits.bit();
		if (profile === 1 || profile === 3) bits.bits(3);
	} else if (profile === 1 || profile === 3) bits.bit();
	return [bits.bits(16) + 1, bits.bits(16) + 1];
}

/** an SPS's bytes after its NAL header, emulation prevention removed */
function unescape(bytes: Uint8Array) {
	const out: number[] = [];
	let zeros = 0;
	for (const byte of bytes) {
		if (zeros >= 2 && byte === 3) {
			zeros = 0;
			continue;
		}
		zeros = byte === 0 ? zeros + 1 : 0;
		out.push(byte);
	}
	return new Uint8Array(out);
}

function h264(bytes: Uint8Array): [number, number] | null {
	// Annex B: the first SPS (NAL type 7), up to the next start code
	for (let i = 0; i + 3 < bytes.length; i++) {
		if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
		if ((bytes[i + 3] & 0x1f) !== 7) continue;
		let end = i + 4;
		while (
			end < bytes.length &&
			!(bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] <= 1)
		)
			end++;
		return sps(unescape(bytes.subarray(i + 4, end)));
	}
	return null;
}

function sps(bytes: Uint8Array): [number, number] {
	const bits = new Bits(bytes);
	const profile = bits.bits(8);
	bits.bits(16);
	bits.ue();
	let chroma = 1;
	let separate = 0;
	if (
		[100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
			profile,
		)
	) {
		chroma = bits.ue();
		if (chroma === 3) separate = bits.bit();
		bits.ue();
		bits.ue();
		bits.bit();
		if (bits.bit())
			for (let list = 0; list < (chroma === 3 ? 12 : 8); list++) {
				if (!bits.bit()) continue;
				let last = 8;
				let next = 8;
				for (let j = 0; j < (list < 6 ? 16 : 64); j++) {
					if (next) next = (last + bits.se() + 256) % 256;
					if (next) last = next;
				}
			}
	}
	bits.ue();
	const order = bits.ue();
	if (order === 0) bits.ue();
	else if (order === 1) {
		bits.bit();
		bits.se();
		bits.se();
		const cycle = bits.ue();
		for (let j = 0; j < cycle; j++) bits.se();
	}
	bits.ue();
	bits.bit();
	const widthMbs = bits.ue() + 1;
	const heightUnits = bits.ue() + 1;
	const frameMbsOnly = bits.bit();
	if (!frameMbsOnly) bits.bit();
	bits.bit();
	let width = widthMbs * 16;
	let height = (2 - frameMbsOnly) * heightUnits * 16;
	if (bits.bit()) {
		const left = bits.ue();
		const right = bits.ue();
		const top = bits.ue();
		const bottom = bits.ue();
		const type = separate ? 0 : chroma;
		const cropX = type === 1 || type === 2 ? 2 : 1;
		const cropY = (type === 1 ? 2 : 1) * (2 - frameMbsOnly);
		width -= (left + right) * cropX;
		height -= (top + bottom) * cropY;
	}
	return [width, height];
}
