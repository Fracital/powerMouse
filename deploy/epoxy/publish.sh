#!/bin/bash
# Push a finished build (out/, from build.sh) to the distribution branches:
#   Fracital/epoxy-tls        branch dist   <- out/epoxy-tls
#   Fracital/EpoxyTransport   branch dist   <- out/epoxy-transport
# Prints the EpoxyTransport commit to pin in package.json. Nothing here needs a
# Rust toolchain; the repos only distribute what build.sh produced.
set -euo pipefail
cd "$(dirname "$0")"
[[ -d out/epoxy-tls && -d out/epoxy-transport ]] || { echo "run build.sh first" >&2; exit 1; }

REMOTE_PREFIX=${REMOTE_PREFIX:-github2:Fracital}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

publish() {
	local repo=$1 src=$2 msg=$3
	git clone -q --branch dist --single-branch "$REMOTE_PREFIX/$repo.git" "$work/$repo" 2>/dev/null ||
		{ git init -q "$work/$repo" && git -C "$work/$repo" checkout -q --orphan dist && git -C "$work/$repo" remote add origin "$REMOTE_PREFIX/$repo.git"; }
	find "$work/$repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
	cp -r "$src/." "$work/$repo/"
	cp out/UPSTREAM "$work/$repo/UPSTREAM"
	git -C "$work/$repo" add -A
	if git -C "$work/$repo" diff --cached --quiet; then
		echo "$repo: dist unchanged" >&2
	else
		git -C "$work/$repo" commit -q -m "$msg"
		git -C "$work/$repo" push -q -u origin dist
	fi
	git -C "$work/$repo" rev-parse HEAD
}

summary=$(head -4 out/UPSTREAM | tr '\n' ' ')
tls=$(publish epoxy-tls out/epoxy-tls "dist: epoxy-tls from upstream + patches ($summary)")
# the transport bundles epoxy-tls, so consumers never fetch it; the manifest
# only records which build this was
transport=$(publish EpoxyTransport out/epoxy-transport "dist: epoxy-transport from upstream + patches ($summary); epoxy-tls dist $tls")

echo
echo "epoxy-tls dist:        $tls"
echo "epoxy-transport dist:  $transport"
echo "pin in package.json:   \"@mercuryworkshop/epoxy-transport\": \"git+https://github.com/Fracital/EpoxyTransport.git#$transport\""
