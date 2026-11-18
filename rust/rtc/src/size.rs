//! The picture size a received keyframe states, as Chrome's depacketizers
//! read it for a receiver's encoded transform (`getMetadata()`'s width and
//! height): VP8's keyframe header, VP9's uncompressed header, H.264's
//! sequence parameter set (cropped). AV1's depacketizer reads none. None
//! where the bytes say no size.

/// reads bits, most significant first; None past the end
struct Bits<'a> {
	bytes: &'a [u8],
	at: usize,
}

impl Bits<'_> {
	fn bit(&mut self) -> Option<u32> {
		let byte = *self.bytes.get(self.at >> 3)?;
		let bit = (byte >> (7 - (self.at & 7))) & 1;
		self.at += 1;
		Some(bit as u32)
	}

	fn bits(&mut self, n: u32) -> Option<u32> {
		let mut value = 0u32;
		for _ in 0..n {
			value = (value << 1) | self.bit()?;
		}
		Some(value)
	}

	/// an Exp-Golomb number, unsigned
	fn ue(&mut self) -> Option<u32> {
		let mut zeros = 0;
		while self.bit()? == 0 {
			zeros += 1;
			if zeros > 31 {
				return None;
			}
		}
		Some(((1u64 << zeros) - 1 + self.bits(zeros)? as u64).min(u32::MAX as u64) as u32)
	}

	fn se(&mut self) -> Option<i64> {
		let value = self.ue()? as i64;
		Some(if value & 1 == 1 { (value + 1) / 2 } else { -value / 2 })
	}
}

/// the size a keyframe of the codec (media.rs `codec_id`) states
pub fn picture_size(codec: u8, bytes: &[u8]) -> Option<(u16, u16)> {
	let size = match codec {
		10 => vp8(bytes),
		11 => vp9(bytes),
		12 => h264(bytes),
		_ => None,
	}?;
	Some((size.0.min(u16::MAX as u32) as u16, size.1.min(u16::MAX as u32) as u16))
}

fn vp8(bytes: &[u8]) -> Option<(u32, u32)> {
	// a keyframe: bit 0 clear, then the start code 9d 01 2a
	if bytes.len() < 10 || bytes[0] & 1 == 1 || bytes[3..6] != [0x9d, 0x01, 0x2a] {
		return None;
	}
	let side = |at: usize| (bytes[at] as u32 | (bytes[at + 1] as u32) << 8) & 0x3fff;
	Some((side(6), side(8)))
}

fn vp9(bytes: &[u8]) -> Option<(u32, u32)> {
	let mut bits = Bits { bytes, at: 0 };
	if bits.bits(2)? != 2 {
		return None;
	}
	let profile = bits.bit()? | (bits.bit()? << 1);
	if profile == 3 {
		bits.bit()?;
	}
	// a frame shown again, or not a keyframe
	if bits.bit()? == 1 || bits.bit()? == 1 {
		return None;
	}
	bits.bits(2)?;
	if bits.bits(24)? != 0x498342 {
		return None;
	}
	if profile >= 2 {
		bits.bit()?;
	}
	// color space: not RGB has a range bit
	if bits.bits(3)? != 7 {
		bits.bit()?;
		if profile == 1 || profile == 3 {
			bits.bits(3)?;
		}
	} else if profile == 1 || profile == 3 {
		bits.bit()?;
	}
	Some((bits.bits(16)? + 1, bits.bits(16)? + 1))
}

fn h264(bytes: &[u8]) -> Option<(u32, u32)> {
	// Annex B: the first SPS (NAL type 7), up to the next start code
	let start = (0..bytes.len().saturating_sub(3)).find(|&i| bytes[i..i + 3] == [0, 0, 1] && bytes[i + 3] & 0x1f == 7)? + 4;
	let mut end = start;
	while end < bytes.len() && !(bytes[end] == 0 && bytes.get(end + 1) == Some(&0) && bytes.get(end + 2).is_some_and(|&b| b <= 1)) {
		end += 1;
	}
	// emulation prevention removed
	let mut sps = Vec::with_capacity(end - start);
	let mut zeros = 0;
	for &byte in &bytes[start..end] {
		if zeros >= 2 && byte == 3 {
			zeros = 0;
			continue;
		}
		zeros = if byte == 0 { zeros + 1 } else { 0 };
		sps.push(byte);
	}
	read_sps(&sps)
}

