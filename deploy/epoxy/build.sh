#!/bin/bash
# Build epoxy-transport from pinned upstream plus patches/ (see README.md).
# Needs docker (or podman). Output: deploy/epoxy/out/{epoxy-tls,epoxy-transport}.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source ./upstream.env

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

tag="epoxy-fracital:${EPOXY_TLS_REV:0:12}-$(cat patches/*/*.patch | sha256sum | cut -c1-12)"

"$engine" build \
	--build-arg "HYPER_UTIL_WASM_REV=$HYPER_UTIL_WASM_REV" \
	--build-arg "EPOXY_TLS_REV=$EPOXY_TLS_REV" \
	--build-arg "EPOXY_TRANSPORT_REV=$EPOXY_TRANSPORT_REV" \
	-t "$tag" .

rm -rf out
mkdir -p out
id=$("$engine" create "$tag")
"$engine" cp "$id:/out/." out/
"$engine" rm "$id" >/dev/null

echo
echo "built $tag"
cat out/UPSTREAM
ls -la out/epoxy-tls/full out/epoxy-transport/dist
