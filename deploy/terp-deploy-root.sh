#!/bin/bash
# The root half of stomp's deploy on terp. Installed by hand (never by CI) as
# /usr/local/sbin/stomp-deploy-root, root-owned 0755, and allowed to the deploy user with exactly
# these arguments by /etc/sudoers.d/deploy:
#
#   deploy ALL=(root) NOPASSWD: /usr/local/sbin/stomp-deploy-root prepare, \
#     /usr/local/sbin/stomp-deploy-root restart, /usr/local/sbin/stomp-deploy-root logs
#
#   prepare   the checkout, the stage, the state dir and the log are deploy's; the live checkout is
#             root:deploy 1775 so deploy cannot rename or replace root's .env files, which stay
#             root 600. Re-owns whatever root wrote since (the app, a commit made on terp).
#   restart   pm2 restart stomp.
#   logs      its last 40 log lines, for a failed health check.
#
# It takes no other input: the app name and paths are fixed here, not by the caller.
set -euo pipefail
# pm2 is root's (pm2-root.service); sudo resets the environment, so name its home.
export HOME=/root PM2_HOME=/root/.pm2

REPO=/opt/stomp/repo
STAGE=/opt/stomp/stage
STATE=/var/lib/stomp-deploy
LOG=/var/log/stomp-deploy.log
APP=stomp

reown() {
	# -P and -h: never follow a link, so one planted in the tree cannot hand deploy a file elsewhere.
	# .env* at the top of a checkout is root's and stays out (except a tracked .env.example).
	find -P "$1" \( -path "$1/.env*" ! -name '*.example' \) -prune -o \( ! -user deploy -o ! -group deploy \) -exec chown -h deploy:deploy {} +
}

prepare() {
	shopt -s nullglob
	install -d -o deploy -g deploy -m 755 "$STATE"
	[[ -e $LOG ]] || install -o deploy -g deploy -m 644 /dev/null "$LOG"
	chown deploy:deploy "$LOG"
	if [[ -d $STAGE && ! -L $STAGE ]]; then
		reown "$STAGE"
	fi
	[[ -d $REPO && ! -L $REPO ]] || return 0
	reown "$REPO"
	chown root:deploy "$REPO"
	chmod 1775 "$REPO"
	local f
	for f in "$REPO"/.env*; do
		[[ $f == *.example ]] && continue
		chown -h root:root "$f"
		chmod 600 "$f"
	done
}

case "${1:-}" in
prepare) prepare ;;
restart) pm2 restart "$APP" --update-env ;;
logs) pm2 logs "$APP" --nostream --lines 40 ;;
*)
	echo "usage: stomp-deploy-root prepare|restart|logs" >&2
	exit 64
	;;
esac
