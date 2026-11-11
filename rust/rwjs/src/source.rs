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

/// the characters a kept text cannot carry in a block comment on one line
const CARRIED: [char; 6] = ['*', '<', '\n', '\r', '\u{2028}', '\u{2029}'];
/// what stands for them: characters scripts do not contain
const STAND_INS: [u8; 29] = [
	1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
	29, 30, 31, 127,
];

/// The statement that hands a script's text to the access API
/// (`holderStatement`): None when the text holds every stand-in character
pub fn holder_statement(access: &str, key: &str, text: &str) -> Option<String> {
	let mut present = [false; 128];
	for byte in text.bytes() {
		if byte < 128 {
			present[byte as usize] = true;
		}
	}
	let subs: Vec<char> = STAND_INS
		.iter()
		.filter(|code| !present[**code as usize])
		.take(CARRIED.len())
		.map(|code| *code as char)
		.collect();
	if subs.len() < CARRIED.len() {
		return None;
	}
	let mut out = String::with_capacity(text.len() + 96);
	out.push_str("typeof ");
	out.push_str(access);
	out.push_str("!==\"undefined\"&&");
	out.push_str(access);
	out.push_str(".src(");
	out.push_str(&quote(key));
	out.push(',');
	out.push_str(&quote(&subs.iter().collect::<String>()));
	out.push_str(",function(){/*");
	for c in text.chars() {
		match CARRIED.iter().position(|carried| *carried == c) {
			Some(i) => out.push(subs[i]),
			None => out.push(c),
		}
	}
	out.push_str("*/});");
	Some(out)
}

/// `text` as a JavaScript string literal, spelled as JSON.stringify spells
/// it (and the two line separators escaped, which a script's line cannot
/// hold before ES2019)
pub fn quote(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	out.push('"');
	for c in text.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'\u{2028}' => out.push_str("\\u2028"),
			'\u{2029}' => out.push_str("\\u2029"),
			c if (c as u32) < 0x20 => {
				out.push_str("\\u00");
				out.push(char::from_digit((c as u32) >> 4, 16).unwrap());
				out.push(char::from_digit((c as u32) & 15, 16).unwrap());
			}
			c => out.push(c),
		}
	}
	out.push('"');
	out
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

	// what holderStatement gives (node, 2026-11-10)
	#[test]
	fn holders_match_the_typescript() {
		assert_eq!(
			holder_statement("$s$j", "k", "a*b<c\nd").unwrap(),
			"typeof $s$j!==\"undefined\"&&$s$j.src(\"k\",\"\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\",function(){/*a\u{1}b\u{2}c\u{3}d*/});"
		);
		let all: String = STAND_INS.iter().map(|code| *code as char).collect();
		assert!(holder_statement("$s$j", "k", &all).is_none());
	}

	#[test]
	fn quoting() {
		assert_eq!(quote("a\"b\\c\n\u{2028}\u{1}"), "\"a\\\"b\\\\c\\n\\u2028\\u0001\"");
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
