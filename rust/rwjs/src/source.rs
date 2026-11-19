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
	let (mut a, mut b) = KEY_SEEDS;
	// an ASCII byte is its own code unit; only the rest is decoded. The two
	// hashes are one chain of multiplications, a byte after another, which
	// bounds the loop: eight ASCII bytes are read at once, so a byte costs
	// its steps on the chain and no load and branch of its own
	let bytes = text.as_bytes();
	let mut at = 0;
	loop {
		while let Some(chunk) = bytes.get(at..at + 8) {
			let word = u64::from_le_bytes(chunk.try_into().unwrap());
			if word & HIGH != 0 {
				break;
			}
			(a, b) = key_word(a, b, word);
			at += 8;
		}
		let Some(&byte) = bytes.get(at) else {
			break;
		};
		if byte < 0x80 {
			(a, b) = key_step(a, b, u32::from(byte));
			at += 1;
			continue;
		}
		let c = text[at..].chars().next().unwrap();
		(a, b) = key_char(a, b, c);
		at += c.len_utf8();
	}
	key_text(a, b)
}

/// how long a key is: seven base-36 digits of one hash and two of the other
const KEY_LENGTH: usize = 9;

const HIGH: u64 = 0x8080_8080_8080_8080;

/// eight ASCII bytes, the first lowest, into the key's two hashes
#[inline(always)]
fn key_word(mut a: u32, mut b: u32, word: u64) -> (u32, u32) {
	for i in 0..8 {
		(a, b) = key_step(a, b, ((word >> (8 * i)) & 0xff) as u32);
	}
	(a, b)
}

const KEY_SEEDS: (u32, u32) = (0x811c_9dc5, 0x9747_b28c);

/// the code units of the character `c`, which is not ASCII, into the key's
/// two hashes
fn key_char(mut a: u32, mut b: u32, c: char) -> (u32, u32) {
	let mut units = [0u16; 2];
	for unit in c.encode_utf16(&mut units) {
		(a, b) = key_step(a, b, u32::from(*unit));
	}
	(a, b)
}

/// the key the two hashes make: 42 bits in nine base-36 digits
fn key_text(a: u32, b: u32) -> String {
	format!("{:0>7}{:0>2}", base36(a), base36(b % 1296))
}

/// one code unit `c` into the key's two hashes
#[inline(always)]
fn key_step(a: u32, b: u32, c: u32) -> (u32, u32) {
	let a = (a ^ c).wrapping_mul(0x0100_0193);
	let b = (b ^ c).wrapping_mul(0x5bd1_e995);
	(a, b ^ (b >> 13))
}

/// `/*key.start.len*/`, the mark of a function at `start..end` (UTF-16 offsets)
pub fn function_mark(key: &str, start: u32, end: u32) -> String {
	// (one per function: written into its string, no formatting machinery
	// and no string of its own for each number)
	let mut mark = String::with_capacity(key.len() + 2 * BASE36_DIGITS + 6);
	mark.push_str("/*");
	mark.push_str(key);
	mark.push('.');
	push_base36(&mut mark, start);
	mark.push('.');
	push_base36(&mut mark, end - start);
	mark.push_str("*/");
	mark
}

/// the characters a kept text cannot carry in a block comment on one line
const CARRIED: [char; 6] = ['*', '<', '\n', '\r', '\u{2028}', '\u{2029}'];
/// what stands for them: characters scripts do not contain
const STAND_INS: [u8; 29] = [
	1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
	29, 30, 31, 127,
];

/// where the stand-ins go on when a text holds nearly every control
/// character (an obfuscated sensor's string tables do): the private use
/// area, from its start, one UTF-16 code unit each
const PRIVATE_USE: std::ops::RangeInclusive<u32> = 0xe000..=0xf8ff;

/// the first stand-ins, which nearly every script holds none of
const FIRST: [char; 6] = {
	let mut first = ['\0'; 6];
	let mut i = 0;
	while i < first.len() {
		first[i] = STAND_INS[i] as char;
		i += 1;
	}
	first
};

