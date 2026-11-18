//! Opus in-band FEC on receive (docs/webrtc-over-wisp.md, section 16). A
//! sender with `useinbandfec=1` that hears of loss puts a second, coarser
//! copy of each SILK frame (LBRR, RFC 6716 4.2.4) into the next packet.
//! Chrome's NetEq decodes that copy when a packet is lost; WebCodecs has no
//! way to ask libopus for it, so the copy is rewritten here as a packet of
//! its own: an LBRR frame is coded with the syntax of a first frame coded
//! independently (with the signal type table of a voiced frame), so its
//! symbols are read with their iCDFs and written again with the same ones
//! after a header that says "voice, no LBRR". libopus decodes the result as
//! it decodes the copy (measured: the same output as libopus's
//! `decode_fec` and as Chrome's FEC, for SILK and hybrid streams).
//! Mono, 20 ms frames: what Chrome sends. Anything else is left to the
//! concealment. The host asks for it with the `l` export, after a page's
//! encoded transform has had the packet.

/// EC_CODE_TOP and EC_CODE_BOT of libopus's range coder (celt/mfrngcod.h)
const TOP: u64 = 1 << 31;
const BOTTOM: u64 = 1 << 23;

/// libopus's range decoder (celt/entdec.c), as far as SILK reads it
struct Decoder<'a> {
	bytes: &'a [u8],
	at: usize,
	range: u64,
	rest: u64,
	value: u64,
}

impl<'a> Decoder<'a> {
	fn new(bytes: &'a [u8], at: usize) -> Self {
		let mut decoder = Decoder { bytes, at, range: 128, rest: 0, value: 0 };
		decoder.rest = decoder.byte();
		decoder.value = decoder.range - 1 - (decoder.rest >> 1);
		decoder.normalize();
		decoder
	}

	/// past the end it reads zeros, as libopus does
	fn byte(&mut self) -> u64 {
		let byte = self.bytes.get(self.at).copied().unwrap_or(0);
		self.at += 1;
		byte as u64
	}

	fn normalize(&mut self) {
		while self.range <= BOTTOM {
			self.range <<= 8;
			let last = self.rest;
			self.rest = self.byte();
			let symbol = ((last << 8) | self.rest) >> 1;
			self.value = ((self.value << 8) + (255 & !symbol)) & (TOP - 1);
		}
	}

	fn bit(&mut self, logp: u32) -> bool {
		let share = self.range >> logp;
		let one = self.value < share;
		if !one {
			self.value -= share;
		}
		self.range = if one { share } else { self.range - share };
		self.normalize();
		one
	}

	fn icdf(&mut self, table: &[u8]) -> usize {
		let step = self.range >> 8;
		let mut symbol = 0;
		let mut top;
		let mut low = self.range;
		loop {
			top = low;
			low = step * table.get(symbol).copied().unwrap_or(0) as u64;
			if self.value >= low {
				break;
			}
			symbol += 1;
		}
		self.value -= low;
		self.range = top - low;
		self.normalize();
		symbol
	}
}

/// libopus's range encoder (celt/entenc.c), as far as SILK writes it
struct Encoder {
	range: u64,
	low: u64,
	rest: i32,
	extra: usize,
	out: Vec<u8>,
}

impl Encoder {
	fn carry(&mut self, value: u64) {
		if value == 255 {
			self.extra += 1;
			return;
		}
		let carry = (value >> 8) as i32;
		if self.rest >= 0 {
			self.out.push(((self.rest + carry) & 255) as u8);
		}
		for _ in 0..self.extra {
			self.out.push(((255 + carry) & 255) as u8);
		}
		self.extra = 0;
		self.rest = (value & 255) as i32;
	}

	fn normalize(&mut self) {
		while self.range <= BOTTOM {
			self.carry(self.low >> 23);
			self.low = (self.low & (BOTTOM - 1)) << 8;
			self.range <<= 8;
		}
	}

	fn bit(&mut self, value: bool, logp: u32) {
		let share = self.range >> logp;
		let rest = self.range - share;
		if value {
			self.low += rest;
		}
		self.range = if value { share } else { rest };
		self.normalize();
	}

