//! What a function's source reads back as (src/functionSource.ts), the Rust
//! side: the key a script's text is kept by, the mark each function carries,
//! and the offsets the mark names. Those offsets are indices into the text
//! as a JavaScript string, UTF-16 code units (`originalSource` slices the
//! kept text with them), while oxc's spans are byte offsets into UTF-8: the
//! two differ past any non-ASCII character, and a mark built from byte
//! offsets would read back the wrong slice of any script with one. Every
//! mark goes through [`Utf16Offsets`].

/// The key of `text`, as `sourceKey` computes it: two 32-bit hashes over the
/// UTF-16 code units, 42 bits in nine base-36 digits. Must stay byte for
/// byte what the TypeScript gives, or a text the worker kept is never found
/// by the function that reads it.
pub fn source_key(text: &str) -> String {
	let mut a: u32 = 0x811c_9dc5;
	let mut b: u32 = 0x9747_b28c;
	for c in text.encode_utf16() {
		let c = u32::from(c);
		a = (a ^ c).wrapping_mul(0x0100_0193);
		b = (b ^ c).wrapping_mul(0x5bd1_e995);
		b ^= b >> 13;
	}
	format!("{:0>7}{:0>2}", base36(a), base36(b % 1296))
}

/// `/*key.start.len*/`, the mark of a function at `start..end` (UTF-16 offsets)
pub fn function_mark(key: &str, start: u32, end: u32) -> String {
	format!("/*{key}.{}.{}*/", base36(start), base36(end - start))
}

fn base36(mut n: u32) -> String {
	if n == 0 {
		return "0".to_owned();
	}
	let mut digits = Vec::new();
	while n > 0 {
		let d = (n % 36) as u8;
		digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
		n /= 36;
	}
	digits.reverse();
	String::from_utf8(digits).unwrap()
}

/// a non-ASCII character of the text: where it stands in bytes and in
/// UTF-16 code units, and how wide it is in each
#[derive(Clone, Copy)]
struct Wide {
	byte: u32,
	utf16: u32,
	byte_len: u8,
	utf16_len: u8,
}

/// Byte offsets of a text to UTF-16 code unit offsets. ASCII text maps one
/// to one; otherwise the non-ASCII characters, in order, give the shift at
/// any offset in a binary search.
pub struct Utf16Offsets {
	wide: Vec<Wide>,
}

impl Utf16Offsets {
	pub fn new(text: &str) -> Self {
		let mut wide = Vec::new();
		if !text.is_ascii() {
			let mut utf16 = 0u32;
			for (byte, c) in text.char_indices() {
				if !c.is_ascii() {
					wide.push(Wide {
						byte: byte as u32,
						utf16,
						byte_len: c.len_utf8() as u8,
						utf16_len: c.len_utf16() as u8,
					});
				}
				utf16 += c.len_utf16() as u32;
			}
		}
		Self { wide }
	}

	/// the UTF-16 offset of byte offset `byte` (a character boundary, as
	/// every span boundary is)
	pub fn convert(&self, byte: u32) -> u32 {
		// the last wide character starting at or before `byte`
		let i = self.wide.partition_point(|w| w.byte <= byte);
		if i == 0 {
			return byte;
		}
		let w = self.wide[i - 1];
		if w.byte == byte {
			return w.utf16;
		}
		// past it: its UTF-16 width, then the ASCII bytes since (anything
		// non-ASCII in between would be a later entry)
		w.utf16 + u32::from(w.utf16_len) + (byte - (w.byte + u32::from(w.byte_len)))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// the values src/functionSource.ts gives (node, 2026-11-10)
	#[test]
	fn keys_match_the_typescript() {
		assert_eq!(source_key(""), "0ztntfpdo");
		assert_eq!(source_key("a"), "1r9wi7g5r");
		assert_eq!(source_key("abc"), "07aigazot");
		assert_eq!(source_key("const x = location.href;"), "1u8p5jibh");
		assert_eq!(source_key("\u{fc}ber \u{1F600} \u{2028}"), "0plgj6ld2");
		assert_eq!(source_key(&"x".repeat(1000)), "0263fxhmw");
	}

	#[test]
	fn marks_match_the_typescript() {
		assert_eq!(function_mark("0ztntfpdo", 5, 70), "/*0ztntfpdo.5.1t*/");
		assert_eq!(function_mark("k", 0, 0), "/*k.0.0*/");
		assert_eq!(function_mark("k", 36, 1296), "/*k.10.z0*/");
	}

	#[test]
	fn ascii_offsets_are_identity() {
		let o = Utf16Offsets::new("function f() {}");
		for i in 0..=15 {
			assert_eq!(o.convert(i), i);
		}
	}

	#[test]
	fn offsets_shift_past_wide_characters() {
		// "a" (1,1) "ü" (2 bytes, 1 unit) "b" "😀" (4 bytes, 2 units) "c"
		let text = "a\u{fc}b\u{1F600}c";
		let o = Utf16Offsets::new(text);
		let expect = [(0, 0), (1, 1), (3, 2), (4, 3), (8, 5), (9, 6)];
		for (byte, utf16) in expect {
			assert_eq!(o.convert(byte), utf16, "byte {byte}");
		}
		// what a JS string would say
		let units: Vec<u16> = text.encode_utf16().collect();
		assert_eq!(units.len(), 6);
	}

	#[test]
	fn a_line_separator_is_one_unit() {
		let o = Utf16Offsets::new("x\u{2028}y");
		assert_eq!(o.convert(1), 1);
		assert_eq!(o.convert(4), 2);
		assert_eq!(o.convert(5), 3);
	}
}