/// The statement that hands a script's text to the access API, `api` as
/// the script reaches it (`holderStatement`): None when the text holds
/// every stand-in character
pub fn holder_statement(api: &str, key: &str, text: &str) -> Option<String> {
	let mut out = String::new();
	holder_statement_into(&mut out, api, key, text).then_some(out)
}

/// [`holder_statement`] written at the end of `out` (the text ahead of the
/// script's code, which a copy of a script's length would otherwise be
/// pushed onto): false, with `out` as it was, when the text holds every
/// stand-in character
pub fn holder_statement_into(out: &mut String, api: &str, key: &str, text: &str) -> bool {
	// nearly every script holds none of the first stand-ins, which are then
	// the ones taken: written so in one pass, which finds whether they were
	// right, and written again after the general way's look at the text if
	// not
	let start = out.len();
	if holder_with(out, api, key, text, FIRST) {
		return true;
	}
	out.truncate(start);
	let mut present = [false; 128];
	for byte in text.bytes() {
		if byte < 128 {
			present[byte as usize] = true;
		}
	}
	let mut subs: Vec<char> =
		STAND_INS.iter().filter(|code| !present[**code as usize]).take(CARRIED.len()).map(|code| *code as char).collect();
	if subs.len() < CARRIED.len() {
		// (the private use characters the text holds are looked for only here)
		let mut held = vec![false; (PRIVATE_USE.end() - PRIVATE_USE.start() + 1) as usize];
		for c in text.chars() {
			if PRIVATE_USE.contains(&u32::from(c)) {
				held[(u32::from(c) - PRIVATE_USE.start()) as usize] = true;
			}
		}
		subs.extend(
			PRIVATE_USE
				.filter(|code| !held[(code - PRIVATE_USE.start()) as usize])
				.take(CARRIED.len() - subs.len())
				.filter_map(char::from_u32),
		);
	}
	let Ok(subs) = subs.try_into() else {
		return false;
	};
	holder_with(out, api, key, text, subs);
	true
}

/// what each byte is to the holder's copy of a text: 0 copied as it is,
/// 1 to 4 the carried character of that index plus one (`*`, `<`, LF,
/// CR), 5 the first byte of a line or paragraph separator (or of another
/// character), 6 one of the first stand-ins (copied as it is)
const HOLDER_BYTES: [u8; 256] = {
	let mut table = [0u8; 256];
	let mut i = 0;
	while i < CARRIED.len() {
		table[STAND_INS[i] as usize] = 6;
		i += 1;
	}
	table[b'*' as usize] = 1;
	table[b'<' as usize] = 2;
	table[b'\n' as usize] = 3;
	table[b'\r' as usize] = 4;
	table[0xe2] = 5;
	table
};

/// whether any byte of `word` may be one [`HOLDER_BYTES`] does not copy as
/// it is: below 0x0e (the first stand-ins, LF, CR, and the tab and the
/// rest of the controls, which the byte loop then looks at and copies), `*`,
/// `<`, or no ASCII. Exact for the word as a whole (a borrow can only run
/// past a byte that is found anyway), so a word it passes is copied whole
#[inline(always)]
fn holder_word(word: u64) -> bool {
	const ONES: u64 = 0x0101_0101_0101_0101;
	let zero = |x: u64| x.wrapping_sub(ONES) & !x & HIGH;
	let below = word.wrapping_sub(ONES * 0x0e) & !word & HIGH;
	(word & HIGH) | below | zero(word ^ (ONES * u64::from(b'*'))) | zero(word ^ (ONES * u64::from(b'<'))) != 0
}