	fn icdf(&mut self, symbol: usize, table: &[u8]) {
		let step = self.range >> 8;
		if symbol > 0 {
			self.low += self.range - step * table[symbol - 1] as u64;
			self.range = step * (table[symbol - 1] - table[symbol]) as u64;
		} else {
			self.range -= step * table[symbol] as u64;
		}
		self.normalize();
	}

	/// the bytes, with the fewest bits that still decode to the same symbols
	fn done(mut self) -> Vec<u8> {
		let mut bits = (self.range as u32).leading_zeros();
		let mut mask = (TOP - 1) >> bits;
		let mut end = (self.low + mask) / (mask + 1) * (mask + 1);
		if end + mask >= self.low + self.range {
			bits += 1;
			mask >>= 1;
			end = (self.low + mask) / (mask + 1) * (mask + 1);
		}
		let mut left = bits as i32;
		while left > 0 {
			self.carry(end >> 23);
			end = (end & (BOTTOM - 1)) << 8;
			left -= 8;
		}
		if self.rest >= 0 || self.extra > 0 {
			self.carry(0);
		}
		// the decoder reads zeros past the end: trailing ones are left out
		let mut length = self.out.len();
		while length > 1 && self.out[length - 1] == 0 {
			length -= 1;
		}
		self.out.truncate(length);
		self.out
	}
}

/// a symbol read: the distribution it was read with, and its value
type Symbol = (&'static [u8], usize);

/// the sign distributions, one a pulse count (`SIGN`), each of two entries
static SIGNS: [[u8; 2]; 42] = {
	let mut out = [[0u8; 2]; 42];
	let mut at = 0;
	while at < 42 {
		out[at][0] = SIGN[at];
		at += 1;
	}
	out
};

/// The symbols of one SILK frame coded independently (silk/decode_indices.c,
/// silk/decode_pulses.c, silk/shell_coder.c, silk/decode_signs.c), at `rate`
/// kHz, 20 ms long
fn read_frame(decoder: &mut Decoder, rate: u32) -> Vec<Symbol> {
	let mut read: Vec<Symbol> = Vec::new();
	let mut take = |decoder: &mut Decoder, table: &'static [u8]| {
		let value = decoder.icdf(table);
		read.push((table, value));
		value
	};
	let kind = take(decoder, &TYPE_OFFSET) + 2;
	let signal = kind >> 1;
	let quant = kind & 1;
	take(decoder, &GAIN[signal * 8..]);
	take(decoder, &UNIFORM8);
	for _ in 1..4 {
		take(decoder, &DELTA_GAIN);
	}
	let wide = rate == 16;
	let order = if wide { 16 } else { 10 };
	let select: &[u8] = if wide { &SELECT_WIDE } else { &SELECT_NARROW };
	let second: &'static [u8] = if wide { &CB2_WIDE } else { &CB2_NARROW };
	let first = take(decoder, if wide { &CB1_WIDE[(signal >> 1) * 32..] } else { &CB1_NARROW[(signal >> 1) * 32..] });
	for at in (0..order).step_by(2) {
		let entry = select[first * order / 2 + at / 2] as usize;
		for offset in [((entry >> 1) & 7) * 9, ((entry >> 5) & 7) * 9] {
			let value = take(decoder, &second[offset..]);
			if value == 0 || value == 8 {
				take(decoder, &NLSF_EXT);
			}
		}
	}
	take(decoder, &INTERPOLATION);
	if signal == 2 {
		take(decoder, &PITCH_LAG);
		take(decoder, if rate == 8 { &UNIFORM4 } else if rate == 12 { &UNIFORM6 } else { &UNIFORM8 });
		take(decoder, if rate == 8 { &CONTOUR_NARROW } else { &CONTOUR });
		let periodicity = take(decoder, &LTP_PERIODICITY);
		let gains: &'static [u8] = match periodicity {
			0 => &LTP_GAIN0,
			1 => &LTP_GAIN1,
			_ => &LTP_GAIN2,
		};
		for _ in 0..4 {
			take(decoder, gains);
		}
		take(decoder, &LTP_SCALE);
	}
	take(decoder, &UNIFORM4);
	// the excitation: pulse counts per block of 16, their split, the low
	// bits and the signs
	let blocks = (20 * rate as usize) >> 4;
	let level = take(decoder, &RATE_LEVELS[(signal >> 1) * 9..]);
	let mut sums = vec![0usize; blocks];
	let mut shifts = vec![0usize; blocks];
	for block in 0..blocks {
		sums[block] = take(decoder, &PULSES_PER_BLOCK[level * 18..]);
		while sums[block] == 17 {
			shifts[block] += 1;
			let at = 9 * 18 + if shifts[block] == 10 { 1 } else { 0 };
			sums[block] = take(decoder, &PULSES_PER_BLOCK[at..]);
		}
	}
	let shells: [&'static [u8]; 4] = [&SHELL0, &SHELL1, &SHELL2, &SHELL3];
	let mut pulses = vec![0usize; blocks * 16];
	for block in 0..blocks {
		if sums[block] == 0 {
			continue;
		}
		// silk_shell_decoder: halves of 16, 8, 4 and 2, depth first
		let mut out = Vec::with_capacity(16);
		let mut stack = vec![(sums[block], 3usize)];
		while let Some((count, table)) = stack.pop() {
			let (left, right) = if count == 0 {
				(0, 0)
			} else {
				let left = take(decoder, &shells[table][SHELL_OFFSETS[count] as usize..]);
				(left, count - left)
			};
			if table == 0 {
				out.push(left);
				out.push(right);
			} else {
				stack.push((right, table - 1));
				stack.push((left, table - 1));
			}
		}
		pulses[block * 16..block * 16 + 16].copy_from_slice(&out);
	}
	for block in 0..blocks {
		if shifts[block] == 0 {
			continue;
		}
		for at in block * 16..block * 16 + 16 {
			for _ in 0..shifts[block] {
				pulses[at] = pulses[at] * 2 + take(decoder, &LSB);
			}
		}
		sums[block] |= shifts[block] << 5;
	}
	let signs = 7 * (quant + 2 * signal);
	for block in 0..blocks {
		if sums[block] == 0 {
			continue;
		}
		let table = &SIGNS[signs + (sums[block] & 31).min(6)];
		for at in block * 16..block * 16 + 16 {
			if pulses[at] > 0 {
				take(decoder, table);
			}
		}
	}
	read
}

