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

# the crates built from published source plus a patch of ours
# (rust/patches/): rust/patched/<name>, which rust/Cargo.toml names
bash /work/patches.sh

# what the artifact is built from, for its provenance (inputs.sh);
# ONLY_SOURCES=1 stops there, with nothing built
mkdir -p /work/out
if [[ ${ONLY_SOURCES:-0} == 1 ]]; then
	bash /work/inputs.sh "$crate" > "/work/out/$name.inputs"
	exit 0
fi

# LOCK=1 lets cargo resolve a changed dependency and write the lockfile,
# which build.sh copies back to be committed with the change
locked=--locked
if [[ ${LOCK:-0} == 1 ]]; then locked=; fi

# the target triple: wasm32-unknown-unknown unless the crate names another
# in rust/<crate>/wasm-target (wasm32-wasip1 for one that takes a clock and
# randomness through a WASI shim)
triple=wasm32-unknown-unknown
if [[ -f "$crate/wasm-target" ]]; then
	triple=$(tr -d '[:space:]' < "$crate/wasm-target")
fi

# no panic location, no Debug formatting, plus the flags the crate names in
# rust/<crate>/rustflags (`-Cpanic=immediate-abort` for one whose
# dependencies can panic: the panic machinery and its messages, "panicked
# at", stay out of the bytes and a panic is a plain trap; `-Copt-level=3`
# for the core module, which is optimized for speed over the size the
# workspace profile asks, since it is the rewrite hot path)
flags='-Zlocation-detail=none -Zfmt-debug=none'
if [[ -f "$crate/rustflags" ]]; then
	flags="$flags $(tr '\n' ' ' < "$crate/rustflags")"
fi

export RUSTFLAGS=$flags
# the standard library is rebuilt for size, unless the crate opts into speed
# (rust/<crate>/speed): the core module's code runs std hot (the rewriters'
# allocation, the scanner, the function marks), so it takes the larger,
# faster build of std and the faster opt-level its rustflags name, where the
# WebRTC and blocker artifacts stay on the small build
buildstd='-Z build-std=std,panic_abort -Z build-std-features=optimize_for_size'
if [[ -f "$crate/speed" ]]; then
	buildstd='-Z build-std=std,panic_abort'
fi
# shellcheck disable=SC2086
cargo build $locked --release --target "$triple" \
	$buildstd \
	-p "$crate"

built="target/$triple/release/${crate//-/_}.wasm"
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

# wasm-opt optimizes for size, unless the crate opts into speed
# (rust/<crate>/speed): -O2 keeps the faster opt-level 3 codegen where -Oz
# would trade some of it back for bytes
wopt=-Oz
if [[ -f "$crate/speed" ]]; then
	wopt=-O2
fi
wasm-opt "$wopt" --strip-debug --strip-producers --strip-target-features \
	--enable-bulk-memory --enable-nontrapping-float-to-int \
	--enable-sign-ext --enable-mutable-globals \
	-o "/work/out/$name.wasm" "/work/out/$name.unopt.wasm"
rm "/work/out/$name.unopt.wasm"
# after the build, so the lockfile is the one it resolved (LOCK=1)
bash /work/inputs.sh "$crate" > "/work/out/$name.inputs"
ls -la /work/out
