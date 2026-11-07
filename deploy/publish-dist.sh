#!/bin/bash
# Publish the built package to the `dist` branch of this repository, so a host
# can depend on it as a git dependency with no build step:
#   "stomp-rewrite": "git+https://github.com/Fracital/powerMouse.git#<sha>"
# The branch holds what `npm pack` would ship (package.json, dist/, lib/, the
# README, LICENSE and CHANGELOG) and nothing else; package.json loses its
# scripts and devDependencies so no installer tries to build. Same pattern as
# deploy/epoxy/publish.sh. Run from a clean master that is on GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-dist}
src=$(git rev-parse HEAD)
short=${src:0:7}
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
	echo "working tree has uncommitted changes; publish from a clean checkout" >&2
	exit 1
fi
if ! git merge-base --is-ancestor "$src" "$REMOTE/master" 2>/dev/null; then
	git fetch -q "$REMOTE" master
	git merge-base --is-ancestor "$src" "$REMOTE/master" || {
		echo "HEAD $short is not on $REMOTE/master; push first" >&2
		exit 1
	}
fi

npm run -s build

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q --branch "$BRANCH" --single-branch "$(git remote get-url "$REMOTE")" "$work" 2>/dev/null ||
	{ git init -q "$work" && git -C "$work" checkout -q --orphan "$BRANCH" && git -C "$work" remote add origin "$(git remote get-url "$REMOTE")"; }
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r dist lib README.md LICENSE CHANGELOG.md "$work/"
node -e '
	const fs = require("fs");
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
	delete pkg.scripts;
	delete pkg.devDependencies;
	pkg.gitHead = process.argv[1];
	fs.writeFileSync(process.argv[2] + "/package.json", JSON.stringify(pkg, null, "\t") + "\n");
' "$src" "$work"
printf 'built from %s\n' "$src" > "$work/SOURCE"
git -C "$work" add -A
if git -C "$work" diff --cached --quiet; then
	echo "dist unchanged since the last publish" >&2
else
	git -C "$work" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
		commit -q -m "dist: stomp-rewrite $(node -p 'require("./package.json").version') from $short"
	git -C "$work" push -q -u origin "$BRANCH"
fi
sha=$(git -C "$work" rev-parse HEAD)
echo
echo "dist branch:  $sha"
echo "pin:          \"stomp-rewrite\": \"git+https://github.com/Fracital/powerMouse.git#$sha\""