/// The SILK rate in kHz of a mono 20 ms packet of one frame, SILK-only or
/// hybrid (RFC 6716, 3.1), and the first byte its copy goes out with: a
/// hybrid packet's SILK layer is wideband, so its copy is a wideband
/// SILK-only packet
fn layout(toc: u8) -> Option<(u32, u8)> {
	// stereo, or more than one frame
	if toc & 7 != 0 {
		return None;
	}
	let config = toc >> 3;
	if config < 12 {
		return if config & 3 == 1 { Some(([8, 12, 16][(config >> 2) as usize], toc)) } else { None };
	}
	if config < 16 && config & 1 == 1 {
		return Some((16, 9 << 3));
	}
	None
}

/// The LBRR copy a packet carries of the packet before it, as an Opus
/// packet of its own, or None when it carries none (or is not mono 20 ms
/// SILK or hybrid)
pub fn repack(packet: &[u8]) -> Option<Vec<u8>> {
	if packet.len() < 2 {
		return None;
	}
	let (rate, toc) = layout(packet[0])?;
	let mut decoder = Decoder::new(packet, 1);
	// the frame's VAD flag, then its LBRR flag
	decoder.bit(1);
	if !decoder.bit(1) {
		return None;
	}
	let symbols = read_frame(&mut decoder, rate);
	let mut encoder = Encoder { range: TOP, low: 0, rest: -1, extra: 0, out: Vec::new() };
	// a voiced frame with no copy of its own
	encoder.bit(true, 1);
	encoder.bit(false, 1);
	for (table, value) in symbols {
		encoder.icdf(value, table);
	}
	let mut out = vec![toc];
	out.extend(encoder.done());
	Some(out)
}

