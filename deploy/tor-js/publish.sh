#!/bin/bash
# Push a finished build (out/, from build.sh) to the distribution branch:
#   Fracital/tor-js   branch dist   <- out/dist as an installable package
# The package is named tor-js, so `import.meta.resolve('tor-js')` and
# demo/public/tor-client/service.mjs find it where the npm release was.
# Prints the commit to pin in package.json. Nothing here needs a Rust
# toolchain or a container; the repo only distributes what build.sh made.
# PUSH=0 prepares the commit in a clone it leaves in place and prints the
# command that pushes it, instead of pushing.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./upstream.env
for f in dist/tor_js_bg.wasm SHA256 COMMIT package.json LICENSE-MIT LICENSE-APACHE; do
	[[ -e out/$f ]] || { echo "out/$f is missing: run build.sh first" >&2; exit 1; }
done
got=$(cut -d' ' -f1 out/SHA256)
[[ $got == "$PATCHED_WASM_SHA256" ]] || {
	echo "out/ holds $got, not upstream.env's PATCHED_WASM_SHA256 ($PATCHED_WASM_SHA256): build again" >&2
	exit 1
}

REMOTE_PREFIX=${REMOTE_PREFIX:-github2:Fracital}
push=${PUSH:-1}
work=$(mktemp -d "${TMPDIR:-/tmp}/tor-js-dist.XXXXXX")
[[ $push == 0 ]] || trap 'rm -rf "$work"' EXIT
repo=$work/tor-js
patched_commit=$(cat out/COMMIT)

git clone -q --branch dist --single-branch "$REMOTE_PREFIX/tor-js.git" "$repo" 2>/dev/null ||
	{ git init -q "$repo" && git -C "$repo" checkout -q --orphan dist && git -C "$repo" remote add origin "$REMOTE_PREFIX/tor-js.git"; }
find "$repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

cp -r out/dist "$repo/dist"
# only the wasm-file entry and the wasm it loads (demo/public/tor-client/
# service.mjs): the other entries carry the wasm again as base64 (6.8 MB
# each, and anon-rpc-worker.js another copy) or fetch it from tor-js's CDN,
# and the source maps are 14 MB of them
rm -rf "$repo/dist/entryPoints/wasm-base64" "$repo/dist/entryPoints/wasm-cdn" \
	"$repo/dist/anon-rpc-worker.js" "$repo/dist/singleton.d.ts"
