#!/bin/bash
# Forced command for the CI deploy key on terp (/usr/local/sbin/stomp-deploy-gate).
# The only command it accepts is `deploy <40-hex sha>`: fetch that commit from GitHub, build it in
# $STAGE, swap $REPO to it, restart the pm2 app and health-check it, rolling back on failure.
# Installed by hand; CI never updates it. /opt/stomp/repo/.env is never touched.
set -euo pipefail
umask 022

REPO=/opt/stomp/repo
STAGE=/opt/stomp/stage
UPSTREAM=https://github.com/Fracital/powerMouse.git
APP=stomp
PORT=8081
LOG=/var/log/stomp-deploy.log

read -r -a cmd <<<"${SSH_ORIGINAL_COMMAND:-}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }

exec 9>/run/lock/stomp-deploy.lock
flock -w 900 9

healthcheck() {
	for _ in $(seq 1 30); do
		curl -fsS -o /dev/null -m 5 "http://127.0.0.1:$PORT/api/status" && return 0
		sleep 1
	done
	return 1
}

restart_app() {
	pm2 restart "$APP" --update-env >/dev/null
	if ! healthcheck; then
		log "health check failed after restart"
		pm2 logs "$APP" --nostream --lines 40 >&2 || true
		return 1
	fi
}

# Build $1 in the stage checkout, then move the live checkout, deps and dist to it.
build_and_sync() {
	local sha=$1
	[[ -d $STAGE/.git ]] || git clone -q "$UPSTREAM" "$STAGE"
	git -C "$STAGE" fetch -q "$UPSTREAM" "$sha" || git -C "$STAGE" fetch -q "$REPO" "$sha"
	git -C "$STAGE" checkout -q --force --detach "$sha"
	git -C "$STAGE" clean -qfdx -e node_modules
	(cd "$STAGE" && npm ci --no-audit --no-fund --loglevel=error --ignore-scripts && npm run build) >&2
	git -C "$REPO" fetch -q "$STAGE" "$sha"
	git -C "$REPO" reset -q --keep "$sha"
	rsync -a --delete "$STAGE/node_modules/" "$REPO/node_modules/"
	rsync -a --delete "$STAGE/dist/" "$REPO/dist/"
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
		build_and_sync "$live"
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
