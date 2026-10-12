#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^dev_[A-Za-z0-9_-]{16,80}$ ]]; then
  echo 'Usage: grant-login-scope.sh DEVICE_ID' >&2; exit 2
fi
ROOT=${AGBROWSE_ROOT:-"$HOME/.agbrowse-bpdus"}
STATE="$ROOT/state"
KEYS="$ROOT/keys"
LABEL=me.bpdus.agbrowse.gateway
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=${AGBROWSE_NODE_BIN:-node}
was_loaded=0
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then was_loaded=1; fi
restore() {
  trap - EXIT
  if [ "$was_loaded" -eq 1 ] && [ -f "$PLIST" ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || { echo 'grant-login-scope: gateway restoration failed' >&2; exit 1; }
  fi
}
trap restore EXIT
if [ "$was_loaded" -eq 1 ]; then launchctl bootout "$DOMAIN/$LABEL"; fi
tries=30
while [ "$tries" -gt 0 ]; do
  loaded=0; launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && loaded=1
  process=0; pgrep -f 'skills/browser/agent-gateway[.]mjs' >/dev/null 2>&1 && process=1
  lock=0; [ -e "$STATE/.writer.lock" ] && lock=1
  if [ "$loaded" -eq 0 ] && [ "$process" -eq 0 ] && [ "$lock" -eq 0 ]; then break; fi
  sleep 1; tries=$((tries - 1))
done
[ "$tries" -gt 0 ] || { echo 'grant-login-scope: gateway writer did not stop' >&2; exit 1; }
"$NODE" "$ROOT/src/skills/browser/agent-auth-admin.mjs" --state-dir "$STATE" --key-dir "$KEYS" --device-id "$1"
