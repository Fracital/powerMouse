//! Whether a regular expression literal's pattern compiles, asked of each
//! literal by the rewrite's walk (the parser is not asked to parse
//! patterns: it would build a tree of every one). A pattern of the plainest
//! kind, which compiles under its flags, is answered by a scan of its text;
//! any other is handed to the parser on its own (`/pattern/flags`, a script
//! of the one literal) with patterns parsed, so the answer is the parser's.
use oxc::allocator::Allocator;
use oxc::parser::{ParseOptions, Parser};
use oxc::span::SourceType;

/// whether the literal `/pattern/flags` (as written) compiles
pub fn compiles(allocator: &Allocator, literal: &str) -> bool {
	let (pattern, flags) = literal[1..].rsplit_once('/').unwrap_or((&literal[1..], ""));
	plain(pattern, flags) || parsed(allocator, literal)
}

/// what the parser makes of the literal when it parses its pattern
fn parsed(allocator: &Allocator, literal: &str) -> bool {
	let parsed = Parser::new(allocator, literal, SourceType::cjs())
		.with_options(ParseOptions {
			parse_regular_expression: true,
			..ParseOptions::default()
		})
		.parse();
	!parsed.fatal_error && !parsed.diagnostics.has_errors()
}

/// whether `pattern` is of the plainest kind, which compiles: what this
/// scan does not know is left to the parser (`false` is no verdict). It
/// reads alternatives of characters, `.`, the common escapes, classes of
/// characters and ranges in order, groups, non-capturing groups and
/// lookaheads (which take no quantifier here), and quantifiers on what can
/// take one; under `u` only what that flag allows of those, and nothing
/// under `v`.
pub fn plain(pattern: &str, flags: &str) -> bool {
	if flags.bytes().any(|flag| flag == b'v') {
		return false;
	}
	let unicode = flags.bytes().any(|flag| flag == b'u');
	let bytes = pattern.as_bytes();
	let mut at = 0;
	// open groups, and which of them are lookaheads (a bit each)
	let mut depth = 0u32;
	let mut lookaheads = 0u64;
	// whether the term before can take a quantifier
	let mut quantifiable = false;
	while at < bytes.len() {
		let byte = bytes[at];
		match byte {
			b'\\' => {
				let Some(&escaped) = bytes.get(at + 1) else {
					return false;
				};
				match escaped {
					// assertions
					b'b' | b'B' => {
						quantifiable = false;
						at += 2;
					}
					b'd' | b'D' | b'w' | b'W' | b's' | b'S' | b't' | b'n' | b'v' | b'f' | b'r' | b'^' | b'$'
					| b'\\' | b'.' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'|' | b'/' => {
						quantifiable = true;
						at += 2;
					}
					b'0' if !bytes.get(at + 2).is_some_and(u8::is_ascii_digit) => {
						quantifiable = true;
						at += 2;
					}
					// a reference or a legacy octal escape: without `u` both
					// compile, whatever the groups (Annex B)
					b'0'..=b'9' if !unicode => {
						at += 2;
						while bytes.get(at).is_some_and(u8::is_ascii_digit) {
							at += 1;
						}
						quantifiable = true;
					}
					b'x' | b'u' => {
						let Some((end, _)) = hex_escape(bytes, at, unicode) else {
							return false;
						};
						quantifiable = true;
						at = end;
					}
					// an identity escape: any punctuation but under `u`
					escaped if !unicode && identity(escaped) => {
						quantifiable = true;
						at += 2;
					}
					_ => return false,
				}
			}
			b'^' | b'$' | b'|' => {
				quantifiable = false;
				at += 1;
			}
			b'(' => {
				if depth >= 63 {
					return false;
				}
				// (a lookbehind is a lookaround as a lookahead is; a named group
				// is the parser's to answer)
				let (lookahead, length) = match bytes.get(at + 1) {
					Some(b'?') => match bytes.get(at + 2) {
						Some(b':') => (false, 3),
						Some(b'=' | b'!') => (true, 3),
						Some(b'<') if matches!(bytes.get(at + 3), Some(b'=' | b'!')) => (true, 4),
						_ => return false,
					},
					_ => (false, 1),
				};
				at += length;
				depth += 1;
				if lookahead {
					lookaheads |= 1 << depth;
				} else {
					lookaheads &= !(1 << depth);
				}
				quantifiable = false;
			}
			b')' => {
				if depth == 0 {
					return false;
				}
				// (a lookahead takes a quantifier only without `u`: the
				// parser's to answer)
				quantifiable = lookaheads & (1 << depth) == 0;
				depth -= 1;
				at += 1;
			}
			// without `u` a `{` that starts no count is a character
			b'{' if !unicode && !bytes.get(at + 1).is_some_and(u8::is_ascii_digit) => {
				quantifiable = true;
				at += 1;
			}
			b'*' | b'+' | b'?' | b'{' => {
				if !quantifiable {
					return false;
				}
				if byte == b'{' {
					let Some(end) = braces(bytes, at) else {
						return false;
					};
					at = end;
				} else {
					at += 1;
				}
				// lazy
				if bytes.get(at) == Some(&b'?') {
					at += 1;
				}
				quantifiable = false;
			}
			b'[' => {
				let Some(end) = class(bytes, at, unicode) else {
					return false;
				};
				at = end;
				quantifiable = true;
			}
			// (characters without `u`)
			b']' | b'}' if unicode => return false,
			byte if byte < 0x80 => {
				quantifiable = true;
				at += 1;
			}
			// a character of more than one byte
			_ => {
				let Some(character) = pattern[at..].chars().next() else {
					return false;
				};
				quantifiable = true;
				at += character.len_utf8();
			}
		}
	}
	depth == 0
}

