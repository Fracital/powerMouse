//! The JS rewriter's exports (`rwjs`; the host side is src/wasm/rewriter.ts
//! through src/wasm/module.ts), under the letter `j` (`lib.rs`):
//!
//! - `a(len) -> ptr` (shared) gives the host `len` bytes to write into,
//!   owned by the call they are handed to.
//! - `jc(ptr, len) -> status` takes the configuration once per change (the
//!   lines of `rwjs::config`), and owns the bytes from then on.
//! - `jr(ptr, len, flags) -> status` rewrites the script in the bytes
//!   (owned from then on) and keeps the output until the next call. What a
//!   rewrite depends on per script (its URL, the key and shifts of its
//!   marks, the text ahead of its code) comes in a call of its own before
//!   it (`FLAG_PARAMS`, the text of `rewrite::Params`) and holds for one
//!   rewrite; what it found besides the text (`marks<TAB>key`) is asked for
//!   after it (`FLAG_META`). `FLAG_REVISION` answers the revision of what
//!   the module writes, for a cache of rewrites to key on.
//! - `jp()` and `jn()` are the output's pointer and length.
//! - `jb() -> ptr` is the scratch the host answers an `e.j` call in: routing
//!   stays with the host (`route(kind, ptr, len) -> len`), which writes the
//!   routed URL there and answers its length, or -1 when it does not fit.
//!
//! Status 0 is success; any other from a rewrite means the caller runs the
//! JavaScript rewriter on that script. A panic aborts, which the loader
//! sees as a trap and treats as a dead instance.

use std::cell::UnsafeCell;

use rwjs::config::Config;
use rwjs::rewrite::{self, Decline, Options, Params};

use crate::take;

/// the scratch `jb()` hands out, large enough for any URL a page can write
const SCRATCH: usize = 64 * 1024;

/// the flag `jr` takes to answer with the host's routing of the input, the
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
/// print a part of a page's expression the way V8 names it in an error's
/// message (`rwjs::printer`, the port of src/callPrinter.ts): the input is
/// `<part>\n<source>`, the output the printed text, status `STATUS_PARSE` when
/// the source does not parse or the part does not apply (a None told from an
/// empty answer)
const FLAG_PRINT: u32 = 256;

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
		/// `route(kind, ptr, len) -> len`: the host writes into `jb()`
		#[link_name = "j"]
		pub fn route(kind: u32, ptr: *const u8, len: usize) -> i32;
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

#[unsafe(export_name = "jc")]
pub unsafe extern "C" fn configure(ptr: *mut u8, len: usize) -> i32 {
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
	let answered = unsafe { host::route(kind, text.as_ptr(), text.len()) };
	if answered < 0 || answered as usize > SCRATCH {
		return None;
	}
	// (a new borrow: the host wrote the scratch during the call)
	let scratch = &state().scratch[..answered as usize];
	std::str::from_utf8(scratch).ok().map(str::to_owned)
}

#[unsafe(export_name = "jr")]
pub unsafe extern "C" fn call(ptr: *mut u8, len: usize, flags: u32) -> i32 {
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
	if flags & FLAG_PRINT != 0 {
		let (part, text) = source.split_once('\n').unwrap_or((source, ""));
		return match rwjs::printer::print_expression(text, part) {
			Some(printed) => {
				state().output = printed.into_bytes();
				0
			}
			None => STATUS_PARSE,
		};
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

#[unsafe(export_name = "jp")]
pub unsafe extern "C" fn output() -> *const u8 {
	state().output.as_ptr()
}

#[unsafe(export_name = "jn")]
pub unsafe extern "C" fn length() -> usize {
	state().output.len()
}

#[unsafe(export_name = "jb")]
pub unsafe extern "C" fn scratch() -> *mut u8 {
	state().scratch.as_mut_ptr()
}
