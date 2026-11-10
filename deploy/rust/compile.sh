#!/bin/bash
# Runs inside the toolchain container (build.sh puts it there with the
# workspace): builds one crate of rust/ to wasm32, with the standard library
# rebuilt for size and without panic locations or Debug formatting (nothing
# of the build's paths or the crate's panics in the bytes), runs wasm-opt
# with the debug and producers sections stripped, and leaves the result at
# /work/out/<name>.wasm. Arguments: crate name, output name.
set -euo pipefail
crate=$1
name=$2
cd /work/rust

expected="${RUST_NIGHTLY:?}"
version=$(rustc --version)
case "$version" in
*"$expected"*) ;;
*)
	echo "toolchain is not the pinned nightly $expected: $version" >&2
	exit 1
	;;
esac

export RUSTFLAGS='-Zlocation-detail=none -Zfmt-debug=none'
cargo build --locked --release --target wasm32-unknown-unknown \
	-Z build-std=std,panic_abort -Z build-std-features=optimize_for_size \
	-p "$crate"

built="target/wasm32-unknown-unknown/release/${crate//-/_}.wasm"
mkdir -p /work/out
if [[ -f "$crate/bindgen" ]]; then
	# a crate built with wasm-bindgen: the glue and the module, the module's
	# name made neutral and the glue told so (it must never read
	# import.meta.url: the loader hands it the module)
	wasm-bindgen --target web --out-dir /work/out --out-name "$name" "$built"
	sed -i 's/import\.meta\.url/""/g' "/work/out/$name.js"
	mv "/work/out/${name}_bg.wasm" "/work/out/$name.unopt.wasm"
else
	cp "$built" "/work/out/$name.unopt.wasm"
fi

wasm-opt -Oz --strip-debug --strip-producers --strip-target-features \
	--enable-bulk-memory --enable-nontrapping-float-to-int \
	--enable-sign-ext --enable-mutable-globals \
	-o "/work/out/$name.wasm" "/work/out/$name.unopt.wasm"
rm "/work/out/$name.unopt.wasm"
ls -la /work/out
