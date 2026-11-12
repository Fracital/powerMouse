//! The xor codec of STomp's routed URLs (docs/codec.md, `src/xorWire.ts`):
//! every byte of the text XORed with a stream drawn from the controller's
//! key, then written in the URL-safe base64 alphabet without padding, so a
//! route shows no character of the URL it stands for. The JavaScript codec
//! in `src/xorWire.ts` writes the same bytes for every input and key
//! (`rust/host/codec.mjs` and the `codec` suite hold the two together); it
//! answers wherever a realm may not compile a module.
//!
//! The stream: byte `n` of the text is XORed with byte `n & 3` (from the
//! low end) of `word(n >> 2)`, and
//! `word(j) = mix(mix(a + j * 0x9E3779B9) ^ b)` in wrapping 32-bit
//! arithmetic, `a` and `b` the two halves of the key and `mix` the 32-bit
//! finalizer of MurmurHash3. It is addressed by position, so a long text
//! is sealed in pieces and each piece says where it starts.
//!
//! The boundary, with no import and no allocation: two buffers of `ROOM`
//! bytes each, where they are is asked once (`i`, `o`).
//!
//! - `e(len, at, a, b) -> len`: seals the `len` bytes in the input buffer,
//!   which stand at byte `at` of the text (a multiple of 3 unless it is
//!   the first piece: base64 groups do not straddle pieces), into the
//!   output buffer; the answer is how many characters it wrote, or -1 for
//!   more than `SEAL` bytes;
//! - `d(len, at, a, b) -> len`: opens the `len` characters in the input
//!   buffer, whose first byte stands at byte `at` of the text, into the
//!   output buffer; how many bytes it wrote, or -1 when the characters are
//!   no seal: one outside the alphabet, a length no seal has, bits set
//!   that a seal leaves clear, more than `ROOM` characters.
#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(clippy::missing_safety_doc)]

/// the bytes of each buffer
pub const ROOM: usize = 16384;
/// the most bytes one `e` seals: their characters fill the output buffer
pub const SEAL: usize = ROOM / 4 * 3;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// a character's six bits, or 0xFF for one outside the alphabet
const fn six(character: u8) -> u8 {
	match character {
		b'A'..=b'Z' => character - b'A',
		b'a'..=b'z' => character - b'a' + 26,
		b'0'..=b'9' => character - b'0' + 52,
		b'-' => 62,
		b'_' => 63,
		_ => 0xFF,
	}
}

#[inline]
const fn mix(mut x: u32) -> u32 {
	x ^= x >> 16;
	x = x.wrapping_mul(0x85EB_CA6B);
	x ^= x >> 13;
	x = x.wrapping_mul(0xC2B2_AE35);
	x ^ (x >> 16)
}

/// word `j` of the stream of the key `a`, `b`
#[inline]
pub const fn word(a: u32, b: u32, j: u32) -> u32 {
	mix(mix(a.wrapping_add(j.wrapping_mul(0x9E37_79B9))) ^ b)
}

/// The stream from byte `at` on, a byte a call
struct Stream {
	a: u32,
	b: u32,
	at: u32,
	word: u32,
}

impl Stream {
	fn new(a: u32, b: u32, at: u32) -> Stream {
		Stream {
			a,
			b,
			at,
			word: word(a, b, at >> 2),
		}
	}

	#[inline]
	fn next(&mut self) -> u8 {
		let byte = (self.word >> (8 * (self.at & 3))) as u8;
		self.at = self.at.wrapping_add(1);
		if self.at & 3 == 0 {
			self.word = word(self.a, self.b, self.at >> 2);
		}
		byte
	}
}

/// How many characters seal `len` bytes
pub const fn sealed_len(len: usize) -> usize {
	len / 3 * 4
		+ match len % 3 {
			0 => 0,
			1 => 2,
			_ => 3,
		}
}

