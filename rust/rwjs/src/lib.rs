//! The JS rewriter of stomp, built to wasm (docs/rust-plan.md). `abi` is the
//! wasm boundary (byte buffers under single-letter names, wasm32 only, so
//! the rest tests natively), `rewrite` the parse and what goes around the
//! walk, `walk` the rewrites of src/rewriteJS.ts as edits at the tree's
//! spans, `shape` the questions they ask of a node, `early` the early errors
//! a browser refuses a script for, `config` what a host hands over, `source`
//! the function marks and keys of src/functionSource.ts.
#![allow(clippy::missing_safety_doc)]

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod config;
pub mod early;
pub mod rewrite;
pub mod shape;
pub mod source;
pub mod walk;
