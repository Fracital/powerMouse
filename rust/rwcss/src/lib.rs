//! The CSS rewriter and the markup scanner of stomp, built to wasm
//! (docs/rust-plan.md, phase 3), behind the same byte-buffer ABI as the JS
//! rewriter's (`rust/rwjs/src/abi.rs`, loaded by `src/wasm/module.ts`):
//!
//! - `a(len) -> ptr`, `f(ptr, len)`: bytes for the host to write, and back.
//! - `c(ptr, len) -> status`: a configuration; this module has none.
//! - `r(ptr, len, flags) -> status`: answers for the text in the bytes
//!   (owned from then on) and keeps the answer until the next call.
//! - `p()`, `n()`: the answer's pointer and length.
//! - `b() -> ptr`: the scratch the host answers a routing call in.
//! - the import `e.r(kind, ptr, len) -> len`: the host's routing of a URL,
//!   written to the scratch; -1 when it does not route (`abi.rs`).
//!
//! `flags` says what is asked:
//!
//! - 3 a stylesheet, 4 a declaration list, 5 a single value: the answer is
//!   the text rewritten (`rewrite`), every URL routed by the host, byte for
//!   byte what `modifyCSS` and `rewriteCSSValueURLs` give. Status 7 says
//!   the text comes back as it was, and there is no answer to copy.
//! - 2 markup: `B 0` or `B 1` (whether it sets a base URL), then `J`
//!   (script) and `C` (style) lines of `attributesStart attributesEnd
//!   textStart textEnd`, each kind in source order, offsets in UTF-16 units
//!   (what the host slices its string by).
//! - 0 a stylesheet, 1 a declaration list, scanned only: the raw pieces the
//!   rewrite looks into, as lines `V start end` (a declaration's value),
//!   `P start end nameStart nameEnd` (an at-rule's prelude and its name),
//!   `S start end` (a rule's prelude), `R start end` (raw text), in source
//!   order. What a build that rewrote each piece in JavaScript asked for,
//!   kept for it and for telling the scan from the rewrite when they differ.
//!
//! Status 0 is an answer; 5 is declined (JavaScript does this input,
//! `css::Fail::Decline`); 6 is a flag this build does not know; 7 is
//! unchanged. A panic aborts, which the loader sees as a trap and treats as
//! a dead instance.
#![allow(clippy::missing_safety_doc)]

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod css;
pub mod full;
pub mod markup;
pub mod rewrite;

pub const STYLE_SHEET: u32 = 0;
pub const DECLARATION_LIST: u32 = 1;
pub const MARKUP: u32 = 2;
pub const REWRITE_SHEET: u32 = 3;
pub const REWRITE_LIST: u32 = 4;
pub const REWRITE_VALUE: u32 = 5;

pub const DECLINED: i32 = 5;
pub const UNKNOWN: i32 = 6;
pub const UNCHANGED: i32 = 7;

/// Byte offsets into UTF-8 as UTF-16 offsets, asked in rising order: a
/// character is one unit, or two when its first byte says it is four bytes
struct Units<'a> {
	source: &'a [u8],
	byte: usize,
	units: usize,
}

impl Units<'_> {
	fn at(&mut self, offset: usize) -> usize {
		let offset = offset.min(self.source.len());
		if offset < self.byte {
			self.byte = 0;
			self.units = 0;
		}
		for &byte in &self.source[self.byte..offset] {
			self.units += ((byte & 0xC0) != 0x80) as usize + (byte >= 0xF0) as usize;
		}
		self.byte = offset;
		self.units
	}
}

fn number(output: &mut Vec<u8>, mut value: usize) {
	let mut digits = [0u8; 20];
	let mut at = digits.len();
	loop {
		at -= 1;
		digits[at] = b'0' + (value % 10) as u8;
		value /= 10;
		if value == 0 {
			break;
		}
	}
	output.push(b' ');
	output.extend_from_slice(&digits[at..]);
}

/// The answer for `input` under `flags`, or the status that declines it
pub fn answer(input: &[u8], flags: u32) -> Result<Vec<u8>, i32> {
	let mut output = Vec::new();
	let mut units = Units {
		source: input,
		byte: 0,
		units: 0,
	};
	match flags {
		STYLE_SHEET | DECLARATION_LIST => {
			let pieces = css::scan(input, flags == DECLARATION_LIST).map_err(|_| DECLINED)?;
			for piece in pieces {
				output.push(piece.kind);
				if piece.kind == css::PRELUDE {
					// the name stands before its prelude
					let name = (units.at(piece.name.0), units.at(piece.name.1));
					number(&mut output, units.at(piece.start));
					number(&mut output, units.at(piece.end));
					number(&mut output, name.0);
					number(&mut output, name.1);
				} else {
					number(&mut output, units.at(piece.start));
					number(&mut output, units.at(piece.end));
				}
				output.push(b'\n');
			}
		}
		MARKUP => {
			output.extend_from_slice(if markup::has_base(input) { b"B 1\n" } else { b"B 0\n" });
			for (kind, name) in [(b'J', &b"script"[..]), (b'C', &b"style"[..])] {
				for element in markup::elements(input, name) {
					output.push(kind);
					number(&mut output, units.at(element.attributes.0));
					number(&mut output, units.at(element.attributes.1));
					number(&mut output, units.at(element.text.0));
					number(&mut output, units.at(element.text.1));
					output.push(b'\n');
				}
			}
		}
		_ => return Err(UNKNOWN),
	}
	Ok(output)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn offsets_are_utf16() {
		// é is one unit, the emoji two
		let answered = answer("a{b:'é\u{1F600}' url(x)}".as_bytes(), 0).unwrap();
		assert_eq!(String::from_utf8(answered).unwrap(), "V 4 16\n");
	}

	#[test]
	fn markup_answers_base_scripts_and_styles() {
		let answered = answer(b"<style>a</style><script x>b</script>", 2).unwrap();
		assert_eq!(
			String::from_utf8(answered).unwrap(),
			"B 0\nJ 23 25 26 27\nC 6 6 7 8\n"
		);
	}

	#[test]
	fn a_declined_sheet_and_an_unknown_flag() {
		assert_eq!(answer("&{".repeat(70).as_bytes(), 0), Err(5));
		assert_eq!(answer(b"", 9), Err(6));
	}
}
