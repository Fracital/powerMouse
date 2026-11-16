#!/bin/bash
# Runs inside the fixture's build image (build.sh copies the crate to
# /work/wtserver): unpacks and patches the crates patches/crates names,
# builds the crate for wasm32 (--locked), runs wasm-bindgen's web target
# with the glue told never to read import.meta.url, and wasm-opt with
# deploy/rust's flags. Leaves wtserver.js and wtserver.wasm in out/.
set -euo pipefail
cd /work/wtserver

expected="${RUST_NIGHTLY:?}"
version=$(rustc --version)
case "$version" in
*"$expected"*) ;;
*)
	echo "toolchain is not the pinned nightly $expected: $version" >&2
	exit 1
	;;
esac

# the crates built with a patch of ours, each checked against the checksum
# its Cargo.lock entry had; the download is kept in the registry volume
cache=/usr/local/cargo/registry/wtserver-crates
mkdir -p "$cache"
rm -rf patched
mkdir -p patched
while read -r name version sum; do
	case "$name" in '' | '#'*) continue ;; esac
	crate="$cache/$name-$version.crate"
	if [[ ! -f $crate ]]; then
		curl -fsSL "https://static.crates.io/crates/$name/$name-$version.crate" -o "$crate.part"
		mv "$crate.part" "$crate"
	fi
	echo "$sum  $crate" | sha256sum -c - >/dev/null
	mkdir "patched/$name"
	tar xzf "$crate" -C "patched/$name" --strip-components=1
	patch -d "patched/$name" -p1 --no-backup-if-mismatch -s < "patches/$name-$version.patch"
done < patches/crates

# LOCK=1 lets cargo resolve a changed dependency (build.sh copies the
# lockfile back)
locked=--locked
if [[ ${LOCK:-0} == 1 ]]; then locked=; fi
cargo build $locked --release --target wasm32-unknown-unknown

rm -rf out
mkdir -p out
wasm-bindgen --target web --out-dir out --out-name wtserver \
	target/wasm32-unknown-unknown/release/wtserver.wasm
sed -i 's/import\.meta\.url/""/g' out/wtserver.js
# generated: not held to the repository's lint rules
sed -i '1i /* eslint-disable */' out/wtserver.js
wasm-opt -Oz --converge --strip-debug --strip-producers --strip-target-features \
	--enable-bulk-memory --enable-nontrapping-float-to-int \
	--enable-sign-ext --enable-mutable-globals \
	-o out/wtserver.wasm out/wtserver_bg.wasm
rm out/wtserver_bg.wasm out/*.d.ts
ls -la out
