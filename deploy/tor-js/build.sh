#!/bin/bash
# Build tor-js from its pinned release plus patches/ (see README.md).
# Needs docker (or podman). Output: deploy/tor-js/out/dist and out/SHA256.
# PATCHES=0 builds the release unmodified and checks its wasm against the hash
# tor-js's own CI printed (UPSTREAM_WASM_SHA256): the provenance check.
# ENGINE names the engine when the default is wrong.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./upstream.env
patches=${PATCHES:-1}
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
tag="tor-js-fracital:${TOR_JS_REV:0:12}-p${patches}-$( (cat Dockerfile; find patches -name '*.patch' -print0 | sort -z | xargs -0r cat) | sha256sum | cut -c1-12)"
"$engine" build \
	--build-arg "TOR_JS_REV=$TOR_JS_REV" \
	--build-arg "RUST_VERSION=$RUST_VERSION" \
	--build-arg "WASM_PACK_VERSION=$WASM_PACK_VERSION" \
	--build-arg "BINARYEN_VERSION=$BINARYEN_VERSION" \
	--build-arg "NODE_VERSION=$NODE_VERSION" \
	--build-arg "PATCHES=$patches" \
	-t "$tag" .
out=out
[[ $patches == 1 ]] || out=out-upstream
rm -rf "$out"
mkdir -p "$out"
id=$("$engine" create "$tag")
"$engine" cp "$id:/out/." "$out/"
"$engine" rm "$id" >/dev/null
echo "built $tag"
cat "$out/SHA256"
got=$(cut -d' ' -f1 "$out/SHA256")
if [[ $patches == 1 ]]; then
	if [[ $got == "${PATCHED_WASM_SHA256:-}" ]]; then
		echo "the release plus patches/ built the wasm upstream.env names ($got)"
	else
		echo "the wasm differs from upstream.env's PATCHED_WASM_SHA256 ($got): after a change to patches/, build again with the cache off and set it to the hash both builds give" >&2
	fi
fi
if [[ $patches != 1 ]]; then
	if [[ $got == "$UPSTREAM_WASM_SHA256" ]]; then
		echo "the unmodified release reproduces the published wasm ($got)"
	else
		echo "MISMATCH: built $got, tor-js's CI printed $UPSTREAM_WASM_SHA256" >&2
		exit 1
	fi
fi
