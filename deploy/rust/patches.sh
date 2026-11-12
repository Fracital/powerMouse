#!/bin/bash
# Runs inside the toolchain container (build.sh and test.sh put it there
# with the workspace) before cargo does: makes rust/patched/<name> for each
# crate rust/patches/crates lists, from the crate as crates.io published it
# (downloaded once into the registry volume and checked against the
# checksum on its line, which is the one Cargo.lock had for it) with
# rust/patches/<name>-<version>.patch applied. rust/Cargo.toml points
# [patch.crates-io] at those directories. A patch that no longer applies
# fails the build.
set -euo pipefail
cd /work/rust
[[ -f patches/crates ]] || exit 0

cache=/usr/local/cargo/registry/patched-crates
mkdir -p "$cache" patched
while read -r name version checksum; do
	case "$name" in '' | '#'*) continue ;; esac
	crate="$cache/$name-$version.crate"
	if ! echo "$checksum  $crate" | sha256sum -c - >/dev/null 2>&1; then
		curl -fsSL "https://static.crates.io/crates/$name/$name-$version.crate" -o "$crate"
		echo "$checksum  $crate" | sha256sum -c -
	fi
	rm -rf "patched/$name"
	mkdir -p "patched/$name"
	tar xzf "$crate" -C "patched/$name" --strip-components=1
	patch -d "patched/$name" -p1 --no-backup-if-mismatch < "patches/$name-$version.patch"
done < patches/crates