/// punctuation that escapes to itself without `u` (Annex B)
fn identity(byte: u8) -> bool {
	matches!(
		byte,
		b'!' | b'"' | b'#' | b'%' | b'&' | b'\'' | b',' | b'-' | b':' | b';' | b'<' | b'=' | b'>' | b'@' | b'_' | b'`' | b'~'
	)
}

/// `\xHH`, `\uHHHH` or (under `u`) `\u{H...}` at `at`: where it ends, and
/// the unit or the character it stands for
fn hex_escape(bytes: &[u8], at: usize, unicode: bool) -> Option<(usize, u32)> {
	let value = |from: usize, to: usize| -> Option<u32> {
		u32::from_str_radix(std::str::from_utf8(&bytes[from..to]).ok()?, 16).ok()
	};
	if unicode && bytes.get(at + 1)? == &b'u' && bytes.get(at + 2)? == &b'{' {
		let mut end = at + 3;
		while bytes.get(end).is_some_and(u8::is_ascii_hexdigit) {
			end += 1;
		}
		if end == at + 3 || end - (at + 3) > 6 || bytes.get(end)? != &b'}' {
			return None;
		}
		let character = value(at + 3, end)?;
		return (character <= 0x10_ffff).then_some((end + 1, character));
	}
	let digits = if bytes.get(at + 1)? == &b'x' { 2 } else { 4 };
	let end = at + 2 + digits;
	if bytes.len() < end || !bytes[at + 2..end].iter().all(u8::is_ascii_hexdigit) {
		return None;
	}
	Some((end, value(at + 2, end)?))
}

/// `{n}`, `{n,}`, `{n,m}` with `n <= m`, at `at`: where it ends
fn braces(bytes: &[u8], at: usize) -> Option<usize> {
	let digits = |from: usize| {
		let mut end = from;
		while end < bytes.len() && bytes[end].is_ascii_digit() {
			end += 1;
		}
		// (a count past what fits is the parser's to answer)
		(end > from && end - from <= 9).then(|| {
			let value: u32 = std::str::from_utf8(&bytes[from..end]).ok()?.parse().ok()?;
			Some((end, value))
		})?
	};
	let (end, low) = digits(at + 1)?;
	match bytes.get(end)? {
		b'}' => Some(end + 1),
		b',' => {
			if bytes.get(end + 1)? == &b'}' {
				return Some(end + 2);
			}
			let (end, high) = digits(end + 1)?;
			(bytes.get(end)? == &b'}' && low <= high).then_some(end + 1)
		}
		_ => None,
	}
}

