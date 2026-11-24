#!/bin/bash
# Forced command for the CI deploy key on terp (/usr/local/sbin/stomp-deploy-gate).
# The only command it accepts is `deploy <40-hex sha>`: fetch that commit from GitHub, build it in
# $STAGE, swap $REPO to it, restart the pm2 app and health-check it, rolling back on failure.
# Installed by hand; CI never updates it. /opt/stomp/repo/.env is never touched.
#
# The key logs in as the unprivileged `deploy` user (/home/deploy/.ssh/authorized_keys, owned by root so
# deploy cannot change its own restrictions):
#
#   restrict,command="/usr/local/sbin/stomp-deploy-gate" ssh-ed25519 AAAA... stomp-ci@github-actions
#
# git, npm and rsync run as deploy, which owns the checkouts but not .env (root 600). Root does only
# what /usr/local/sbin/stomp-deploy-root (deploy/terp-deploy-root.sh) does through the fixed rules in
# /etc/sudoers.d/deploy: re-own the trees, restart the pm2 app, print its logs. pm2 still runs the app
# as root. Started as root (an old root key line), the gate drops to deploy first.
set -euo pipefail
umask 022

if ((EUID == 0)); then
	exec runuser -u deploy -- "$0" "$@"
fi

REPO=/opt/stomp/repo
STAGE=/opt/stomp/stage
UPSTREAM=https://github.com/Fracital/powerMouse.git
PORT=8081
LOG=/var/log/stomp-deploy.log
STATE=/var/lib/stomp-deploy
ROOT_HELPER=/usr/local/sbin/stomp-deploy-root

read -r -a cmd <<<"${SSH_ORIGINAL_COMMAND:-}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }

sudo -n "$ROOT_HELPER" prepare
exec 9>"$STATE/deploy.lock"
flock -w 900 9

healthcheck() {
	for _ in $(seq 1 30); do
		curl -fsS -o /dev/null -m 5 "http://127.0.0.1:$PORT/api/status" && return 0
		sleep 1
	done
	return 1
}

restart_app() {
	sudo -n "$ROOT_HELPER" restart >/dev/null
	if ! healthcheck; then
		log "health check failed after restart"
		sudo -n "$ROOT_HELPER" logs >&2 || true
		return 1
	fi
}

# vibeOS (vendor/vibeOS) is a submodule the build uses when it is there and leaves out when it is
# not, so a submodule that will not check out costs that feature, never the deploy. Its build output
# goes into dist/, which is all the live checkout gets; the live checkout never needs the submodule.
checkout_submodules() {
	[[ -f $STAGE/.gitmodules ]] || return 0
	git -C "$STAGE" submodule sync -q
	if ! git -C "$STAGE" submodule update -q --init --force --depth 1; then
		log "submodules did not check out; building without them"
		return 0
	fi
	git -C "$STAGE" submodule foreach -q 'git clean -qfdx -e node_modules'
	if [[ -f $STAGE/vendor/vibeOS/package-lock.json ]]; then
		(cd "$STAGE" && npm ci --prefix vendor/vibeOS --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) >&2 ||
			log "vendor/vibeOS dependencies did not install; building without vibeOS"
	fi
}

# Build $1 in the stage checkout, then move the live checkout, deps and dist to it.
build_and_sync() {
	local sha=$1
	[[ -d $STAGE/.git ]] || git clone -q "$UPSTREAM" "$STAGE"
	git -C "$STAGE" fetch -q "$UPSTREAM" "$sha" || git -C "$STAGE" fetch -q "$REPO" "$sha"
	git -C "$STAGE" checkout -q --force --detach "$sha"
	git -C "$STAGE" clean -qfdx -e node_modules
	checkout_submodules
	(cd "$STAGE" && npm ci --no-audit --no-fund --loglevel=error --ignore-scripts && npm run build) >&2
	# The public site is the protected build (scripts/build-demo-site.mjs: estrogen, then the leak
	# gate), served when .env sets STOMP_DEMO_SITE=build/demo-site. A build that fails its gate
	# fails the deploy, so a leak never goes live. A rollback to a commit whose protected build does
	# not pass keeps the protected site it had.
	local site=1
	if ! (cd "$STAGE" && npm run build:demo-site) >&2; then
		[[ ${2:-} == rollback ]] || { log "refusing $sha: the protected demo site did not build"; exit 1; }
		log "the protected demo site of $sha did not build; keeping the one live"
		site=
	fi
	git -C "$REPO" fetch -q "$STAGE" "$sha"
	git -C "$REPO" reset -q --keep "$sha"
	rsync -a --delete "$STAGE/node_modules/" "$REPO/node_modules/"
	rsync -a --delete "$STAGE/dist/" "$REPO/dist/"
	if [[ -n $site ]]; then
		mkdir -p "$REPO/build"
		rsync -a --delete "$STAGE/build/demo-site/" "$REPO/build/demo-site/"
	fi
}

deploy_app() {
	local sha=${1:-}
	[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: deploy <40-hex sha>" >&2; exit 64; }
	local live
	live=$(git -C "$REPO" rev-parse HEAD)
	if [[ $live == "$sha" && -f $REPO/dist/serviceWorker.js ]]; then
		log "already at $sha"
		return
	fi
	# Never overwrite work done directly on terp that is not on GitHub.
	if [[ -n $(git -C "$REPO" status --porcelain --untracked-files=no) ]]; then
		log "refusing $sha: $REPO has uncommitted changes to tracked files"
		exit 1
	fi
	git -C "$REPO" fetch -q "$UPSTREAM" "$sha"
	if ! git -C "$REPO" merge-base --is-ancestor "$live" "$sha"; then
		log "refusing $sha: live HEAD $live has commits that are not on GitHub; push them first"
		exit 1
	fi
	log "deploying $sha (live $live)"
	build_and_sync "$sha"
	if ! restart_app; then
		log "rolling back to $live"
		build_and_sync "$live" rollback
		restart_app || log "rollback to $live is unhealthy too"
		exit 1
	fi
	log "deployed $sha"
}

case "${cmd[0]:-}" in
deploy) deploy_app "${cmd[1]:-}" ;;
*)
	echo "denied: '${SSH_ORIGINAL_COMMAND:-}'" >&2
	exit 126
	;;
esac
