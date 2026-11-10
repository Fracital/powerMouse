//! The wasm boundary (docs/rust-plan.md, section 6; the host side is
//! src/wasm/module.ts). Byte buffers and single-letter names, hand written
//! rather than wasm-bindgen's, so the artifact survives a host's renaming
//! and same-length substitution of its names and needs no glue of its own:
//!
//! - `a(len) -> ptr` gives the host `len` bytes to write into; `f(ptr, len)`
//!   gives them back when the host does not pass them on.
//! - `c(ptr, len) -> status` takes the configuration once per change, and
//!   owns the bytes from then on.
//! - `r(ptr, len, flags) -> status` rewrites the script in the bytes (owned
//!   from then on) and keeps the output until the next call.
//! - `p()` and `n()` are the output's pointer and length.
//! - `b() -> ptr` is the scratch the host answers an `e.r` call in: routing
//!   stays with the host (`route(kind, ptr, len) -> len`), which writes the
//!   routed URL there and answers its length, or -1 when it does not fit.
//!
//! Status 0 is success. A panic aborts, which the loader sees as a trap and
//! treats as a dead instance.

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;

use crate::rewrite;

/// the scratch `b()` hands out, large enough for any URL a page can write
const SCRATCH: usize = 64 * 1024;

/// the flag `r` takes to answer with the host's routing of the input, the
/// boundary's round trip through `e.r`
const FLAG_ROUTE: u32 = 1;
/// the script is a module (strict, `import`/`export`, top-level await)
const FLAG_MODULE: u32 = 2;

/// statuses `r` answers besides 0
const STATUS_ROUTE: i32 = 2;
/// the input is not UTF-8
const STATUS_UTF8: i32 = 3;
/// the parser could not make a program of the input (the caller falls back)
const STATUS_PARSE: i32 = 4;

mod host {
	#[link(wasm_import_module = "e")]
	unsafe extern "C" {
		/// `route(kind, ptr, len) -> len`: the host writes into `b()`
		pub fn r(kind: u32, ptr: *const u8, len: usize) -> i32;
	}
}

struct State {
	config: Vec<u8>,
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
		config: Vec::new(),
		output: Vec::new(),
		scratch: vec![0; SCRATCH],
	})
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
	let config = unsafe { take(ptr, len) };
	let st = state();
	st.config = config;
	st.output = Vec::new();
	0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn r(ptr: *mut u8, len: usize, flags: u32) -> i32 {
	let input = unsafe { take(ptr, len) };
	let st = state();
	st.output = Vec::new();
	if flags & FLAG_ROUTE != 0 {
		let answered = unsafe { host::r(0, input.as_ptr(), input.len()) };
		if answered < 0 || answered as usize > SCRATCH {
			return STATUS_ROUTE;
		}
		st.output = st.scratch[..answered as usize].to_vec();
		return 0;
	}
	// the bytes are validated once, here; nothing downstream assumes UTF-8
	let Ok(source) = std::str::from_utf8(&input) else {
		return STATUS_UTF8;
	};
	let edits = match rewrite::rewrite(source, flags & FLAG_MODULE != 0) {
		Ok(edits) => edits,
		Err(()) => return STATUS_PARSE,
	};
	match edits::apply(source, edits) {
		Ok(output) => {
			st.output = output.into_bytes();
			0
		}
		// a set of edits that does not nest is a bug in the visitor: the
		// caller falls back rather than running something that is not the
		// page's program
		Err(_) => STATUS_PARSE,
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
