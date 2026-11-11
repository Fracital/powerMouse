//! The scanners' wasm boundary (docs/rust-plan.md, phase 3): the stylesheet
//! scan (`css`) and the markup scan (`markup`), behind the same byte-buffer
//! ABI as the JS rewriter's (`rust/rwjs/src/lib.rs`, loaded by
//! `src/wasm/module.ts`), with no import: a scan answers where things
//! stand and the JavaScript side does the routing, so nothing calls back.
//!
//! - `a(len) -> ptr`, `f(ptr, len)`: bytes for the host to write, and back.
//! - `c(ptr, len) -> status`: a configuration; the scans have none.
//! - `r(ptr, len, flags) -> status`: scans the text in the bytes (owned from
//!   then on) and keeps the answer until the next call. `flags` says which
//!   scan: 0 a stylesheet, 1 a declaration list, 2 markup.
//! - `p()`, `n()`: the answer's pointer and length. `b()`: no scratch.
//!
//! The answer is lines of ASCII, offsets in UTF-16 units (what the host
//! slices its string by):
//!
//! - a stylesheet or declaration list: `V start end` (a declaration's
//!   value), `P start end nameStart nameEnd` (an at-rule's prelude and its
//!   name), `S start end` (a rule's prelude), `R start end` (raw text), in
//!   source order;
//! - markup: `B 0` or `B 1` (whether it sets a base URL), then `J` (script)
//!   and `C` (style) lines of `attributesStart attributesEnd textStart
//!   textEnd`, each kind in source order.
//!
//! Status 0 is an answer; 5 is declined (the JavaScript scan does this
//! input, `css::Fail::Decline`); 6 is a flag this build does not know. A
//! panic aborts, which the loader sees as a trap and treats as a dead
//! instance.
#![allow(clippy::missing_safety_doc)]

pub mod css;
pub mod markup;

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;

const STYLE_SHEET: u32 = 0;
const DECLARATION_LIST: u32 = 1;
const MARKUP: u32 = 2;

const DECLINED: i32 = 5;
const UNKNOWN: i32 = 6;

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
			if units.at(input.len()) > css::MAX_UNITS {
				return Err(DECLINED);
			}
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

struct Slot(UnsafeCell<Vec<u8>>);
// wasm32-unknown-unknown has one thread: the host calls one export at a time
unsafe impl Sync for Slot {}

static OUTPUT: Slot = Slot(UnsafeCell::new(Vec::new()));

fn output() -> &'static mut Vec<u8> {
	// SAFETY: single threaded, and no reference outlives the export call
	unsafe { &mut *OUTPUT.0.get() }
}

/// `len` bytes the host writes; owned by `f`, `c` or `r`
#[unsafe(no_mangle)]
pub unsafe extern "C" fn a(len: usize) -> *mut u8 {
	if len == 0 {
		return std::ptr::null_mut();
	}
	let layout = Layout::from_size_align(len, 1).unwrap();
	unsafe { alloc(layout) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn f(ptr: *mut u8, len: usize) {
	if len == 0 || ptr.is_null() {
		return;
	}
	let layout = Layout::from_size_align(len, 1).unwrap();
	unsafe { dealloc(ptr, layout) }
}

/// the bytes `a` gave, as a Vec that frees them
unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
	if len == 0 || ptr.is_null() {
		return Vec::new();
	}
	unsafe { Vec::from_raw_parts(ptr, len, len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn c(ptr: *mut u8, len: usize) -> i32 {
	drop(unsafe { take(ptr, len) });
	0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn r(ptr: *mut u8, len: usize, flags: u32) -> i32 {
	let input = unsafe { take(ptr, len) };
	match answer(&input, flags) {
		Ok(answer) => {
			*output() = answer;
			0
		}
		Err(status) => {
			*output() = Vec::new();
			status
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn p() -> *const u8 {
	output().as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn n() -> usize {
	output().len()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn b() -> *mut u8 {
	std::ptr::null_mut()
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
