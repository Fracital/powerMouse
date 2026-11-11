//! The built-in blocker's wasm boundary (docs/rust-plan.md, section 8):
//! Brave's `adblock` crate behind the buffer ABI the rewriter speaks
//! (rust/rwjs, src/wasm/module.ts), so the artifact survives a host's
//! renaming and same-length substitution of its names and needs no glue of
//! its own. The host side is src/blocker/.
//!
//! - `a(len) -> ptr` gives the host `len` bytes to write into; `f(ptr, len)`
//!   gives them back when the host does not pass them on.
//! - `c(ptr, len) -> status` takes a configuration (unused today, kept for
//!   the ABI's shape); it owns the bytes from then on.
//! - `r(ptr, len, flags) -> status` runs the operation the low byte of
//!   `flags` names on the bytes (owned from then on) and keeps the output
//!   until the next call; `p()` and `n()` are the output's pointer and
//!   length.
//! - `b() -> ptr` is the scratch the host answers an `e.r` call in. The one
//!   import is the public suffix list: `r(1, ptr, len) -> len` takes a
//!   hostname and the host writes its registrable domain (eTLD+1) into the
//!   scratch and answers its length, or -1 for none. The service worker
//!   already carries tldts for its cookie jar and partitions, so the list is
//!   not compiled in twice (the crate's own would be the `addr` crate).
//!
//! Operations (the low byte of `flags`):
//!
//! | op | input                                       | output                      |
//! | -- | ------------------------------------------- | --------------------------- |
//! | 1  | a filter list's text (bit 8: trusted, 9: hosts format) | nothing          |
//! | 2  | nothing: build the engine from the lists added  | the serialized engine   |
//! | 3  | a serialized engine                          | nothing                    |
//! | 4  | the resources (JSON, Brave's format)         | nothing                    |
//! | 5  | `url \t source \t type \t method`            | the verdict (JSON)         |
//! | 6  | the same                                     | CSP directives, or nothing |
//! | 7  | a document's URL                             | its cosmetic resources (JSON) |
//! | 8  | `{"classes", "ids", "exceptions"}` (JSON)    | selectors to hide (JSON)   |
//! | 9  | nothing: drop the engine and the lists       | nothing                    |
//!
//! Status 0 is success; 1 is no engine, 2 a malformed input, 3 a build or
//! load that failed. A panic aborts, which the loader sees as a trap and
//! treats as a dead instance (it makes another from the compiled module and
//! loads the serialized engine again).
#![allow(clippy::missing_safety_doc)]

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;
use std::collections::HashSet;

use adblock::Engine;
use adblock::FilterSet;
use adblock::lists::{FilterFormat, ParseOptions};
use adblock::request::Request;
use adblock::resources::{PermissionMask, Resource};
use adblock::url_parser::{ResolvesDomain, set_domain_resolver};

/// the scratch `b()` hands out, large enough for any hostname
const SCRATCH: usize = 64 * 1024;

const OP_ADD_LIST: u32 = 1;
const OP_BUILD: u32 = 2;
const OP_LOAD: u32 = 3;
const OP_RESOURCES: u32 = 4;
const OP_CHECK: u32 = 5;
const OP_CSP: u32 = 6;
const OP_COSMETIC: u32 = 7;
const OP_CLASS_IDS: u32 = 8;
const OP_DROP: u32 = 9;

/// a list the host marks as trusted: its `+js(trusted-*)` scriptlets run
const FLAG_TRUSTED: u32 = 1 << 8;
/// a list in hosts-file format
const FLAG_HOSTS: u32 = 1 << 9;

const STATUS_NO_ENGINE: i32 = 1;
const STATUS_INPUT: i32 = 2;
const STATUS_FAILED: i32 = 3;

/// the permission a trusted list's rules carry, and a `trusted-*` resource asks for
const TRUSTED: PermissionMask = PermissionMask::from_bits(1);

mod host {
	#[link(wasm_import_module = "e")]
	unsafe extern "C" {
		/// `r(kind, ptr, len) -> len`: the host writes into `b()`
		pub fn r(kind: u32, ptr: *const u8, len: usize) -> i32;
	}
}

/// the public suffix list, answered by the host through `e.r`
struct HostResolver;

impl ResolvesDomain for HostResolver {
	fn get_host_domain(&self, host: &str) -> (usize, usize) {
		if host.is_empty() {
			return (0, 0);
		}
		let answered = unsafe { host::r(1, host.as_ptr(), host.len()) };
		if answered <= 0 || answered as usize > host.len() {
			return (0, host.len());
		}
		let domain = &state().scratch[..answered as usize];
		if host.as_bytes().ends_with(domain) {
			(host.len() - domain.len(), host.len())
		} else {
			(0, host.len())
		}
	}
}

struct State {
	output: Vec<u8>,
	scratch: Vec<u8>,
	/// the lists added since the last build or drop
	lists: Option<FilterSet>,
	engine: Option<Engine>,
	/// the resources, kept to be given to the next engine as well
	resources: Vec<Resource>,
}

struct Slot(UnsafeCell<Option<State>>);
// wasm32-unknown-unknown has one thread: the host calls one export at a time
unsafe impl Sync for Slot {}

static STATE: Slot = Slot(UnsafeCell::new(None));

