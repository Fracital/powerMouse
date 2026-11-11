//! The JS rewriter of stomp, built to wasm as a member of the one module
//! (docs/rust-plan.md; its wasm boundary is `rust/core-module/src/rewriter.rs`,
//! so all of this tests natively). `rewrite` the parse and what goes around
//! the walk, `walk` the rewrites of src/rewriteJS.ts as edits at the tree's
//! spans, `shape` the questions they ask of a node, `early` the early errors
//! a browser refuses a script for, `config` what a host hands over, `source`
//! the function marks and keys of src/functionSource.ts.
pub mod config;
pub mod early;
pub mod pattern;
pub mod rewrite;
pub mod shape;
pub mod source;
pub mod walk;