/// `input`, which stands at byte `at` of the text, sealed into `output`
/// under the key `a`, `b`: how many characters were written, or None when
/// `output` has no room for them
pub fn seal(input: &[u8], output: &mut [u8], at: u32, a: u32, b: u32) -> Option<usize> {
	let mut stream = Stream::new(a, b, at);
	let mut slots = output.iter_mut();
	let mut written = 0;
	// (nothing here indexes: a slot that is not there ends the call, and
	// the artifact carries no panic)
	let mut put = |bits: u32, count: u32| -> Option<()> {
		for nth in 0..count {
			*slots.next()? = ALPHABET[(bits >> (18 - 6 * nth) & 63) as usize];
			written += 1;
		}
		Some(())
	};
	let mut bits = 0u32;
	let mut held = 0;
	for &byte in input {
		bits = bits << 8 | (byte ^ stream.next()) as u32;
		held += 1;
		if held == 3 {
			put(bits, 4)?;
			bits = 0;
			held = 0;
		}
	}
	match held {
		1 => put(bits << 16, 2)?,
		2 => put(bits << 8, 3)?,
		_ => {}
	}
	Some(written)
}

/// The characters `input`, whose first byte stands at byte `at` of the
/// text, opened into `output` under the key `a`, `b`: how many bytes were
/// written, or None when `input` is no seal or `output` has no room
pub fn open(input: &[u8], output: &mut [u8], at: u32, a: u32, b: u32) -> Option<usize> {
	let mut stream = Stream::new(a, b, at);
	let mut slots = output.iter_mut();
	let mut written = 0;
	let mut put = |byte: u32| -> Option<()> {
		*slots.next()? = byte as u8 ^ stream.next();
		written += 1;
		Some(())
	};
	// every character's six bits are OR-ed here: one outside the alphabet
	// leaves a bit above them set
	let mut seen = 0u8;
	let mut bits = 0u32;
	let mut held = 0;
	for &character in input {
		let value = six(character);
		seen |= value;
		bits = bits << 6 | (value & 63) as u32;
		held += 1;
		if held == 4 {
			put(bits >> 16)?;
			put(bits >> 8)?;
			put(bits)?;
			bits = 0;
			held = 0;
		}
	}
	match held {
		0 => {}
		// the bits a seal leaves clear after its last byte
		2 if bits & 0x0F == 0 => put(bits >> 4)?,
		3 if bits & 0x03 == 0 => {
			put(bits >> 10)?;
			put(bits >> 2)?;
		}
		_ => return None,
	}
	if seen & 0xC0 != 0 {
		return None;
	}
	Some(written)
}

/// The exports. The two buffers are statics, so the module is one page of
/// memory, laid out at link time, and nothing is allocated.
#[cfg(target_arch = "wasm32")]
mod abi {
	use super::{ROOM, SEAL, open, seal};
	use core::arch::wasm32::unreachable;
	use core::cell::UnsafeCell;

	struct Buffer(UnsafeCell<[u8; ROOM]>);
	// wasm32-unknown-unknown has one thread: the host calls one export at a time
	unsafe impl Sync for Buffer {}

	static INPUT: Buffer = Buffer(UnsafeCell::new([0; ROOM]));
	static OUTPUT: Buffer = Buffer(UnsafeCell::new([0; ROOM]));

	/// where the host writes what a call reads
	#[unsafe(no_mangle)]
	pub extern "C" fn i() -> *mut u8 {
		INPUT.0.get().cast()
	}

	/// where the host reads what a call wrote
	#[unsafe(no_mangle)]
	pub extern "C" fn o() -> *const u8 {
		OUTPUT.0.get().cast()
	}

	fn buffers(len: usize) -> Option<(&'static [u8], &'static mut [u8; ROOM])> {
		// SAFETY: single threaded, and no reference outlives the export call
		let (input, output) = unsafe { (&*INPUT.0.get(), &mut *OUTPUT.0.get()) };
		Some((input.get(..len)?, output))
	}

	#[unsafe(no_mangle)]
	pub extern "C" fn e(len: usize, at: u32, a: u32, b: u32) -> i32 {
		if len > SEAL {
			return -1;
		}
		buffers(len)
			.and_then(|(input, output)| seal(input, output, at, a, b))
			.map_or(-1, |written| written as i32)
	}

	#[unsafe(no_mangle)]
	pub extern "C" fn d(len: usize, at: u32, a: u32, b: u32) -> i32 {
		buffers(len)
			.and_then(|(input, output)| open(input, output, at, a, b))
			.map_or(-1, |written| written as i32)
	}