/// the holder of `text` with `subs` standing for the carried characters,
/// written at the end of `out`, and whether the text holds none of the first
/// stand-ins
fn holder_with(out: &mut String, api: &str, key: &str, text: &str, subs: [char; 6]) -> bool {
	out.reserve(text.len() + 96);
	holder_head(out, api, key, &subs);
	// a byte at a time: every carried character but the two separators is
	// one ASCII byte, and those two are the only characters whose UTF-8
	// starts E2 80 A8 or E2 80 A9, so the runs between them are copied whole.
	// Eight bytes at a time first where none of them is one to look at,
	// which is most of a script
	let bytes = text.as_bytes();
	let mut clean = true;
	let mut from = 0;
	let mut at = 0;
	while at < bytes.len() {
		if let Some(chunk) = bytes.get(at..at + 8)
			&& !holder_word(u64::from_le_bytes(chunk.try_into().unwrap()))
		{
			at += 8;
			continue;
		}
		// the word that holds one, a byte at a time (a separator that starts
		// in it may end past it)
		let end = (at + 8).min(bytes.len());
		while at < end {
			let carried = match HOLDER_BYTES[bytes[at] as usize] {
				0 => {
					at += 1;
					continue;
				}
				5 if bytes.get(at + 1) == Some(&0x80) && matches!(bytes.get(at + 2), Some(0xa8 | 0xa9)) => {
					4 + usize::from(bytes[at + 2] == 0xa9)
				}
				5 => {
					at += 1;
					continue;
				}
				6 => {
					clean = false;
					at += 1;
					continue;
				}
				class => usize::from(class - 1),
			};
			out.push_str(&text[from..at]);
			out.push(subs[carried]);
			at += if carried < 4 { 1 } else { 3 };
			from = at;
		}
	}
	out.push_str(&text[from..]);
	out.push_str(HOLDER_TAIL);
	clean
}

/// what the holder writes ahead of the text: the call that hands it over
fn holder_head(out: &mut String, api: &str, key: &str, subs: &[char; 6]) {
	// (an optional call of the API where it is, as the walk's own calls
	// reach it: config.rs `api`; a realm without the inject has none)
	out.push_str(api);
	out.push_str("?.src(");
	out.push_str(&quote(key));
	out.push(',');
	out.push_str(&quote(&subs.iter().collect::<String>()));
	out.push_str(",function(){/*");
}

/// what the holder writes behind the text
const HOLDER_TAIL: &str = "*/});";

/// the room the holder of `text` takes where it has the first stand-ins,
/// which nearly every one has: what it writes ahead, the text's length (a
/// carried character's stand-in is one byte, a separator's of three) and
/// what it writes behind
pub fn holder_room(api: &str, key: &str, text: &str) -> usize {
	let mut head = String::new();
	holder_head(&mut head, api, key, &FIRST);
	head.len() + text.len() + HOLDER_TAIL.len()
}

/// `text` as a JavaScript string literal, spelled as JSON.stringify spells
/// it (and the two line separators escaped, which a script's line cannot
/// hold before ES2019)
pub fn quote(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	out.push('"');
	// a byte at a time, the runs with nothing to escape copied whole: what
	// is escaped is ASCII but for the two separators (E2 80 A8, E2 80 A9)
	let bytes = text.as_bytes();
	let mut from = 0;
	let mut at = 0;
	while at < bytes.len() {
		let byte = bytes[at];
		let escape = match byte {
			b'"' => "\\\"",
			b'\\' => "\\\\",
			b'\n' => "\\n",
			b'\r' => "\\r",
			b'\t' => "\\t",
			0x08 => "\\b",
			0x0c => "\\f",
			0x00..0x20 => "",
			0xe2 if bytes.get(at + 1) == Some(&0x80) && matches!(bytes.get(at + 2), Some(0xa8 | 0xa9)) => {
				if bytes[at + 2] == 0xa8 { "\\u2028" } else { "\\u2029" }
			}
			_ => {
				at += 1;
				continue;
			}
		};
		out.push_str(&text[from..at]);
		if escape.is_empty() {
			out.push_str("\\u00");
			out.push(char::from_digit(u32::from(byte) >> 4, 16).unwrap());
			out.push(char::from_digit(u32::from(byte) & 15, 16).unwrap());
			at += 1;
		} else {
			out.push_str(escape);
			at += if byte == 0xe2 { 3 } else { 1 };
		}
		from = at;
	}
	out.push_str(&text[from..]);
	out.push('"');
	out
}

