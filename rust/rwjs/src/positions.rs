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
	let mut chars = source.chars().peekable();
	while let Some(c) = chars.next() {
		at += c.len_utf16() as u32;
		let end = match c {
			'\r' if chars.peek() == Some(&'\n') => {
				chars.next();
				at += 1;
				true
			}
			'\n' | '\r' | '\u{2028}' | '\u{2029}' => true,
			_ => false,
		};
		if end {
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
	}
}