	/// a panic is a trap, which the loader takes for a dead instance
	#[panic_handler]
	fn panic(_: &core::panic::PanicInfo) -> ! {
		unreachable()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// a generator for the tests' inputs (xorshift32)
	struct Random(u32);
	impl Random {
		fn next(&mut self) -> u32 {
			self.0 ^= self.0 << 13;
			self.0 ^= self.0 >> 17;
			self.0 ^= self.0 << 5;
			self.0
		}
	}

	fn sealed(input: &[u8], a: u32, b: u32) -> Vec<u8> {
		let mut output = vec![0; sealed_len(input.len())];
		assert_eq!(seal(input, &mut output, 0, a, b), Some(output.len()));
		output
	}

	fn opened(input: &[u8], a: u32, b: u32) -> Option<Vec<u8>> {
		let mut output = vec![0; input.len()];
		let len = open(input, &mut output, 0, a, b)?;
		output.truncate(len);
		Some(output)
	}

	#[test]
	fn the_stream_is_the_documented_one() {
		// the same numbers stand in src/xorWire.ts's test (the codec suite)
		assert_eq!(word(0, 0, 0), 0);
		assert_eq!(word(0x0123_4567, 0x89AB_CDEF, 0), 0x5F5A_B57B);
		assert_eq!(word(0x0123_4567, 0x89AB_CDEF, 1), 0xB6E3_DE93);
		assert_eq!(word(0xFFFF_FFFF, 0xFFFF_FFFF, 0xFFFF_FFFF), 0x1C82_FD7A);
	}

	#[test]
	fn a_seal_is_the_documented_text() {
		assert_eq!(sealed(b"", 1, 2), b"");
		assert_eq!(
			sealed(b"https://example.com/", 0x0123_4567, 0x89AB_CDEF),
			b"E8EuL-DkzJlw9kj1zVTg6Zz6YJM"
		);
	}

	#[test]
	fn every_length_and_byte_round_trips() {
		let mut random = Random(0x9E37_79B9);
		for len in 0..600 {
			let input: Vec<u8> = (0..len).map(|_| random.next() as u8).collect();
			let (a, b) = (random.next(), random.next());
			let text = sealed(&input, a, b);
			assert!(text.iter().all(|&c| six(c) != 0xFF));
			assert_eq!(opened(&text, a, b).as_deref(), Some(&input[..]));
		}
	}

	#[test]
	fn pieces_are_the_whole() {
		let mut random = Random(7);
		let input: Vec<u8> = (0..5000).map(|_| random.next() as u8).collect();
		let (a, b) = (random.next(), random.next());
		let whole = sealed(&input, a, b);
		for piece in [3, 12, 300, 4095] {
			let mut text = Vec::new();
			for (n, chunk) in input.chunks(piece).enumerate() {
				let mut output = vec![0; sealed_len(chunk.len())];
				seal(chunk, &mut output, (n * piece) as u32, a, b).unwrap();
				text.extend(output);
			}
			assert_eq!(text, whole);
			let mut bytes: Vec<u8> = Vec::new();
			for (n, chunk) in whole.chunks(piece / 3 * 4).enumerate() {
				let mut output = vec![0; chunk.len()];
				let len = open(chunk, &mut output, (n * piece) as u32, a, b).unwrap();
				bytes.extend(&output[..len]);
			}
			assert_eq!(bytes, input);
		}
	}

	#[test]
	fn what_is_no_seal_is_refused() {
		let (a, b) = (5, 6);
		// a length no seal has
		assert_eq!(opened(b"A", a, b), None);
		assert_eq!(opened(b"AAAAA", a, b), None);
		// a character outside the alphabet, wherever it stands
		for bad in [b'$', b'=', b'+', b'/', b'%', b' ', 0, 0x80, 0xFF] {
			for at in 0..7 {
				let mut text = *b"AAAAAAA";
				text[at] = bad;
				assert_eq!(opened(&text, a, b), None, "{bad} at {at}");
			}
		}
		// bits a seal leaves clear
		assert_eq!(opened(b"AB", a, b), None);
		assert_eq!(opened(b"AAB", a, b), None);
		assert!(opened(b"AQ", a, b).is_some());
		assert!(opened(b"AAE", a, b).is_some());
		// no room
		let mut small = [0u8; 2];
		assert_eq!(open(b"AAAA", &mut small, 0, a, b), None);
		assert_eq!(seal(b"abc", &mut small, 0, a, b), None);
	}

	#[test]
	fn another_key_is_another_text() {
		let input = b"https://example.com/a/b?c=d";
		let one = sealed(input, 1, 2);
		assert_ne!(one, sealed(input, 1, 3));
		assert_ne!(one, sealed(input, 2, 2));
		assert_ne!(opened(&one, 1, 3).as_deref(), Some(&input[..]));
	}
}