/// a class (`[...]`) at `at` of characters, escapes and ranges in order:
/// where it ends
fn class(bytes: &[u8], at: usize, unicode: bool) -> Option<usize> {
	let mut at = at + 1;
	if bytes.get(at) == Some(&b'^') {
		at += 1;
	}
	// the last atom's value, when it is one a range may end at
	let mut last: Option<u32> = None;
	// a `-` follows `last`: the next atom ends a range
	let mut dash = false;
	loop {
		let byte = *bytes.get(at)?;
		let atom: Option<u32> = match byte {
			b']' => {
				// (`[a-]`: the dash was a character)
				return (!dash).then_some(at + 1);
			}
			b'\\' => {
				let escaped = *bytes.get(at + 1)?;
				match escaped {
					b'd' | b'D' | b'w' | b'W' | b's' | b'S' => {
						at += 2;
						None
					}
					b't' => {
						at += 2;
						Some(0x09)
					}
					b'n' => {
						at += 2;
						Some(0x0a)
					}
					b'v' => {
						at += 2;
						Some(0x0b)
					}
					b'f' => {
						at += 2;
						Some(0x0c)
					}
					b'r' => {
						at += 2;
						Some(0x0d)
					}
					b'b' => {
						at += 2;
						Some(0x08)
					}
					b'0' if !bytes.get(at + 2).is_some_and(u8::is_ascii_digit) => {
						at += 2;
						Some(0)
					}
					b'x' | b'u' => {
						let (end, mut value) = hex_escape(bytes, at, unicode)?;
						at = end;
						// under `u` an escaped lead surrogate and an escaped
						// trail one are one character
						if unicode
							&& (0xd800..0xdc00).contains(&value)
							&& bytes.get(at) == Some(&b'\\')
							&& bytes.get(at + 1) == Some(&b'u')
							&& bytes.get(at + 2) != Some(&b'{')
							&& let Some((end, trail)) = hex_escape(bytes, at, unicode)
							&& (0xdc00..0xe000).contains(&trail)
						{
							at = end;
							value = 0x10000 + ((value - 0xd800) << 10) + (trail - 0xdc00);
						}
						Some(value)
					}
					b'^' | b'$' | b'\\' | b'.' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']' | b'{' | b'}'
					| b'|' | b'/' | b'-' => {
						at += 2;
						Some(u32::from(escaped))
					}
					escaped if !unicode && identity(escaped) => {
						at += 2;
						Some(u32::from(escaped))
					}
					_ => return None,
				}
			}
			b'-' if last.is_some() && !dash && bytes.get(at + 1) != Some(&b']') => {
				dash = true;
				at += 1;
				continue;
			}
			byte if byte < 0x80 => {
				at += 1;
				Some(u32::from(byte))
			}
			_ => {
				// a character of more than one byte, in no range
				if dash {
					return None;
				}
				let mut end = at + 1;
				while end < bytes.len() && bytes[end] & 0xc0 == 0x80 {
					end += 1;
				}
				at = end;
				if bytes.get(at) == Some(&b'-') && bytes.get(at + 1) != Some(&b']') {
					return None;
				}
				last = None;
				continue;
			}
		};
		match (atom, dash) {
			// a range: in order, of characters
			(Some(atom), true) => {
				if last? > atom {
					return None;
				}
				dash = false;
				last = None;
			}
			// a class escape ends no range and starts none
			(None, true) => return None,
			(None, false) => {
				if bytes.get(at) == Some(&b'-') && bytes.get(at + 1) != Some(&b']') {
					return None;
				}
				last = None;
			}
			(Some(atom), false) => last = Some(atom),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// whether a `/` stands unescaped outside a class
	fn bare_slash(pattern: &str) -> bool {
		let mut escaped = false;
		let mut class = false;
		for byte in pattern.bytes() {
			match (escaped, byte) {
				(true, _) => escaped = false,
				(false, b'\\') => escaped = true,
				(false, b'[') => class = true,
				(false, b']') => class = false,
				(false, b'/') if !class => return true,
				_ => {}
			}
		}
		false
	}

	/// what the parser makes of a pattern
	fn parses(pattern: &str, flags: &str) -> bool {
		parsed(&Allocator::default(), &format!("/{pattern}/{flags}"))
	}

	#[test]
	fn the_plain_kind_is_what_the_parser_takes() {
		for pattern in [
			"^[A-Z]", "\\\\", "\\s", "\\n", "_", "\\/", "^[a-z]:$", "\\r\\n?", "-", "[^\\n]", "a{2,3}?", "(?:a|b)+",
			"\\d{4}-\\d{2}", "[\\w.-]+@", "^\\s+|\\s+$", "[a-z0-9_]",
		] {
			assert!(plain(pattern, "g"), "{pattern}");
			assert!(parses(pattern, "g"), "{pattern}");
		}
		for pattern in ["a{2,1}", "[z-a]", "(a", "a)", "*a", "a**", "^*", "(?<a>b)", "[\\d-z]", "a{99999999999}"] {
			assert!(!plain(pattern, ""), "{pattern}");
		}
		assert!(plain("a", "u") && !plain("a", "v"));
		assert!(!plain("\\-", "u") && plain("\\-", ""));
		// without `u` a reference compiles whatever the groups; under it
		// the groups decide
		assert!(plain("\\1", "") && !plain("\\1", "u"));
	}

	#[test]
	fn the_scan_takes_no_pattern_the_parser_refuses() {
		// a fuzz of patterns from the characters the scan reads: whatever it
		// calls plain the parser takes, under each flag set (no `/` but
		// escaped: as the fuzz composes them one may end the literal; the
		// crate's other tests and its corpus test read real ones)
		let alphabet: Vec<&str> = vec![
			"a", "b", "z", "0", "9", "-", "^", "$", ".", "*", "+", "?", "|", "(", ")", "(?:", "(?=", "[", "]", "{", "}",
			",", "{2}", "{1,3}", "{3,1}", "{2,}", "\\", "\\d", "\\w", "\\s", "\\b", "\\B", "\\0", "\\1", "\\n", "\\/",
			"\\-", "\\]", "\\x", "\\c", " ", "_", "\\x4", "\\x41", "\\x7e", "\\u0041", "\\u00e9", "\\uD800",
			"\\uDC00", "\\u004", "(?!", "\\:", "\\#", "\\a", "\\k", "\\p", "é", "😀", "[é", "[^", ":", "\\12", "\\01", "(?<=", "(?<!", "(?<a>", "\\u{41}",
			"\\u{110000}", "\\u{", "\\uD83D\\uDE00", "\\uDE00", "]", "}", "{a", "{,2}",
		];
		let mut state: u64 = 0x5eed_1234_abcd_0001;
		let mut next = || {
			state ^= state << 13;
			state ^= state >> 7;
			state ^= state << 17;
			state
		};
		let mut plain_ones = 0;
		for _ in 0..400_000 {
			let length = (next() % 8) as usize;
			let mut pattern = String::new();
			for _ in 0..length {
				pattern.push_str(alphabet[(next() % alphabet.len() as u64) as usize]);
			}
			// (no literal has a `/` its own unescaped outside a class: the
			// lexer ends it there)
			if bare_slash(&pattern) {
				continue;
			}
			for flags in ["", "g", "gimsy", "d", "u", "gu", "iu"] {
				if plain(&pattern, flags) {
					plain_ones += 1;
					assert!(parses(&pattern, flags), "/{pattern}/{flags}: the scan takes it, the parser refuses it");
				}
			}
		}
		assert!(plain_ones > 50_000, "{plain_ones}");
	}
}