fn read_sps(bytes: &[u8]) -> Option<(u32, u32)> {
	let mut bits = Bits { bytes, at: 0 };
	let profile = bits.bits(8)?;
	bits.bits(16)?;
	bits.ue()?;
	let mut chroma = 1;
	let mut separate = 0;
	if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(&profile) {
		chroma = bits.ue()?;
		if chroma == 3 {
			separate = bits.bit()?;
		}
		bits.ue()?;
		bits.ue()?;
		bits.bit()?;
		if bits.bit()? == 1 {
			for list in 0..(if chroma == 3 { 12 } else { 8 }) {
				if bits.bit()? == 0 {
					continue;
				}
				let (mut last, mut next) = (8i64, 8i64);
				for _ in 0..(if list < 6 { 16 } else { 64 }) {
					if next != 0 {
						next = (last + bits.se()? + 256).rem_euclid(256);
					}
					if next != 0 {
						last = next;
					}
				}
			}
		}
	}
	bits.ue()?;
	match bits.ue()? {
		0 => {
			bits.ue()?;
		}
		1 => {
			bits.bit()?;
			bits.se()?;
			bits.se()?;
			for _ in 0..bits.ue()? {
				bits.se()?;
			}
		}
		_ => {}
	}
	bits.ue()?;
	bits.bit()?;
	let width_mbs = bits.ue()? as i64 + 1;
	let height_units = bits.ue()? as i64 + 1;
	let frame_mbs_only = bits.bit()? as i64;
	if frame_mbs_only == 0 {
		bits.bit()?;
	}
	bits.bit()?;
	let mut width = width_mbs * 16;
	let mut height = (2 - frame_mbs_only) * height_units * 16;
	if bits.bit()? == 1 {
		let (left, right, top, bottom) = (bits.ue()? as i64, bits.ue()? as i64, bits.ue()? as i64, bits.ue()? as i64);
		let kind = if separate == 1 { 0 } else { chroma };
		let crop_x = if kind == 1 || kind == 2 { 2 } else { 1 };
		let crop_y = (if kind == 1 { 2 } else { 1 }) * (2 - frame_mbs_only);
		width -= (left + right) * crop_x;
		height -= (top + bottom) * crop_y;
	}
	Some((width.max(0) as u32, height.max(0) as u32))
}

#[cfg(test)]
mod tests {
	use super::picture_size;

	#[test]
	fn keyframe_sizes() {
		// VP8: a keyframe's header, 640x360 (scaling bits set, left out)
		let vp8 = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x42, 0x68, 0x41, 0];
		assert_eq!(picture_size(10, &vp8), Some((640, 360)));
		// a delta frame states none
		assert_eq!(picture_size(10, &[0x11, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x68, 0x01]), None);
		// VP9 profile 0: frame marker, keyframe, shown, sync code, BT.601,
		// then 640x360 less one, each in 16 bits
		let mut bits = String::from("10" /* marker */);
		bits += "00" /* profile 0 */;
		bits += "0" /* not shown again */;
		bits += "0" /* keyframe */;
		bits += "10" /* shown, error resilient off */;
		bits += &format!("{:024b}", 0x498342);
		bits += "001" /* colour space */;
		bits += "0" /* range */;
		bits += &format!("{:016b}{:016b}", 639, 359);
		while bits.len() % 8 != 0 {
			bits.push('0');
		}
		let vp9: Vec<u8> = (0..bits.len() / 8).map(|i| u8::from_str_radix(&bits[i * 8..i * 8 + 8], 2).unwrap()).collect();
		assert_eq!(picture_size(11, &vp9), Some((640, 360)));
		// H.264: an SPS of 640x368 cropped by 8 rows, after an AUD, before a PPS
		let h264 = [
			0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0xf4, 0x05, 0x01, 0x7f, 0xca, 0x80, 0, 0, 0, 1, 0x68, 0xce,
		];
		assert_eq!(picture_size(12, &h264), Some((640, 360)));
		// cut short, and AV1, which states none
		assert_eq!(picture_size(12, &h264[..16]), None);
		assert_eq!(picture_size(13, &vp9), None);
	}
}