rm -f "$repo"/dist/entryPoints/*/singleton.*
find "$repo/dist" -name '*.map' -delete
for f in dist/tor_js_bg.wasm dist/entryPoints/wasm-file/index.js dist/entryPoints/wasm-file/index.d.ts; do
	[[ -e $repo/$f ]] || { echo "$f is not in the build's dist" >&2; exit 1; }
done
cp out/LICENSE-MIT out/LICENSE-APACHE "$repo/"
# how it was built, so the hash can be checked without this repository
mkdir -p "$repo/build/patches"
cp Dockerfile build.sh upstream.env README.md "$repo/build/"
cp patches/*.patch "$repo/build/patches/"

# tor-js's manifest with the build's version, nothing to run on install
# (a git dependency runs `prepare`), and only what the package needs
node --input-type=module - "$repo/package.json" "$TOR_JS_VERSION" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const [file, version] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync('out/package.json', 'utf8'));
if (manifest.version !== version)
	throw new Error(`out/package.json is ${manifest.version}, upstream.env says ${version}`);
manifest.version = `${version}-fracital.1`;
manifest.description += ', with a stream API (Fracital build: deploy/tor-js)';
delete manifest.scripts;
delete manifest.devDependencies;
manifest.files = ['dist', 'LICENSE-MIT', 'LICENSE-APACHE', 'README.md', 'UPSTREAM'];
// every name resolves to the wasm-file entry (what dist/ keeps): nothing
// reaches the CDN loader, and `import.meta.resolve('tor-js')` is a file of
// dist/entryPoints/ as before (demo/server.js serves its dist/)
const entry = {
	types: './dist/entryPoints/wasm-file/index.d.ts',
	import: './dist/entryPoints/wasm-file/index.js',
};
manifest.main = entry.import.slice(2);
manifest.types = entry.types.slice(2);
manifest.exports = { '.': entry, './wasm-file': entry };
delete manifest.imports;
manifest.repository = { type: 'git', url: 'git+https://github.com/Fracital/tor-js.git' };
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
EOF

cat > "$repo/UPSTREAM" <<EOF
tor-js $TOR_JS_VERSION
upstream https://github.com/ethereum/tor-js commit $TOR_JS_REV
patched commit $patched_commit (the patches committed with a fixed author and date)
patches $(cd patches && ls *.patch | tr '\n' ' ')
rustc $RUST_VERSION, wasm-pack $WASM_PACK_VERSION, binaryen $BINARYEN_VERSION, node $NODE_VERSION
wasm sha256 (this build)       $PATCHED_WASM_SHA256
wasm sha256 (release, no patch) $UPSTREAM_WASM_SHA256
EOF

cat > "$repo/README.md" <<EOF
# tor-js, Fracital build

[tor-js](https://github.com/ethereum/tor-js) $TOR_JS_VERSION (arti compiled to
wasm, MIT OR Apache-2.0: LICENSE-MIT, LICENSE-APACHE) built from its release
commit \`$TOR_JS_REV\` with one patch, \`build/patches/0001-connect-streams.patch\`:

- \`TorClient.connect(host, port, { isolationKey })\`: a TCP stream through
  Tor (the exit resolves \`host\`) on the circuits of the key's isolation
  group (the same groups as fetch's \`anonOptions.isolationKey\`), as
  \`{ readable, writable }\` web streams of \`Uint8Array\` chunks. The
  release has only \`fetch\`.

This branch holds only what the build made (\`dist/\`), the licences and
how it was built (\`build/\`). Install it as a git dependency:

\`\`\`json
"tor-js": "github:Fracital/tor-js#<commit>"
\`\`\`

## The wasm, and how to check it

| Build                              | \`dist/tor_js_bg.wasm\` sha256                                     |
| ---------------------------------- | ---------------------------------------------------------------- |
| this one (release + 0001)          | \`$PATCHED_WASM_SHA256\` |
| the release alone (npm \`tor-js@$TOR_JS_VERSION\`) | \`$UPSTREAM_WASM_SHA256\` |

The second is what tor-js's own CI printed for the release (run
43154142421); building the release alone here gives it too, so the build
below is the release's own, pinned tools and all: rustc $RUST_VERSION,
wasm-pack $WASM_PACK_VERSION, binaryen $BINARYEN_VERSION, node $NODE_VERSION
(\`build/upstream.env\`).

To reproduce both, with docker or podman:

\`\`\`sh
cd build
PATCHES=0 ./build.sh   # the release alone: out-upstream/, checked against the second hash
./build.sh             # release + patches/: out/, checked against the first
\`\`\`

\`build/Dockerfile\` clones tor-js at \`$TOR_JS_REV\`, applies \`patches/\`,
commits them with a fixed author and date (tor-js's \`build.rs\` embeds the
commit, and a timestamp when the tree is dirty; the commit is
\`$patched_commit\`) and runs tor-js's own \`scripts/build.sh --release\`.
\`build/README.md\` says more.
EOF

git -C "$repo" add -A
if git -C "$repo" diff --cached --quiet; then
	echo "tor-js: dist unchanged" >&2
else
	git -C "$repo" -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name)}" -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email)}" \
		commit -q -m "dist: tor-js $TOR_JS_VERSION ($TOR_JS_REV) + patches, wasm $PATCHED_WASM_SHA256"
	if [[ $push == 1 ]]; then
		git -C "$repo" push -q -u origin dist
	fi
fi
commit=$(git -C "$repo" rev-parse HEAD)
echo
echo "tor-js dist:          $commit"
[[ $push == 1 ]] || echo "push it with:         git -C $repo push -u origin dist"
echo "pin in package.json:  \"tor-js\": \"github:Fracital/tor-js#$commit\""
