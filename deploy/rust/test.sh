#!/bin/bash
# Run the Rust workspace's own tests (cargo test, natively, in the toolchain
# container): the splice engine's property tests, a crate's unit tests, the
# differential harness. Usage: deploy/rust/test.sh [cargo test args...], for
# example `deploy/rust/test.sh -p edits`. The image is the one build.sh
# made; run build.sh once first.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)

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
"$engine" image inspect "$tag" >/dev/null 2>&1 || { echo "no toolchain image $tag: run build.sh first" >&2; exit 1; }

id=$("$engine" create --network host \
	-v stomp-cargo-registry:/usr/local/cargo/registry "$tag" \
	bash -c "bash /work/patches.sh && cd /work/rust && cargo test --locked $*")
trap '"$engine" rm -f "$id" >/dev/null' EXIT
tmp=$(mktemp -d)
mkdir -p "$tmp/rust"
(cd "$root/rust" && tar --exclude=./target --exclude=./patched -cf - .) | tar -xf - -C "$tmp/rust"
"$engine" cp "$tmp/rust" "$id:/work/rust"
"$engine" cp "$here/patches.sh" "$id:/work/patches.sh"
rm -rf "$tmp"
"$engine" start -a "$id"