fn state() -> &'static mut State {
	// SAFETY: single threaded, and no reference outlives the export call
	let slot = unsafe { &mut *STATE.0.get() };
	slot.get_or_insert_with(|| {
		let _ = set_domain_resolver(Box::new(HostResolver));
		State {
			output: Vec::new(),
			scratch: vec![0; SCRATCH],
			lists: None,
			engine: None,
			resources: Vec::new(),
		}
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
	let _config = unsafe { take(ptr, len) };
	state().output = Vec::new();
	0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn r(ptr: *mut u8, len: usize, flags: u32) -> i32 {
	let input = unsafe { take(ptr, len) };
	let st = state();
	st.output = Vec::new();
	match flags & 0xff {
		OP_ADD_LIST => add_list(st, input, flags),
		OP_BUILD => build(st),
		OP_LOAD => load(st, &input),
		OP_RESOURCES => resources(st, &input),
		OP_CHECK => check(st, &input, false),
		OP_CSP => check(st, &input, true),
		OP_COSMETIC => cosmetic(st, &input),
		OP_CLASS_IDS => class_ids(st, &input),
		OP_DROP => {
			st.lists = None;
			st.engine = None;
			0
		}
		_ => STATUS_INPUT,
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

fn add_list(st: &mut State, input: Vec<u8>, flags: u32) -> i32 {
	let Ok(text) = String::from_utf8(input) else {
		return STATUS_INPUT;
	};
	let set = st.lists.get_or_insert_with(|| FilterSet::new(false));
	set.add_filter_list(
		text,
		ParseOptions {
			format: if flags & FLAG_HOSTS != 0 {
				FilterFormat::Hosts
			} else {
				FilterFormat::Standard
			},
			permissions: if flags & FLAG_TRUSTED != 0 {
				TRUSTED
			} else {
				PermissionMask::default()
			},
			..ParseOptions::default()
		},
	);
	0
}

fn build(st: &mut State) -> i32 {
	let Some(set) = st.lists.take() else {
		return STATUS_INPUT;
	};
	let mut engine = Engine::new_with_filter_set(set);
	engine.use_resources(st.resources.iter().cloned());
	st.output = engine.serialize();
	st.engine = Some(engine);
	0
}

fn load(st: &mut State, input: &[u8]) -> i32 {
	let mut engine = Engine::default();
	if engine.deserialize(input).is_err() {
		return STATUS_FAILED;
	}
	engine.use_resources(st.resources.iter().cloned());
	st.engine = Some(engine);
	0
}

fn resources(st: &mut State, input: &[u8]) -> i32 {
	let Ok(mut parsed) = serde_json::from_slice::<Vec<Resource>>(input) else {
		return STATUS_INPUT;
	};
	// uBO's resource file marks the scriptlets only a trusted list may use
	// by name; Brave's format carries no permission for them, so the mark
	// is put back here, and only a list the host marked trusted gets them
	for resource in &mut parsed {
		if resource.name.starts_with("trusted-") {
			resource.permission = resource.permission | TRUSTED;
		}
	}
	if let Some(engine) = st.engine.as_mut() {
		engine.use_resources(parsed.iter().cloned());
	}
	st.resources = parsed;
	0
}

/// `url \t source \t type \t method`, as the host sends a request
fn request_of(input: &[u8]) -> Option<Request> {
	let text = std::str::from_utf8(input).ok()?;
	let mut parts = text.splitn(4, '\t');
	let url = parts.next()?;
	let source = parts.next()?;
	let kind = parts.next()?;
	let method = parts.next().unwrap_or("get");
	Request::new(url, source, kind, method).ok()
}

fn check(st: &mut State, input: &[u8], csp: bool) -> i32 {
	let Some(engine) = st.engine.as_ref() else {
		return STATUS_NO_ENGINE;
	};
	let Some(request) = request_of(input) else {
		return STATUS_INPUT;
	};
	if csp {
		if let Some(directives) = engine.get_csp_directives(&request) {
			st.output = directives.into_bytes();
		}
		return 0;
	}
	let result = engine.check_network_request(&request);
	let mut out = serde_json::Map::new();
	if result.should_block() {
		out.insert("block".into(), true.into());
	}
	if let Some(redirect) = result.redirect {
		out.insert("redirect".into(), redirect.into());
	}
	if let Some(url) = result.rewritten_url {
		out.insert("url".into(), url.into());
	}
	st.output = serde_json::Value::Object(out).to_string().into_bytes();
	0
}

fn cosmetic(st: &mut State, input: &[u8]) -> i32 {
	let Some(engine) = st.engine.as_ref() else {
		return STATUS_NO_ENGINE;
	};
	let Ok(url) = std::str::from_utf8(input) else {
		return STATUS_INPUT;
	};
	let resources = engine.url_cosmetic_resources(url);
	match serde_json::to_vec(&resources) {
		Ok(json) => {
			st.output = json;
			0
		}
		Err(_) => STATUS_FAILED,
	}
}

#[derive(serde::Deserialize)]
struct ClassIds {
	#[serde(default)]
	classes: Vec<String>,
	#[serde(default)]
	ids: Vec<String>,
	#[serde(default)]
	exceptions: HashSet<String>,
}

fn class_ids(st: &mut State, input: &[u8]) -> i32 {
	let Some(engine) = st.engine.as_ref() else {
		return STATUS_NO_ENGINE;
	};
	let Ok(asked) = serde_json::from_slice::<ClassIds>(input) else {
		return STATUS_INPUT;
	};
	let selectors = engine.hidden_class_id_selectors(&asked.classes, &asked.ids, &asked.exceptions);
	match serde_json::to_vec(&selectors) {
		Ok(json) => {
			st.output = json;
			0
		}
		Err(_) => STATUS_FAILED,
	}
}
