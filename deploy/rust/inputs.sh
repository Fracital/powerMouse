#!/bin/bash
# Runs inside the toolchain container (compile.sh calls it): prints what one
# crate's artifact is built from, which build.sh hashes into the `sources`
# line of assets/<name>.UPSTREAM. Only what reaches that crate's build:
#
# - its own files and those of the workspace crates it depends on by path
#   (rwjs builds rust/edits in), each by its sha256;
# - the dependency set cargo resolved for it from Cargo.lock, with features
#   (`cargo tree -p <crate> --locked`): a crate added to the workspace, or a
#   dependency of another crate that moves in the lockfile, is not in it;
# - the release profile of the workspace's Cargo.toml, and its overrides
#   for the packages the crate builds in.
#
# So an artifact's line changes when its bytes could, and not when another
# crate of the workspace is touched. Argument: crate name.
set -euo pipefail
export LC_ALL=C
crate=$1
cd /work/rust

triple=wasm32-unknown-unknown
if [[ -f "$crate/wasm-target" ]]; then
	triple=$(tr -d '[:space:]' < "$crate/wasm-target")
fi

tree() {
	cargo tree --locked "$@" -p "$crate" --target "$triple" \
		--edges normal,build --prefix none --format '{p} {f}'
}
# offline when the registry volume already holds the index (after a build)
resolved=$(tree --offline 2>/dev/null || tree)
# (cargo marks a package it already listed with ` (*)`)
resolved=$(sed 's/ *(\*)$//; s/ *$//' <<< "$resolved" | sort -u)

# the crate and the workspace crates it builds in: `name v0.1.0 (/work/rust/<dir>)`
dirs=$(sed -n 's|^.* (/work/rust/\([^)]*\)).*$|\1|p' <<< "$resolved" | sort -u)
grep -qx "$crate" <<< "$dirs" || { echo "cargo tree does not name rust/$crate" >&2; exit 1; }

echo files
for dir in $dirs; do
	for file in Cargo.toml abi.json wasm-target bindgen build.rs rustflags snip; do
		if [[ -f "$dir/$file" ]]; then echo "$dir/$file"; fi
	done
	find "$dir/src" -type f | sort
done | while read -r path; do
	echo "$(sha256sum < "$path" | cut -d' ' -f1) rust/$path"
done
echo dependencies
sed 's|(/work/rust/|(rust/|' <<< "$resolved"
echo profile
# the release profile, and its overrides for the packages this crate builds
# in (`[profile.release.package.<name>]`: another crate's do not reach it)
names=$(awk '{ print $1 }' <<< "$resolved" | sort -u)
awk -v names="$names" '
	BEGIN { n = split(names, list, "\n"); for (i = 1; i <= n; i++) built[list[i]] = 1 }
	/^\[profile\.release\]/ { on = 1; print; next }
	/^\[profile\.release\.package\./ {
		name = $0
		sub(/^\[profile\.release\.package\./, "", name)
		sub(/\].*$/, "", name)
		gsub(/"/, "", name)
		on = (name in built)
		if (on) print
		next
	}
	/^\[/ { on = 0 }
	on && NF' Cargo.toml