fn base36(n: u32) -> String {
	let mut out = String::new();
	push_base36(&mut out, n);
	out
}

/// the most digits a `u32` takes in base 36
const BASE36_DIGITS: usize = 7;

/// `n` in base 36 (lower case, no leading zeros) at the end of `out`
fn push_base36(out: &mut String, mut n: u32) {
	let mut digits = [0u8; BASE36_DIGITS];
	let mut at = BASE36_DIGITS;
	loop {
		let d = (n % 36) as u8;
		at -= 1;
		digits[at] = if d < 10 { b'0' + d } else { b'a' + d - 10 };
		n /= 36;
		if n == 0 {
			break;
		}
	}
	for digit in &digits[at..] {
		out.push(char::from(*digit));
	}
}

/// the first byte at or past `at` that is no ASCII, or the end: eight
/// bytes at a time while none of them is
fn next_wide(bytes: &[u8], mut at: usize) -> usize {
	while let Some(chunk) = bytes.get(at..at + 8) {
		let word = u64::from_le_bytes(chunk.try_into().unwrap());
		if word & 0x8080_8080_8080_8080 != 0 {
			break;
		}
		at += 8;
	}
	while at < bytes.len() && bytes[at] < 0x80 {
		at += 1;
	}
	at
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
		// a byte at a time: a character's first byte says how wide it is
		// in both (two or three bytes one unit, four bytes two), and the
		// UTF-16 offset is the byte offset less what the wide characters
		// before it took beyond that
		let bytes = text.as_bytes();
		let mut taken = 0u32;
		let mut at = 0;
		while at < bytes.len() {
			let lead = bytes[at];
			if lead < 0x80 {
				at = next_wide(bytes, at + 1);
				continue;
			}
			let (byte_len, utf16_len) = match lead {
				0xc0..0xe0 => (2u8, 1u8),
				0xe0..0xf0 => (3, 1),
				_ => (4, 2),
			};
			wide.push(Wide {
				byte: at as u32,
				utf16: at as u32 - taken,
				byte_len,
				utf16_len,
			});
			taken += u32::from(byte_len - utf16_len);
			at += usize::from(byte_len);
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
		assert_eq!(function_mark("k", 0, u32::MAX), "/*k.0.1z141z3*/");
		fn radix(mut n: u32) -> String {
			let mut digits = Vec::new();
			loop {
				digits.push(char::from_digit(n % 36, 36).unwrap());
				n /= 36;
				if n == 0 {
					break digits.iter().rev().collect();
				}
			}
		}
		for n in (0..5000).chain(u32::MAX - 5000..=u32::MAX).chain((0..32).map(|bit| 1 << bit)) {
			assert_eq!(base36(n), radix(n), "{n}");
		}
	}

	// what holderStatement gives (node, 2026-11-10)
	#[test]
	fn holders_match_the_typescript() {
		assert_eq!(
			holder_statement("0..$s$j", "k", "a*b<c\nd").unwrap(),
			"0..$s$j?.src(\"k\",\"\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\",function(){/*a\u{1}b\u{2}c\u{3}d*/});"
		);
		// a text that holds every ASCII stand-in (an obfuscated sensor's
		// string tables) takes them from the private use area, skipping
		// those it holds
		let all: String = STAND_INS.iter().map(|code| *code as char).collect();
		assert_eq!(
			holder_statement("0..$s$j", "k", &format!("{all}*<\n")).unwrap(),
			format!(
				"0..$s$j?.src(\"k\",\"\u{e000}\u{e001}\u{e002}\u{e003}\u{e004}\u{e005}\",function(){{/*{all}\u{e000}\u{e001}\u{e002}*/}});"
			)
		);
		let most: String = all.chars().filter(|c| *c != '\u{7}' && *c != '\u{8}').collect();
		assert_eq!(
			holder_statement("0..$s$j", "k", &format!("{most}\u{e000}\r\u{2029}")).unwrap(),
			format!(
				"0..$s$j?.src(\"k\",\"\\u0007\\b\u{e001}\u{e002}\u{e003}\u{e004}\",function(){{/*{most}\u{e000}\u{e002}\u{e004}*/}});"
			)
		);
		let every: String = all.chars().chain((0xe000..=0xf8ff).filter_map(char::from_u32)).collect();
		assert!(holder_statement("0..$s$j", "k", &every).is_none());
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

	// the byte-wise holder, quote and offsets answer what a character at a
	// time does, on texts with every kind of character they treat apart
	#[test]
	fn byte_wise_matches_char_wise() {
		fn quote_chars(text: &str) -> String {
			let mut out = String::from('"');
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
					c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
					c => out.push(c),
				}
			}
			out.push('"');
			out
		}
		fn key_units(text: &str) -> String {
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
		fn carried_chars(text: &str, subs: &[char]) -> String {
			text.chars()
				.map(|c| CARRIED.iter().position(|carried| *carried == c).map_or(c, |i| subs[i]))
				.collect()
		}
		let pieces = [
			"a", "*", "<", "\n", "\r", "\u{2028}", "\u{2029}", "\u{2027}", "\u{202a}", "\u{20ac}", "\u{e2}",
			"\u{fc}", "\u{1F600}", "\"", "\\", "\t", "\u{8}", "\u{c}", "\u{1}", "\u{1f}", " ", "x = y;",
		];
		let mut seed = 0x2545_f491u32;
		for _ in 0..4000 {
			let mut text = String::new();
			for _ in 0..(seed % 24) {
				seed ^= seed << 13;
				seed ^= seed >> 17;
				seed ^= seed << 5;
				text.push_str(pieces[(seed % pieces.len() as u32) as usize]);
			}
			assert_eq!(quote(&text), quote_chars(&text), "{text:?}");
			assert_eq!(source_key(&text), key_units(&text), "{text:?}");
			// the room the output gives the holder is what it takes, or more
			// (a separator's stand-in is shorter), where the first stand-ins do
			if !text.bytes().any(|byte| (1..=6).contains(&byte)) {
				let holder = holder_statement("0..$s$j", "k", &text).unwrap();
				assert!(holder.len() <= holder_room("0..$s$j", "k", &text), "{text:?}");
			}
			if let Some(holder) = holder_statement("0..$s$j", "k", &text) {
				let body = &holder[holder.find(",function(){/*").unwrap() + 14..holder.len() - 5];
				let subs_text = &holder[holder.find("\",\"").unwrap() + 3..holder.find(",function").unwrap() - 1];
				let subs: Vec<char> = subs_text
					.split("\\u")
					.filter(|code| !code.is_empty())
					.map(|code| char::from_u32(u32::from_str_radix(code, 16).unwrap()).unwrap())
					.collect();
				assert_eq!(body, carried_chars(&text, &subs), "{text:?}");
			}
			let o = Utf16Offsets::new(&text);
			let mut utf16 = 0;
			for (byte, c) in text.char_indices() {
				assert_eq!(o.convert(byte as u32), utf16, "{text:?} at {byte}");
				utf16 += c.len_utf16() as u32;
			}
			assert_eq!(o.convert(text.len() as u32), utf16, "{text:?} at its end");
		}
	}

	#[test]
	fn a_line_separator_is_one_unit() {
		let o = Utf16Offsets::new("x\u{2028}y");
		assert_eq!(o.convert(1), 1);
		assert_eq!(o.convert(4), 2);
		assert_eq!(o.convert(5), 3);
	}
}
