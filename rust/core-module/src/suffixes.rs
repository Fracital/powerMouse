//! The public suffix lookup's exports (`suffix`, whose `lib.rs` says what a
//! call takes and answers; the host side is src/wasm/suffix.ts through
//! src/wasm/module.ts), under the letter `d` (`lib.rs` here):
//!
//! - `da(len) -> ptr`: `len` bytes for the host to write, for the call that
//!   follows. They are a buffer kept from call to call, as are the input's
//!   UTF-16 units, so a lookup allocates nothing; one a long input grew is
//!   given back after its call.
//! - `dr(ptr, len, flags) -> status`: answers for the text in those bytes
//!   and keeps the answer until the next call.
//! - `dp()`, `dn()`: the answer's pointer and length.
//!
//! A host is asked about the same few hosts with every request: the buffer
//! of a host name is a few hundred bytes at most.

use std::cell::UnsafeCell;

use suffix::{Output, answer_into};

/// a kept buffer that grew past this is given back after the call
const KEPT: usize = 64 * 1024;

struct State {
	output: Output,
	input: Vec<u8>,
	units: Vec<u16>,
}

struct Slot(UnsafeCell<State>);
// wasm32-unknown-unknown has one thread: the host calls one export at a time
unsafe impl Sync for Slot {}

static STATE: Slot = Slot(UnsafeCell::new(State {
	output: Output::EMPTY,
	input: Vec::new(),
	units: Vec::new(),
}));

fn state() -> &'static mut State {
	// SAFETY: single threaded, and no reference outlives the export call
	unsafe { &mut *STATE.0.get() }
}

/// `len` bytes the host writes, for the `dr` that follows
#[unsafe(export_name = "da")]
pub unsafe extern "C" fn input(len: usize) -> *mut u8 {
	let input = &mut state().input;
	if input.len() < len {
		input.resize(len, 0);
	}
	input.as_mut_ptr()
}

/// the answer for the first `len` bytes `da` gave; `ptr` is where it gave
/// them, and any other is an input this member never handed out (status 1)
#[unsafe(export_name = "dr")]
pub unsafe extern "C" fn call(ptr: *mut u8, len: usize, flags: u32) -> i32 {
	let st = state();
	if len > 0 && (ptr != st.input.as_mut_ptr() || len > st.input.len()) {
		st.output = Output::EMPTY;
		return 1;
	}
	if st.units.len() < len {
		st.units.resize(len, 0);
	}
	let status = answer_into(&mut st.output, &mut st.input[..len], &mut st.units[..len], flags);
	if st.input.len() > KEPT {
		st.input = Vec::new();
		st.units = Vec::new();
	}
	status
}

#[unsafe(export_name = "dp")]
pub unsafe extern "C" fn output() -> *const u8 {
	state().output.as_bytes().as_ptr()
}

#[unsafe(export_name = "dn")]
pub unsafe extern "C" fn length() -> usize {
	state().output.as_bytes().len()
}
