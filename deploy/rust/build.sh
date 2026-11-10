#!/bin/bash
# Build one crate of rust/ to a wasm artifact in the pinned toolchain
# container and put it in assets/, checked (deploy/rust/check.mjs) and with
# its provenance beside it. Usage:
#
#   deploy/rust/build.sh <crate> <name>     e.g. build.sh rwjs rewriter
#
# gives assets/<name>.wasm, assets/<name>.wasm.sha256 and
# assets/<name>.UPSTREAM. ENGINE names the container engine or a wrapper
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
id=$("$engine" create --network host -e "RUST_NIGHTLY=$RUST_NIGHTLY" "$tag" \
	bash /work/compile.sh "$crate" "$name")
trap '"$engine" rm -f "$id" >/dev/null' EXIT
tmp=$(mktemp -d)
mkdir -p "$tmp/rust"
(cd "$root/rust" && tar --exclude=./target -cf - .) | tar -xf - -C "$tmp/rust"
"$engine" cp "$tmp/rust" "$id:/work/rust"
"$engine" cp "$here/compile.sh" "$id:/work/compile.sh"
rm -rf "$tmp"
"$engine" start -a "$id"

out="$here/out"
rm -rf "$out"
mkdir -p "$out"
"$engine" cp "$id:/work/out/." "$out/"

node "$here/check.mjs" "$out/$name.wasm" "$root/rust/$crate/abi.json"

mkdir -p "$root/assets"
cp "$out/$name.wasm" "$root/assets/$name.wasm"
if [[ -f "$out/$name.js" ]]; then cp "$out/$name.js" "$root/assets/$name.js"; fi
(cd "$root/assets" && sha256sum "$name.wasm" > "$name.wasm.sha256")
{
	echo "crate rust/$crate"
	echo "sources $(cd "$root/rust" && cat Cargo.toml Cargo.lock "$crate"/Cargo.toml "$crate"/abi.json "$crate"/src/*.rs | sha256sum | cut -c1-12)"
	echo "toolchain $tag"
	grep -v '^#' "$here/pins.env" | grep .
	echo "built $(date -u +%Y-%m-%d)"
} > "$root/assets/$name.UPSTREAM"
echo
echo "assets/$name.wasm: $(stat -c %s "$root/assets/$name.wasm") bytes"
