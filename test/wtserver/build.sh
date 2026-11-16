#!/bin/bash
# Rebuilds the committed WebTransport fixture server, test/wtserver/wtserver.wasm
# and its wasm-bindgen glue test/wtserver/wtserver.js, and writes PROVENANCE
# (the toolchain, the pins and the sha256 of every input and output). The
# same inputs give the same bytes. Usage:
#
#   test/wtserver/build.sh          (LOCK=1 to resolve a changed dependency
#                                    and copy Cargo.lock back)
#
# The build image is deploy/rust's toolchain image (built here from
# deploy/rust's Dockerfile and pins.env if missing, exactly as
# deploy/rust/build.sh tags it) plus Debian's clang 14 at an exact version
# (test/wtserver/Dockerfile). ENGINE names the container engine or a wrapper
# around it (one that adds --network host where the bridge has no DNS). No
# bind mounts: the crate goes in and the outputs come out by copy. Then the
# glue is formatted with the repository's prettier (node_modules).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
rust="$root/deploy/rust"

# shellcheck disable=SC1091
source "$rust/pins.env"
CLANG=1:14.0.6-12

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

base="stomp-rust-toolchain:$(cat "$rust/Dockerfile" "$rust/pins.env" | sha256sum | cut -c1-12)"
if ! "$engine" image inspect "$base" >/dev/null 2>&1; then
	"$engine" build \
		--build-arg "RUST_IMAGE=$RUST_IMAGE" \
		--build-arg "BINARYEN=$BINARYEN" \
		--build-arg "BINARYEN_SHA256=$BINARYEN_SHA256" \
		--build-arg "WASM_BINDGEN=$WASM_BINDGEN" \
		--build-arg "WASM_BINDGEN_SHA256=$WASM_BINDGEN_SHA256" \
		--build-arg "WASM_SNIP=$WASM_SNIP" \
		-t "$base" "$rust"
fi
tag="stomp-wtserver-build:$({ echo "$base"; echo "$CLANG"; cat "$here/Dockerfile"; } | sha256sum | cut -c1-12)"
if ! "$engine" image inspect "$tag" >/dev/null 2>&1; then
	context=$(mktemp -d)
	cp "$here/Dockerfile" "$context/"
	"$engine" build --build-arg "BASE=$base" --build-arg "CLANG=$CLANG" -t "$tag" "$context"
	rm -rf "$context"
fi

# the crate's sources, nothing a build left behind
inputs=(Cargo.toml Cargo.lock Dockerfile build.sh compile.sh patches/crates)
while IFS= read -r f; do inputs+=("$f"); done < <(cd "$here" && find src patches -type f -name '*.rs' -o -type f -name '*.patch' | LC_ALL=C sort)

id=$("$engine" create --network host -e "RUST_NIGHTLY=$RUST_NIGHTLY" -e "LOCK=${LOCK:-0}" \
	-v stomp-cargo-registry:/usr/local/cargo/registry "$tag" bash /work/wtserver/compile.sh)
trap '"$engine" rm -f "$id" >/dev/null' EXIT
tmp=$(mktemp -d)
mkdir -p "$tmp/wtserver"
(cd "$here" && tar -cf - "${inputs[@]}") | tar -xf - -C "$tmp/wtserver"
"$engine" cp "$tmp/wtserver" "$id:/work/wtserver"
rm -rf "$tmp"
"$engine" start -a "$id"

if [[ ${LOCK:-0} == 1 ]]; then
	"$engine" cp "$id:/work/wtserver/Cargo.lock" "$here/Cargo.lock"
	echo "test/wtserver/Cargo.lock updated"
fi
"$engine" cp "$id:/work/wtserver/out/wtserver.wasm" "$here/wtserver.wasm"
"$engine" cp "$id:/work/wtserver/out/wtserver.js" "$here/wtserver.js"
(cd "$root" && node_modules/.bin/prettier --log-level warn --write test/wtserver/wtserver.js)

{
	echo "# test/wtserver/build.sh; the same inputs rebuild the same outputs"
	echo "toolchain $base"
	grep -v '^#' "$rust/pins.env" | grep .
	echo "image $tag"
	echo "CLANG=$CLANG"
	echo "prettier $(node -p "require('$root/node_modules/prettier/package.json').version")"
	echo "inputs"
	(cd "$here" && sha256sum "${inputs[@]}")
	echo "outputs"
	(cd "$here" && sha256sum wtserver.wasm wtserver.js)
} > "$here/PROVENANCE"
echo
echo "test/wtserver/wtserver.wasm: $(stat -c %s "$here/wtserver.wasm") bytes, wtserver.js: $(stat -c %s "$here/wtserver.js") bytes"
