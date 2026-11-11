#!/bin/bash
# Build one crate of rust/ to a wasm artifact in the pinned toolchain
# container and put it in assets/, checked (deploy/rust/check.mjs) and with
# its provenance beside it. Usage:
#
#   deploy/rust/build.sh <crate> <name>     e.g. build.sh rwjs rewriter
#
# gives assets/<name>.wasm, assets/<name>.wasm.sha256 and
# assets/<name>.UPSTREAM. ONLY_SOURCES=1 builds nothing and prints the
# `sources` line the tree as it stands would get (to compare with the one
# in assets/<name>.UPSTREAM). ENGINE names the container engine or a wrapper
# around it (one that adds --network host where the bridge has no DNS); the
# toolchain image is built once per pins.env and Dockerfile and reused.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
crate=${1:?crate name}
name=${2:?output name}
[[ -d "$root/rust/$crate" ]] || { echo "no crate rust/$crate" >&2; exit 1; }

# shellcheck disable=SC1091
source "$here/pins.env"

engine=${ENGINE:-}
if [[ -z $engine ]]; then
	for t in docker podman; do
		if "$t" info >/dev/null 2>&1; then
			engine=$t
			break
		fi
	done
fi
[[ -n $engine ]] || { echo "no working container engine (docker or podman)" >&2; exit 1; }

tag="stomp-rust-toolchain:$(cat "$here/Dockerfile" "$here/pins.env" | sha256sum | cut -c1-12)"
if ! "$engine" image inspect "$tag" >/dev/null 2>&1; then
	"$engine" build \
		--build-arg "RUST_IMAGE=$RUST_IMAGE" \
		--build-arg "BINARYEN=$BINARYEN" \
		--build-arg "BINARYEN_SHA256=$BINARYEN_SHA256" \
		--build-arg "WASM_BINDGEN=$WASM_BINDGEN" \
		--build-arg "WASM_BINDGEN_SHA256=$WASM_BINDGEN_SHA256" \
		-t "$tag" "$here"
fi

# the workspace goes in by copy (no bind mounts: docker's filesystem here
# is not this machine's), without a target/ a host build may have left
# the crate registry is a named volume, a cache across builds and crates:
# --locked makes the build the same with or without it
id=$("$engine" create --network host -e "RUST_NIGHTLY=$RUST_NIGHTLY" \
	-e "LOCK=${LOCK:-0}" -e "ONLY_SOURCES=${ONLY_SOURCES:-0}" \
	-v stomp-cargo-registry:/usr/local/cargo/registry "$tag" \
	bash /work/compile.sh "$crate" "$name")
trap '"$engine" rm -f "$id" >/dev/null' EXIT
tmp=$(mktemp -d)
mkdir -p "$tmp/rust"
(cd "$root/rust" && tar --exclude=./target -cf - .) | tar -xf - -C "$tmp/rust"
"$engine" cp "$tmp/rust" "$id:/work/rust"
"$engine" cp "$here/compile.sh" "$id:/work/compile.sh"
"$engine" cp "$here/inputs.sh" "$id:/work/inputs.sh"
rm -rf "$tmp"
"$engine" start -a "$id"

out="$here/out"
rm -rf "$out"
mkdir -p "$out"
"$engine" cp "$id:/work/out/." "$out/"
# What the artifact is built from, as one hash: the crate's own files, the
# workspace crates it depends on by path, the dependencies cargo resolved
# for it and the release profile (inputs.sh, from inside the container),
# then the pins and the two scripts that turn them into bytes. Not the
# whole workspace: another crate's sources, or a lockfile entry only
# another crate uses, do not change this artifact's line.
sources=$({
	cat "$out/$name.inputs"
	echo pins
	grep -v '^#' "$here/pins.env" | grep .
	echo scripts
	cat "$here/compile.sh" "$here/inputs.sh" | sha256sum | cut -d' ' -f1
} | sha256sum | cut -c1-12)
if [[ ${ONLY_SOURCES:-0} == 1 ]]; then
	echo "sources $sources"
	exit 0
fi

# LOCK=1: the lockfile the build resolved comes back (a dependency changed)
if [[ ${LOCK:-0} == 1 ]]; then
	"$engine" cp "$id:/work/rust/Cargo.lock" "$root/rust/Cargo.lock"
	echo "rust/Cargo.lock updated"
fi

node "$here/check.mjs" "$out/$name.wasm" "$root/rust/$crate/abi.json"

mkdir -p "$root/assets"
cp "$out/$name.wasm" "$root/assets/$name.wasm"
if [[ -f "$out/$name.js" ]]; then cp "$out/$name.js" "$root/assets/$name.js"; fi
(cd "$root/assets" && sha256sum "$name.wasm" > "$name.wasm.sha256")
{
	echo "crate rust/$crate"
	echo "sources $sources"
	echo "toolchain $tag"
	grep -v '^#' "$here/pins.env" | grep .
	# what the crate itself pins (the suffix crate's list)
	if [[ -f "$root/rust/$crate/src/pins.env" ]]; then
		grep -v '^#' "$root/rust/$crate/src/pins.env" | grep .
	fi
	echo "built $(date -u +%Y-%m-%d)"
} > "$root/assets/$name.UPSTREAM"
echo
echo "assets/$name.wasm: $(stat -c %s "$root/assets/$name.wasm") bytes"
