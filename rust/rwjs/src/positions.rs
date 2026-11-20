//! The map of a script's output to its text, which the output carries for
//! the positions a page reads (an error's stack, a long animation frame's
//! script, a violation's place): natively places in the page's own text,
//! through the proxy places in the rewrite. src/inject/positionMaps.ts reads
//! it, when one is first asked for.
//!
//! The map goes last in the text ahead of the script's code (after the
//! holder of its text), as one more call of the access API, which a realm
//! without the inject has none of:
//!
//! `0..$s$j?.pos("url","key",function(){/*MAP*/});`
//!
//! `url` is the script's real URL (what its stack frames name, unrouted),
//! `key` the holder's, whose text gives the lines of the page's text, or ''
//! when there is no holder. The map is in a comment of a function's own
//! source, read through the native toString, so nothing is made of it until
//! a position is asked for. It is base64 VLQ numbers
//! (`edits::push_vlq`), positions in UTF-16 units:
//!
//! - the output's position past the text ahead of the code, less the length
//!   of the function the map is in (the map's own length is then no part of
//!   what it says), where that text starts, and the source position it
//!   stands at;
//! - 0, or one more than the number of the source's line ends and the
//!   length of each of its lines, line end included, when there is no holder
//!   to read them from;
//! - the stretches of the output without the text ahead of its code
//!   (`edits::Positions`).
//!
//! Code the inject rewrites (an inline script, a handler, eval) carries no
//! map: its rewrite hands the same map over beside the output
//! ([`write_apart`]), and the inject keeps it by the script V8 runs.

use edits::{Positions, push_vlq};

use crate::source::quote;

/// the length of `text` in UTF-16 units
pub fn utf16_len(text: &str) -> u32 {
	(if text.is_ascii() { text.len() } else { text.encode_utf16().count() }) as u32
}

/// the length of each line of `source` in UTF-16 units, its line end
/// included (LF, CR, CRLF, LS, PS, as V8 counts lines), but the last's, as
/// the map carries them: their count plus one, then each
pub fn line_lengths(source: &str) -> String {
	let mut lengths = Vec::new();
	let mut start = 0u32;
	let mut at = 0u32;
	let bytes = source.as_bytes();
	let mut i = 0;
	// (read by the byte: a character's first byte counts one unit, a
	// four-byte one's two, the bytes after it none)
	const ONES: u64 = 0x0101_0101_0101_0101;
	const HIGH: u64 = 0x8080_8080_8080_8080;
	let zero = |word: u64| word.wrapping_sub(ONES) & !word & HIGH;
	while i < bytes.len() {
		// (eight bytes at once while none ends a line or starts a character
		// past ASCII: a minified script's lines are long)
		if let Some(eight) = bytes.get(i..i + 8) {
			let word = u64::from_le_bytes(eight.try_into().unwrap());
			if (word & HIGH) | zero(word ^ (ONES * u64::from(b'\n'))) | zero(word ^ (ONES * u64::from(b'\r'))) == 0 {
				i += 8;
				at += 8;
				continue;
			}
		}
		let byte = bytes[i];
		i += 1;
		let end = match byte {
			b'\n' => true,
			b'\r' => {
				if bytes.get(i) == Some(&b'\n') {
					i += 1;
					at += 1;
				}
				true
			}
			// LS and PS: E2 80 A8, E2 80 A9
			0xe2 => bytes[i] == 0x80 && matches!(bytes[i + 1], 0xa8 | 0xa9),
			_ => false,
		};
		at += match byte {
			0x80..=0xbf => 0,
			0xf0.. => 2,
			_ => 1,
		};
		if end {
			// (the line ends after LS's or PS's last byte)
			if byte == 0xe2 {
				i += 2;
			}
			lengths.push(at - start);
			start = at;
		}
	}
	let mut out = String::new();
	push_vlq(&mut out, lengths.len() as u64 + 1);
	for length in lengths {
		push_vlq(&mut out, u64::from(length));
	}
	out
}

