//! The one wasm module of stomp's own crates (docs/rust-plan.md, "One
//! module, many realms"): the JS rewriter (`rwjs`), the CSS rewriter and
//! markup scanner (`rwcss`) and the public suffix lookup (`suffix`), each a
//! member behind the byte-buffer ABI under a letter of its own, in one
//! memory with one allocator. The host side is `src/wasm/module.ts`, which
//! gives each member a view of the instance that reads its exports by
//! those letters.
//!
//! | Export          | Member   | Meaning                                       |
//! | --------------- | -------- | --------------------------------------------- |
//! | `memory`        | all      | the memory                                    |
//! | `a`             | j, s     | `alloc(len) -> ptr`, owned by the call after  |
//! | `jc`            | rewriter | `configure(ptr, len) -> status`               |
//! | `jr`            | rewriter | `call(ptr, len, flags) -> status`             |
//! | `jp`, `jn`      | rewriter | the answer's pointer and length               |
//! | `jb`            | rewriter | the scratch its routing call is answered in   |
//! | `sr`            | scanner  | `call(ptr, len, flags) -> status`, a scan     |
//! | `si`, `sx`      | scanner  | its kept input buffer, and the rewrite of it  |
//! | `ss`            | scanner  | the scratch its routing call is answered in   |
//! | `sp`, `sn`      | scanner  | the answer's pointer and length               |
//! | `da`            | suffix   | its kept input buffer, at least `len` bytes   |
//! | `dr`            | suffix   | `call(ptr, len, flags) -> status`             |
//! | `dp`, `dn`      | suffix   | the answer's pointer and length               |
//!
//! Imports: `e.j(kind, ptr, len) -> len`, the host's routing of a URL the
//! rewriter asks for, and `e.s`, the same for the scanner (`rewriter.rs`,
//! `scanner.rs` say where each answer is written). The suffix lookup imports
//! nothing.
//!
//! What a call takes and answers is each member's own (`rewriter.rs`,
//! `scanner.rs`, `suffixes.rs`), and so is its state: a member keeps its
//! answer, buffers and configuration apart from the others', so the host can
//! call one member from inside another's routing call. Only the allocator
//! and the stack are shared.
//! A panic aborts, which the host sees as a trap: it takes the whole
//! instance for dead, every member with it, and makes a fresh one from the
//! same compiled module.
//!
//! A new member (the URL codec) is a module here with exports under a
//! letter of its own, a line in `abi.json` and a view in the host.
#![allow(clippy::missing_safety_doc)]

#[cfg(target_arch = "wasm32")]
mod rewriter;
#[cfg(target_arch = "wasm32")]
mod scanner;
#[cfg(target_arch = "wasm32")]
mod suffixes;

#[cfg(target_arch = "wasm32")]
use std::alloc::{Layout, alloc};

/// `len` bytes the host writes, owned by the call they are handed to
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn a(len: usize) -> *mut u8 {
	if len == 0 {
		return std::ptr::null_mut();
	}
	let layout = Layout::from_size_align(len, 1).unwrap();
	unsafe { alloc(layout) }
}

/// the bytes `a` gave, as a Vec that frees them
#[cfg(target_arch = "wasm32")]
unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
	if len == 0 || ptr.is_null() {
		return Vec::new();
	}
	unsafe { Vec::from_raw_parts(ptr, len, len) }
}
