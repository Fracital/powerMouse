//! The wasm boundary (docs/rust-plan.md, section 6; the host side is
//! src/wasm/module.ts). Byte buffers and single-letter names, hand written
//! rather than wasm-bindgen's, so the artifact survives a host's renaming
//! and same-length substitution of its names and needs no glue of its own:
//!
//! - `a(len) -> ptr` gives the host `len` bytes to write into; `f(ptr, len)`
//!   gives them back when the host does not pass them on.
//! - `c(ptr, len) -> status` takes the configuration once per change (the
//!   lines of `config`), and owns the bytes from then on.
//! - `r(ptr, len, flags) -> status` rewrites the script in the bytes (owned
//!   from then on) and keeps the output until the next call. What a rewrite
//!   depends on per script (its URL, the key and shifts of its marks, the
//!   text ahead of its code) comes in a call of its own before it
//!   (`FLAG_PARAMS`, the text of `rewrite::Params`) and holds for one
//!   rewrite; what it found besides the text (`marks<TAB>key`) is asked for
//!   after it (`FLAG_META`). `FLAG_REVISION` answers the revision of what
//!   the module writes, for a cache of rewrites to key on.
//! - `p()` and `n()` are the output's pointer and length.
//! - `b() -> ptr` is the scratch the host answers an `e.r` call in: routing
//!   stays with the host (`route(kind, ptr, len) -> len`), which writes the
//!   routed URL there and answers its length, or -1 when it does not fit.
//!
//! Status 0 is success; any other from a rewrite means the caller runs the
//! JavaScript rewriter on that script. A panic aborts, which the loader
//! sees as a trap and treats as a dead instance.

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;

use crate::config::Config;
use crate::rewrite::{self, Decline, Options, Params};

/// the scratch `b()` hands out, large enough for any URL a page can write
const SCRATCH: usize = 64 * 1024;

/// the flag `r` takes to answer with the host's routing of the input, the
/// boundary's round trip through `e.r`
const FLAG_ROUTE: u32 = 1;
/// the script is a module (strict, `import`/`export`, top-level await)
const FLAG_MODULE: u32 = 2;

/// the rewriter runs where no page does: the output hands the script's text
/// to the access API when a function of it is marked
const FLAG_HOLDER: u32 = 4;
/// the input is the next rewrite's `Params`, not a script
const FLAG_PARAMS: u32 = 8;
/// answer what the last rewrite found besides its text: `marks<TAB>key`
const FLAG_META: u32 = 16;

/// answer the revision of what this module writes (`rewrite::REVISION`)
const FLAG_REVISION: u32 = 32;

/// answer whether the input parses as a classic script: `1` or `0`
const FLAG_PARSES: u32 = 64;
/// answer whether the input is a script of one expression statement
const FLAG_SINGLE: u32 = 128;

/// statuses besides 0: the configuration or the params did not parse
const STATUS_CONFIG: i32 = 1;
/// the host could not route a URL
const STATUS_ROUTE: i32 = 2;
/// the input is not UTF-8
const STATUS_UTF8: i32 = 3;
/// the parser could not make a program of the input
const STATUS_PARSE: i32 = 4;
/// a shape this rewriter leaves to the JavaScript one
const STATUS_SHAPE: i32 = 5;
/// the edits did not nest: a bug in the walk, and the output would not be
/// the page's program
const STATUS_EDITS: i32 = 6;
/// a script no browser runs: the caller hands it back as it was
const STATUS_INVALID: i32 = 7;

mod host {
	#[link(wasm_import_module = "e")]
	unsafe extern "C" {
		/// `route(kind, ptr, len) -> len`: the host writes into `b()`
		pub fn r(kind: u32, ptr: *const u8, len: usize) -> i32;
	}
}

struct State {
	config: Config,
	params: Params,
	meta: String,
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
		config: Config::default(),
		params: Params::default(),
		meta: String::new(),
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
	let bytes = unsafe { take(ptr, len) };
	let st = state();
	st.output = Vec::new();
	let Ok(text) = std::str::from_utf8(&bytes) else {
		return STATUS_UTF8;
	};
	match Config::parse(text) {
		Ok(config) => {
			st.config = config;
			0
		}
		Err(_) => STATUS_CONFIG,
	}
}

/// the host's answer to `e.r` for `text`, read out of the scratch
fn route(kind: u32, text: &str) -> Option<String> {
	let answered = unsafe { host::r(kind, text.as_ptr(), text.len()) };
	if answered < 0 || answered as usize > SCRATCH {
		return None;
	}
	// (a new borrow: the host wrote the scratch during the call)
	let scratch = &state().scratch[..answered as usize];
	std::str::from_utf8(scratch).ok().map(str::to_owned)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn r(ptr: *mut u8, len: usize, flags: u32) -> i32 {
	let input = unsafe { take(ptr, len) };
	state().output = Vec::new();
	if flags & FLAG_META != 0 {
		let st = state();
		st.output = st.meta.clone().into_bytes();
		return 0;
	}
	if flags & FLAG_REVISION != 0 {
		state().output = rewrite::REVISION.as_bytes().to_vec();
		return 0;
	}
	// the bytes are validated once, here; nothing downstream assumes UTF-8
	let Ok(source) = std::str::from_utf8(&input) else {
		return STATUS_UTF8;
	};
	if flags & FLAG_ROUTE != 0 {
		return match route(0, source) {
			Some(routed) => {
				state().output = routed.into_bytes();
				0
			}
			None => STATUS_ROUTE,
		};
	}
	if flags & (FLAG_PARSES | FLAG_SINGLE) != 0 {
		let answer = rewrite::parses(source, flags & FLAG_SINGLE != 0);
		state().output = vec![if answer { b'1' } else { b'0' }];
		return 0;
	}
	if flags & FLAG_PARAMS != 0 {
		return match Params::parse(source) {
			Ok(params) => {
				state().params = params;
				0
			}
			Err(()) => STATUS_CONFIG,
		};
	}
	// the params hold for one rewrite: a caller that sends none gets none
	let params = std::mem::take(&mut state().params);
	let config = state().config.clone();
	let options = Options {
		module: flags & FLAG_MODULE != 0,
		holder: flags & FLAG_HOLDER != 0,
		config: &config,
		params: &params,
	};
	let st = state();
	st.meta = String::new();
	let mut route = |kind: u32, text: &str| route(kind, text);
	match rewrite::rewrite(source, &options, &mut route) {
		Ok(output) => {
			let st = state();
			st.meta = format!("{}\t{}", output.marks, output.key);
			st.output = output.text.into_bytes();
			0
		}
		Err(Decline::Parse) => STATUS_PARSE,
		Err(Decline::Shape) => STATUS_SHAPE,
		Err(Decline::Invalid) => STATUS_INVALID,
		Err(Decline::Route) => STATUS_ROUTE,
		Err(Decline::Edits) => STATUS_EDITS,
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
