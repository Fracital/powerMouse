//! The JS rewriter of stomp, built to wasm (docs/rust-plan.md). `abi` is the
//! wasm boundary (byte buffers under single-letter names, wasm32 only, so
//! the rest tests natively), `rewrite` the parse and the walk that make the
//! edits, `source` the function marks and keys of src/functionSource.ts.
#![allow(clippy::missing_safety_doc)]

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod rewrite;
pub mod source;
