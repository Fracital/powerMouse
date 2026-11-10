#!/bin/bash
# Fetch the crates this build patches (patches/<crate>/*.patch), check them
# against the crates.io checksum, unpack them into vendor/ and apply the
# patches in numeric order. Cargo.toml's [patch.crates-io] points at vendor/.
set -euo pipefail
cd "$(dirname "$0")"

fetch() {
	local name=$1 version=$2 sha=$3
	local dir="vendor/$name"
	rm -rf "$dir"
	mkdir -p vendor
	curl -fsSL "https://static.crates.io/crates/$name/$name-$version.crate" -o "vendor/$name.crate"
	echo "$sha  vendor/$name.crate" | sha256sum -c -
	tar xzf "vendor/$name.crate" -C vendor
	mv "vendor/$name-$version" "$dir"
	rm "vendor/$name.crate"
	for p in "patches/$name"/*.patch; do
		[ -e "$p" ] || continue
		echo "[patch] $name <- $(basename "$p")"
		patch -d "$dir" -p1 --forward --no-backup-if-mismatch < "$p"
	done
}

fetch h3 0.0.8 10872b55cfb02a821b69dc7cf8dc6a71d6af25eb9a79662bec4a9d016056b3be
