#!/bin/bash
# Build stomp-h3 for the browser: wasm32 release build, wasm-bindgen's web
# target, wasm-opt. Runs inside the epoxy build container (Rust nightly,
# wasm32 target, wasm-bindgen 0.2.100, binaryen). Output: $1 (default out/)
# with stomp_h3.js, stomp_h3_bg.wasm and the type declarations.
set -euo pipefail
cd "$(dirname "$0")"
out=${1:-out}

bash vendor.sh
cargo build --locked --release --target wasm32-unknown-unknown
target=${CARGO_TARGET_DIR:-target}
rm -rf "$out"
mkdir -p "$out"
wasm-bindgen --target web --out-dir "$out" --out-name stomp_h3 \
	"$target/wasm32-unknown-unknown/release/stomp_h3.wasm"
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
	--enable-sign-ext --enable-mutable-globals \
	-o "$out/stomp_h3_bg.wasm" "$out/stomp_h3_bg.wasm"
ls -la "$out"