/// the source of the function the map is in, around the map
const FUNCTION_HEAD: &str = "function(){/*";
const FUNCTION_TAIL: &str = "*/}";
/// the end of the call the function is handed to
const CALL_TAIL: &str = ");";

/// what the map statement writes ahead of the map
fn statement_head(api: &str, url: &str, key: &str) -> String {
	format!("{api}?.pos({},{},{FUNCTION_HEAD}", quote(url), quote(key))
}

/// the room the statement takes: what it writes, `lines` and the stretches,
/// and room for the numbers ahead of them
pub fn statement_room(api: &str, url: &str, key: &str, lines: usize, positions: &Positions) -> usize {
	statement_head(api, url, key).len() + 3 * 7 + lines + positions.runs.len() + FUNCTION_TAIL.len() + CALL_TAIL.len()
}

/// Write the map statement at the end of `out`, whose text ahead of the
/// script's code started at byte `lead_start` (what was written of it
/// before: the lead, the holder). `lines` is [`line_lengths`] of the source
/// or, with a holder, empty
pub fn write_statement(
	out: &mut String,
	lead_start: usize,
	api: &str,
	url: &str,
	key: &str,
	lines: &str,
	positions: &Positions,
) {
	// (the fill is where the text ahead of the code is: in the output
	// without it, and the source position it stands at)
	let (at, stands) = positions.fill.unwrap_or((0, 0));
	let head = statement_head(api, url, key);
	let written = utf16_len(&out[lead_start..]);
	// past the statement, but for the function's own length (`function(){/*`
	// and `*/}` with the map between, as its source reads): what is written
	// of the text ahead of the code, the call's head and its `);`
	let call = utf16_len(&head) - FUNCTION_HEAD.len() as u32;
	let past = at + written + call + CALL_TAIL.len() as u32;
	out.push_str(&head);
	push_vlq(out, u64::from(past));
	push_vlq(out, u64::from(at));
	push_vlq(out, u64::from(stands));
	if lines.is_empty() {
		push_vlq(out, 0);
	} else {
		out.push_str(lines);
	}
	out.push_str(&positions.runs);
	out.push_str(FUNCTION_TAIL);
	out.push_str(CALL_TAIL);
}

/// The map of an output that carries none (`Options::apart`), at the end of
/// `out`: as the statement's, but its first number is the output's
/// position past the text ahead of the code itself (`written` the UTF-16
/// length of that text), and the lines are always there
pub fn write_apart(out: &mut String, written: u32, lines: &str, positions: &Positions) {
	let (at, stands) = positions.fill.unwrap_or((0, 0));
	push_vlq(out, u64::from(at + written));
	push_vlq(out, u64::from(at));
	push_vlq(out, u64::from(stands));
	out.push_str(lines);
	out.push_str(&positions.runs);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn lines_are_counted_as_v8_counts_them() {
		// LF, CRLF (one end), CR, LS, PS, and a last line with no end
		assert_eq!(line_lengths("a\nbb\r\nc\rd\u{2028}e\u{2029}f"), {
			let mut out = String::new();
			for n in [6, 2, 4, 2, 2, 2] {
				push_vlq(&mut out, n);
			}
			out
		});
		// one line: no line end, the count's one
		assert_eq!(line_lengths("abc"), "B");
		// a four-byte character counts two units
		let mut want = String::new();
		push_vlq(&mut want, 2);
		push_vlq(&mut want, 4);
		assert_eq!(line_lengths("\u{1F600}a\nb"), want);
		// two- and three-byte characters (one with LS's first byte) count one
		let mut want = String::new();
		for n in [4, 3, 1, 1] {
			push_vlq(&mut want, n);
		}
		assert_eq!(line_lengths("é\u{20AC}\u{2028}\u{2029}\u{2029}a"), want);
	}
}
