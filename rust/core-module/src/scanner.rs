//! The CSS rewriter's and markup scanner's exports (`rwcss`, whose `lib.rs`
//! says what crosses; the host side is `src/wasm/scanner.ts` through
//! `src/wasm/module.ts`), under the letter `s` (`lib.rs` here):
//!
//! - `a(len) -> ptr` (shared), then `sr(ptr, len, flags) -> status`: a scan
//!   (flags 0 to 2) of the text in the bytes, owned from then on.
//! - `si(len) -> ptr`, `sx(len, flags) -> status`: a rewrite (flags 3 to 5)
//!   of the text the host wrote into the buffer `si` gave.
//! - `sp()`, `sn()`: the answer's pointer and length.
//! - `ss(len) -> ptr`: the scratch the host answers an `e.s` routing call
//!   in, made at least `len` bytes.
//!
//! A rewrite's text is written by the host straight into a buffer the
//! module keeps from call to call (`si`), and the host's answer to a routing
//! call into a scratch the module sizes to it (`ss`): a routed URL can be
//! long (a data: URL of a font, kept twice over). Neither is allocated per
//! call, which is most of what a rewrite of a few dozen bytes costs.

use std::cell::UnsafeCell;

use rwcss::css::Fail;
use rwcss::{
	REWRITE_LIST, REWRITE_SHEET, REWRITE_VALUE, STUCK, UNCHANGED, UNKNOWN, answer, rewrite,
};

use crate::take;

const SCRATCH: usize = 64 * 1024;
/// a kept buffer that grew past this is given back after the call
const KEPT: usize = 1024 * 1024;

mod host {
	#[link(wasm_import_module = "e")]
	unsafe extern "C" {
		/// `route(kind, ptr, len) -> len`: the host writes into `ss(len)`
		#[link_name = "s"]
		pub fn route(kind: u32, ptr: *const u8, len: usize) -> i32;
	}
}

struct State {
	output: Vec<u8>,
	scratch: Vec<u8>,
	input: Vec<u8>,
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
		input: Vec::new(),
	})
}

/// `rewrite::Route`, asked of the host
fn route(kind: u32, text: &[u8], routed: &mut Vec<u8>) -> Result<bool, Fail> {
	routed.clear();
	let length = unsafe { host::route(kind, text.as_ptr(), text.len()) };
	if length < 0 {
		return Ok(false);
	}
	// read after the call: the host may have had the scratch grow
	let scratch = &state().scratch;
	match scratch.get(..length as usize) {
		Some(answer) => routed.extend_from_slice(answer),
		None => return Err(Fail::Decline),
	}
	if scratch.len() > KEPT {
		state().scratch = vec![0; SCRATCH];
	}
	Ok(true)
}

/// the scan of markup (`rwcss`'s `lib.rs`); a rewrite is asked through
/// `sx`, and a host that asks for one here is told the flag is unknown
#[unsafe(export_name = "sr")]
pub unsafe extern "C" fn call(ptr: *mut u8, len: usize, flags: u32) -> i32 {
	let input = unsafe { take(ptr, len) };
	state().output = Vec::new();
	if flags >= REWRITE_SHEET {
		return UNKNOWN;
	}
	match answer(&input, flags) {
		Ok(output) => {
			state().output = output;
			0
		}
		Err(status) => status,
	}
}

/// the buffer a rewrite's text is written to, at least `len` bytes; what
/// it held is kept when it grows
#[unsafe(export_name = "si")]
pub unsafe extern "C" fn input(len: usize) -> *mut u8 {
	let input = &mut state().input;
	if input.len() < len {
		input.resize(len, 0);
	}
	input.as_mut_ptr()
}

/// the scratch the host answers a routing call in, at least `len` bytes
#[unsafe(export_name = "ss")]
pub unsafe extern "C" fn scratch(len: usize) -> *mut u8 {
	let scratch = &mut state().scratch;
	if scratch.len() < len {
		scratch.resize(len, 0);
	}
	scratch.as_mut_ptr()
}

/// the rewrite (`flags` 3, 4 or 5) of the first `len` bytes of `si`'s buffer
#[unsafe(export_name = "sx")]
pub unsafe extern "C" fn rewrite_input(len: usize, flags: u32) -> i32 {
	// out of the state while the rewrite runs: a routing call reaches the
	// state again for its scratch
	let input = std::mem::take(&mut state().input);
	state().output = Vec::new();
	let text = &input[..len.min(input.len())];
	let rewritten = match flags {
		REWRITE_SHEET | REWRITE_LIST => rewrite::rewrite(text, flags == REWRITE_LIST, &mut route),
		REWRITE_VALUE => rewrite::rewrite_value(text, &mut route),
		_ => {
			state().input = input;
			return UNKNOWN;
		}
	};
	if input.len() <= KEPT {
		state().input = input;
	}
	match rewritten {
		Ok(Some(output)) => {
			state().output = output;
			0
		}
		Ok(None) => UNCHANGED,
		// the parse stopped advancing (or the host's answer to a routing
		// call could not be read, which no host of this build's does)
		Err(_) => STUCK,
	}
}

#[unsafe(export_name = "sp")]
pub unsafe extern "C" fn output() -> *const u8 {
	state().output.as_ptr()
}

#[unsafe(export_name = "sn")]
pub unsafe extern "C" fn length() -> usize {
	state().output.len()
}
