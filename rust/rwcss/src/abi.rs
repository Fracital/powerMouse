//! The wasm boundary (`lib.rs` says what crosses it; the host side is
//! `src/wasm/module.ts` and `src/wasm/scanner.ts`).
//!
//! The scratch the host answers a routing call in is 64 KiB, and a routed
//! URL can be longer (a data: URL of a font, kept twice over). So an answer
//! may come in parts: one whose first byte is 1 is a part with more to
//! come, asked for with kind 0 until a part starts with 2, the last. An
//! answer that starts with neither is whole as it stands.

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;

use crate::css::Fail;
use crate::{
	DECLINED, REWRITE_LIST, REWRITE_SHEET, REWRITE_VALUE, UNCHANGED, answer, rewrite,
};

const SCRATCH: usize = 64 * 1024;
/// the kind that asks for the next part of the answer in hand
const MORE: u32 = 0;
const PART: u8 = 1;
const LAST: u8 = 2;
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

mod host {
	#[link(wasm_import_module = "e")]
	unsafe extern "C" {
		/// `route(kind, ptr, len) -> len`: the host writes into `b()`
		pub fn r(kind: u32, ptr: *const u8, len: usize) -> i32;
	}
}

struct State {
	output: Vec<u8>,
	scratch: Vec<u8>,
}

struct Slot(UnsafeCell<Option<State>>);
// wasm32-unknown-unknown has one thread: the host calls one export at a time
unsafe impl Sync for Slot {}

static STATE: Slot = Slot(UnsafeCell::new(None));

fn state() -> &'static mut State {
	// SAFETY: single threaded, and no reference outlives the export call
	let slot = unsafe { &mut *STATE.0.get() };
	slot.get_or_insert_with(|| State {
		output: Vec::new(),
		scratch: vec![0; SCRATCH],
	})
}

/// what the host wrote to the scratch for a call that answered `length`
fn written(length: i32) -> Result<&'static [u8], Fail> {
	if length as usize > SCRATCH {
		return Err(Fail::Decline);
	}
	Ok(&state().scratch[..length as usize])
}

/// `rewrite::Route`, asked of the host
fn route(kind: u32, text: &[u8], routed: &mut Vec<u8>) -> Result<bool, Fail> {
	// the host reads the text through a decoder that drops a byte order
	// mark, and would route another URL than the sheet wrote
	if text.starts_with(BOM) {
		return Err(Fail::Decline);
	}
	routed.clear();
	let length = unsafe { host::r(kind, text.as_ptr(), text.len()) };
	if length < 0 {
		return Ok(false);
	}
	let mut part = written(length)?;
	match part.first() {
		Some(&PART) | Some(&LAST) => loop {
			routed.extend_from_slice(&part[1..]);
			if part[0] == LAST {
				break;
			}
			let length = unsafe { host::r(MORE, text.as_ptr(), 0) };
			if length < 1 {
				return Err(Fail::Decline);
			}
			part = written(length)?;
			if part[0] != PART && part[0] != LAST {
				return Err(Fail::Decline);
			}
		},
		_ => routed.extend_from_slice(part),
	}
	Ok(true)
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
	state().output = Vec::new();
	let answered = match flags {
		REWRITE_SHEET | REWRITE_LIST => {
			match rewrite::rewrite(&input, flags == REWRITE_LIST, &mut route) {
				Ok(Some(output)) => Ok(output),
				Ok(None) => Err(UNCHANGED),
				Err(_) => Err(DECLINED),
			}
		}
		REWRITE_VALUE => match rewrite::rewrite_value(&input, &mut route) {
			Ok(Some(output)) => Ok(output),
			Ok(None) => Err(UNCHANGED),
			Err(_) => Err(DECLINED),
		},
		_ => answer(&input, flags),
	};
	match answered {
		Ok(output) => {
			// the host reads the answer through a decoder that drops a byte
			// order mark and puts back the one the text began with: a rewrite
			// keeps it (nothing is routed before the first token), and one
			// that did not would come back changed
			if flags >= REWRITE_SHEET && input.starts_with(BOM) && !output.starts_with(BOM) {
				return DECLINED;
			}
			state().output = output;
			0
		}
		Err(status) => status,
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn p() -> *const u8 {
	state().output.as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn n() -> usize {
	state().output.len()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn b() -> *mut u8 {
	state().scratch.as_mut_ptr()
}