/// the symbols of a packet's first frame, or of its LBRR copy (for tests)
#[cfg(test)]
pub fn symbols(packet: &[u8], copy: bool) -> Vec<usize> {
	let Some((rate, _)) = layout(packet[0]) else {
		return Vec::new();
	};
	let mut decoder = Decoder::new(packet, 1);
	decoder.bit(1);
	let lbrr = decoder.bit(1);
	if copy && !lbrr {
		return Vec::new();
	}
	read_frame(&mut decoder, rate).into_iter().map(|(_, value)| value).collect()
}

// The iCDF tables of libopus's SILK decoder (silk/tables_*.c, libopus
// 1.5.2, BSD-3-Clause, Copyright (c) 2006-2011 Skype Limited), each its
// bytes, two-dimensional ones row after row.
static TYPE_OFFSET: [u8; 4] = [
	232, 158, 10, 0,
];
static GAIN: [u8; 24] = [
	224, 112, 44, 15, 3, 2, 1, 0, 254, 237, 192, 132, 70, 23, 4, 0,
	255, 252, 226, 155, 61, 11, 2, 0,
];
static UNIFORM8: [u8; 8] = [
	224, 192, 160, 128, 96, 64, 32, 0,
];
static UNIFORM6: [u8; 6] = [
	213, 171, 128, 85, 43, 0,
];
static UNIFORM4: [u8; 4] = [
	192, 128, 64, 0,
];
static DELTA_GAIN: [u8; 41] = [
	250, 245, 234, 203, 71, 50, 42, 38, 35, 33, 31, 29, 28, 27, 26, 25,
	24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9,
	8, 7, 6, 5, 4, 3, 2, 1, 0,
];
static CB1_WIDE: [u8; 64] = [
	225, 204, 201, 184, 183, 175, 158, 154, 153, 135, 119, 115, 113, 110, 109, 99,
	98, 95, 79, 68, 52, 50, 48, 45, 43, 32, 31, 27, 18, 10, 3, 0,
	255, 251, 235, 230, 212, 201, 196, 182, 167, 166, 163, 151, 138, 124, 110, 104,
	90, 78, 76, 70, 69, 57, 45, 34, 24, 21, 11, 6, 5, 4, 3, 0,
];
static SELECT_WIDE: [u8; 256] = [
	0, 0, 0, 0, 0, 0, 0, 1, 100, 102, 102, 68, 68, 36, 34, 96,
	164, 107, 158, 185, 180, 185, 139, 102, 64, 66, 36, 34, 34, 0, 1, 32,
	208, 139, 141, 191, 152, 185, 155, 104, 96, 171, 104, 166, 102, 102, 102, 132,
	1, 0, 0, 0, 0, 16, 16, 0, 80, 109, 78, 107, 185, 139, 103, 101,
	208, 212, 141, 139, 173, 153, 123, 103, 36, 0, 0, 0, 0, 0, 0, 1,
	48, 0, 0, 0, 0, 0, 0, 32, 68, 135, 123, 119, 119, 103, 69, 98,
	68, 103, 120, 118, 118, 102, 71, 98, 134, 136, 157, 184, 182, 153, 139, 134,
	208, 168, 248, 75, 189, 143, 121, 107, 32, 49, 34, 34, 34, 0, 17, 2,
	210, 235, 139, 123, 185, 137, 105, 134, 98, 135, 104, 182, 100, 183, 171, 134,
	100, 70, 68, 70, 66, 66, 34, 131, 64, 166, 102, 68, 36, 2, 1, 0,
	134, 166, 102, 68, 34, 34, 66, 132, 212, 246, 158, 139, 107, 107, 87, 102,
	100, 219, 125, 122, 137, 118, 103, 132, 114, 135, 137, 105, 171, 106, 50, 34,
	164, 214, 141, 143, 185, 151, 121, 103, 192, 34, 0, 0, 0, 0, 0, 1,
	208, 109, 74, 187, 134, 249, 159, 137, 102, 110, 154, 118, 87, 101, 119, 101,
	0, 2, 0, 36, 36, 66, 68, 35, 96, 164, 102, 100, 36, 0, 2, 33,
	167, 138, 174, 102, 100, 84, 2, 2, 100, 107, 120, 119, 36, 197, 24, 0,
];
static CB2_WIDE: [u8; 72] = [
	255, 254, 253, 244, 12, 3, 2, 1, 0, 255, 254, 252, 224, 38, 3, 2,
	1, 0, 255, 254, 251, 209, 57, 4, 2, 1, 0, 255, 254, 244, 195, 69,
	4, 2, 1, 0, 255, 251, 232, 184, 84, 7, 2, 1, 0, 255, 254, 240,
	186, 86, 14, 2, 1, 0, 255, 254, 239, 178, 91, 30, 5, 1, 0, 255,
	248, 227, 177, 100, 19, 2, 1, 0,
];
static CB1_NARROW: [u8; 64] = [
	212, 178, 148, 129, 108, 96, 85, 82, 79, 77, 61, 59, 57, 56, 51, 49,
	48, 45, 42, 41, 40, 38, 36, 34, 31, 30, 21, 12, 10, 3, 1, 0,
	255, 245, 244, 236, 233, 225, 217, 203, 190, 176, 175, 161, 149, 136, 125, 114,
	102, 91, 81, 71, 60, 52, 43, 35, 28, 20, 19, 18, 12, 11, 5, 0,
];
static SELECT_NARROW: [u8; 160] = [
	16, 0, 0, 0, 0, 99, 66, 36, 36, 34, 36, 34, 34, 34, 34, 83,
	69, 36, 52, 34, 116, 102, 70, 68, 68, 176, 102, 68, 68, 34, 65, 85,
	68, 84, 36, 116, 141, 152, 139, 170, 132, 187, 184, 216, 137, 132, 249, 168,
	185, 139, 104, 102, 100, 68, 68, 178, 218, 185, 185, 170, 244, 216, 187, 187,
	170, 244, 187, 187, 219, 138, 103, 155, 184, 185, 137, 116, 183, 155, 152, 136,
	132, 217, 184, 184, 170, 164, 217, 171, 155, 139, 244, 169, 184, 185, 170, 164,
	216, 223, 218, 138, 214, 143, 188, 218, 168, 244, 141, 136, 155, 170, 168, 138,
	220, 219, 139, 164, 219, 202, 216, 137, 168, 186, 246, 185, 139, 116, 185, 219,
	185, 138, 100, 100, 134, 100, 102, 34, 68, 68, 100, 68, 168, 203, 221, 218,
	168, 167, 154, 136, 104, 70, 164, 246, 171, 137, 139, 137, 155, 218, 219, 139,
];
static CB2_NARROW: [u8; 72] = [
	255, 254, 253, 238, 14, 3, 2, 1, 0, 255, 254, 252, 218, 35, 3, 2,
	1, 0, 255, 254, 250, 208, 59, 4, 2, 1, 0, 255, 254, 246, 194, 71,
	10, 2, 1, 0, 255, 252, 236, 183, 82, 8, 2, 1, 0, 255, 252, 235,
	180, 90, 17, 2, 1, 0, 255, 248, 224, 171, 97, 30, 4, 1, 0, 255,
	254, 236, 173, 95, 37, 7, 1, 0,
];
static NLSF_EXT: [u8; 7] = [
	100, 40, 16, 7, 3, 1, 0,
];
static INTERPOLATION: [u8; 5] = [
	243, 221, 192, 181, 0,
];
static PITCH_LAG: [u8; 32] = [
	253, 250, 244, 233, 212, 182, 150, 131, 120, 110, 98, 85, 72, 60, 49, 40,
	32, 25, 19, 15, 13, 11, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
];
static CONTOUR: [u8; 34] = [
	223, 201, 183, 167, 152, 138, 124, 111, 98, 88, 79, 70, 62, 56, 50, 44,
	39, 35, 31, 27, 24, 21, 18, 16, 14, 12, 10, 8, 6, 4, 3, 2,
	1, 0,
];
static CONTOUR_NARROW: [u8; 11] = [
	188, 176, 155, 138, 119, 97, 67, 43, 26, 10, 0,
];
static LTP_PERIODICITY: [u8; 3] = [
	179, 99, 0,
];
static LTP_GAIN0: [u8; 8] = [
	71, 56, 43, 30, 21, 12, 6, 0,
];
static LTP_GAIN1: [u8; 16] = [
	199, 165, 144, 124, 109, 96, 84, 71, 61, 51, 42, 32, 23, 15, 8, 0,
];
static LTP_GAIN2: [u8; 32] = [
	241, 225, 211, 199, 187, 175, 164, 153, 142, 132, 123, 114, 105, 96, 88, 80,
	72, 64, 57, 50, 44, 38, 33, 29, 24, 20, 16, 12, 9, 5, 2, 0,
];
static LTP_SCALE: [u8; 3] = [
	128, 64, 0,
];
static RATE_LEVELS: [u8; 18] = [
	241, 190, 178, 132, 87, 74, 41, 14, 0, 223, 193, 157, 140, 106, 57, 39,
	18, 0,
];
static PULSES_PER_BLOCK: [u8; 180] = [
	125, 51, 26, 18, 15, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
	1, 0, 198, 105, 45, 22, 15, 12, 11, 10, 9, 8, 7, 6, 5, 4,
	3, 2, 1, 0, 213, 162, 116, 83, 59, 43, 32, 24, 18, 15, 12, 9,
	7, 6, 5, 3, 2, 0, 239, 187, 116, 59, 28, 16, 11, 10, 9, 8,
	7, 6, 5, 4, 3, 2, 1, 0, 250, 229, 188, 135, 86, 51, 30, 19,
	13, 10, 8, 6, 5, 4, 3, 2, 1, 0, 249, 235, 213, 185, 156, 128,
	103, 83, 66, 53, 42, 33, 26, 21, 17, 13, 10, 0, 254, 249, 235, 206,
	164, 118, 77, 46, 27, 16, 10, 7, 5, 4, 3, 2, 1, 0, 255, 253,
	249, 239, 220, 191, 156, 119, 85, 57, 37, 23, 15, 10, 6, 4, 2, 0,
	255, 253, 251, 246, 237, 223, 203, 179, 152, 124, 98, 75, 55, 40, 29, 21,
	15, 0, 255, 254, 253, 247, 220, 162, 106, 67, 42, 28, 18, 12, 9, 6,
	4, 3, 2, 0,
];
static SHELL0: [u8; 152] = [
	128, 0, 214, 42, 0, 235, 128, 21, 0, 244, 184, 72, 11, 0, 248, 214,
	128, 42, 7, 0, 248, 225, 170, 80, 25, 5, 0, 251, 236, 198, 126, 54,
	18, 3, 0, 250, 238, 211, 159, 82, 35, 15, 5, 0, 250, 231, 203, 168,
	128, 88, 53, 25, 6, 0, 252, 238, 216, 185, 148, 108, 71, 40, 18, 4,
	0, 253, 243, 225, 199, 166, 128, 90, 57, 31, 13, 3, 0, 254, 246, 233,
	212, 183, 147, 109, 73, 44, 23, 10, 2, 0, 255, 250, 240, 223, 198, 166,
	128, 90, 58, 33, 16, 6, 1, 0, 255, 251, 244, 231, 210, 181, 146, 110,
	75, 46, 25, 12, 5, 1, 0, 255, 253, 248, 238, 221, 196, 164, 128, 92,
	60, 35, 18, 8, 3, 1, 0, 255, 253, 249, 242, 229, 208, 180, 146, 110,
	76, 48, 27, 14, 7, 3, 1, 0,
];
static SHELL1: [u8; 152] = [
	129, 0, 207, 50, 0, 236, 129, 20, 0, 245, 185, 72, 10, 0, 249, 213,
	129, 42, 6, 0, 250, 226, 169, 87, 27, 4, 0, 251, 233, 194, 130, 62,
	20, 4, 0, 250, 236, 207, 160, 99, 47, 17, 3, 0, 255, 240, 217, 182,
	131, 81, 41, 11, 1, 0, 255, 254, 233, 201, 159, 107, 61, 20, 2, 1,
	0, 255, 249, 233, 206, 170, 128, 86, 50, 23, 7, 1, 0, 255, 250, 238,
	217, 186, 148, 108, 70, 39, 18, 6, 1, 0, 255, 252, 243, 226, 200, 166,
	128, 90, 56, 30, 13, 4, 1, 0, 255, 252, 245, 231, 209, 180, 146, 110,
	76, 47, 25, 11, 4, 1, 0, 255, 253, 248, 237, 219, 194, 163, 128, 93,
	62, 37, 19, 8, 3, 1, 0, 255, 254, 250, 241, 226, 205, 177, 145, 111,
	79, 51, 30, 15, 6, 2, 1, 0,
];
static SHELL2: [u8; 152] = [
	129, 0, 203, 54, 0, 234, 129, 23, 0, 245, 184, 73, 10, 0, 250, 215,
	129, 41, 5, 0, 252, 232, 173, 86, 24, 3, 0, 253, 240, 200, 129, 56,
	15, 2, 0, 253, 244, 217, 164, 94, 38, 10, 1, 0, 253, 245, 226, 189,
	132, 71, 27, 7, 1, 0, 253, 246, 231, 203, 159, 105, 56, 23, 6, 1,
	0, 255, 248, 235, 213, 179, 133, 85, 47, 19, 5, 1, 0, 255, 254, 243,
	221, 194, 159, 117, 70, 37, 12, 2, 1, 0, 255, 254, 248, 234, 208, 171,
	128, 85, 48, 22, 8, 2, 1, 0, 255, 254, 250, 240, 220, 189, 149, 107,
	67, 36, 16, 6, 2, 1, 0, 255, 254, 251, 243, 227, 201, 166, 128, 90,
	55, 29, 13, 5, 2, 1, 0, 255, 254, 252, 246, 234, 213, 183, 147, 109,
	73, 43, 22, 10, 4, 2, 1, 0,
];
static SHELL3: [u8; 152] = [
	130, 0, 200, 58, 0, 231, 130, 26, 0, 244, 184, 76, 12, 0, 249, 214,
	130, 43, 6, 0, 252, 232, 173, 87, 24, 3, 0, 253, 241, 203, 131, 56,
	14, 2, 0, 254, 246, 221, 167, 94, 35, 8, 1, 0, 254, 249, 232, 193,
	130, 65, 23, 5, 1, 0, 255, 251, 239, 211, 162, 99, 45, 15, 4, 1,
	0, 255, 251, 243, 223, 186, 131, 74, 33, 11, 3, 1, 0, 255, 252, 245,
	230, 202, 158, 105, 57, 24, 8, 2, 1, 0, 255, 253, 247, 235, 214, 179,
	132, 84, 44, 19, 7, 2, 1, 0, 255, 254, 250, 240, 223, 196, 159, 112,
	69, 36, 15, 6, 2, 1, 0, 255, 254, 253, 245, 231, 209, 176, 136, 93,
	55, 27, 11, 3, 2, 1, 0, 255, 254, 253, 252, 239, 221, 194, 158, 117,
	76, 42, 18, 4, 3, 2, 1, 0,
];
static SHELL_OFFSETS: [u8; 17] = [
	0, 0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77, 90, 104, 119,
	135,
];
static LSB: [u8; 2] = [
	120, 0,
];
const SIGN: [u8; 42] = [
	254, 49, 67, 77, 82, 93, 99, 198, 11, 18, 24, 31, 36, 45, 255, 46,
	66, 78, 87, 94, 104, 208, 14, 21, 32, 42, 51, 66, 255, 94, 104, 109,
	112, 115, 118, 248, 53, 69, 80, 88, 95, 102,
];
