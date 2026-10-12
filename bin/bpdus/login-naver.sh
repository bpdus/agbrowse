#!/bin/bash
set -u

usage() {
  cat <<'USAGE'
Usage: login-naver.sh [--stop-worker] [--help]

Open the dedicated Chrome profile at the Naver login page through macOS Launch Services.
  --stop-worker  Unload the worker LaunchAgent or stop a verified legacy worker, then restore it after Chrome exits.
  --help         Show this help.
USAGE
}

STOP_WORKER=0
for arg in "$@"; do
  case "$arg" in --stop-worker) STOP_WORKER=1 ;; --help) usage; exit 0 ;; *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;; esac
done
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || { echo 'HOME must name an existing directory.' >&2; exit 1; }
AGBROWSE_HOME="$HOME/.agbrowse-bpdus"
PROFILE="$AGBROWSE_HOME/agent-profile"
LABEL=me.bpdus.agbrowse.worker
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CHROME_APP=${CHROME_APP:-/Applications/Google Chrome.app}
if [ -n "${CHROME_BIN:-}" ]; then
  case "$CHROME_BIN" in *.app) CHROME_APP=$CHROME_BIN ;; */Contents/MacOS/*) CHROME_APP=${CHROME_BIN%%/Contents/MacOS/*} ;; *) echo "CHROME_BIN must identify a Chrome .app bundle or its Contents/MacOS executable." >&2; exit 1 ;; esac
fi
[ -d "$CHROME_APP" ] && [ -x "$CHROME_APP/Contents/MacOS/Google Chrome" ] || { echo "Chrome application bundle is unavailable: $CHROME_APP" >&2; exit 1; }

check_profile_path() {
  if [ -L "$AGBROWSE_HOME" ] || { [ -e "$AGBROWSE_HOME" ] && [ ! -d "$AGBROWSE_HOME" ]; }; then echo "Refusing unsafe profile parent: $AGBROWSE_HOME" >&2; return 1; fi
  if [ -d "$AGBROWSE_HOME" ] && [ ! -w "$AGBROWSE_HOME" ]; then echo "Profile parent is not writable: $AGBROWSE_HOME" >&2; return 1; fi
  if [ -L "$PROFILE" ] || { [ -e "$PROFILE" ] && [ ! -d "$PROFILE" ]; }; then echo "Refusing unsafe profile path: $PROFILE" >&2; return 1; fi
  if [ -d "$PROFILE" ] && [ ! -w "$PROFILE" ]; then echo "Profile is not writable: $PROFILE" >&2; return 1; fi
  return 0
}
check_profile_locks() {
  local lock_path
  for lock_path in "$AGBROWSE_HOME/profile.lock" "$AGBROWSE_HOME/profile.lock.reclaiming" "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"; do
    if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then echo "Profile remains locked: $lock_path" >&2; return 1; fi
  done
}

WORKER_PIDS=''
discover_workers() {
  local output status candidate details uid args executable script_arg
  output=$(pgrep -f 'skills/browser/agent-worker[.]mjs' 2>/dev/null); status=$?
  case "$status" in
    1) WORKER_PIDS=''; return 1 ;;
    0) [ -n "$output" ] || { echo 'Worker discovery returned no process IDs.' >&2; return 2; } ;;
    *) echo "Could not discover workers (pgrep status $status)." >&2; return 2 ;;
  esac
  WORKER_PIDS=''
  for candidate in $output; do
    case "$candidate" in ''|*[!0-9]*) echo 'Worker discovery returned an invalid PID.' >&2; return 2 ;; esac
    details=$(ps -o uid=,args= -p "$candidate" 2>/dev/null); status=$?
    if [ "$status" -ne 0 ]; then kill -0 "$candidate" 2>/dev/null && { echo "Could not verify worker PID $candidate." >&2; return 2; }; continue; fi
    read -r uid args <<EOFDETAILS
$details
EOFDETAILS
    [ "$uid" = "$(id -u)" ] || continue
    read -r executable script_arg _ <<EOFARGS
$args
EOFARGS
    executable=${executable##*/}
    case "$script_arg" in skills/browser/agent-worker.mjs|*/skills/browser/agent-worker.mjs) ;; *) continue ;; esac
    [ "$executable" = node ] || continue
    WORKER_PIDS="${WORKER_PIDS:+$WORKER_PIDS
}$candidate"
  done
  [ -n "$WORKER_PIDS" ] && return 0
  return 1
}

chrome_pids() {
  local output status candidate details uid args
  output=$(pgrep -f -- "$PROFILE" 2>/dev/null); status=$?
  [ "$status" -eq 0 ] || { [ "$status" -eq 1 ] && return 1; echo "Could not inspect Chrome profile processes (pgrep status $status)." >&2; return 2; }
  for candidate in $output; do
    details=$(ps -o uid=,args= -p "$candidate" 2>/dev/null) || { kill -0 "$candidate" 2>/dev/null && { echo "Could not verify profile process $candidate." >&2; return 2; }; continue; }
    read -r uid args <<EOFDETAILS
$details
EOFDETAILS
    [ "$uid" = "$(id -u)" ] || continue
    case "$args" in *Google\ Chrome*|*Google\ Chrome\ Helper*) printf '%s\n' "$candidate" ;; esac
  done
}

launchctl print "$DOMAIN" >/dev/null 2>&1 || { echo "No active GUI session in $DOMAIN; login requires an interactive macOS session." >&2; exit 1; }
if ! check_profile_path; then exit 1; fi
INSTALLED=0; LOADED=0; SUSPENDED=0; CHROME_DONE=0
[ ! -f "$PLIST" ] || INSTALLED=1
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then LOADED=1; fi
restore_worker() {
  [ "$SUSPENDED" -eq 1 ] || return 0
  local active_chrome active_worker result
  active_chrome=$(chrome_pids); result=$?
  [ "$result" -ne 2 ] || { echo 'Could not verify whether Chrome still owns the profile.' >&2; return 1; }
  [ -z "$active_chrome" ] || { echo "Worker remains unloaded. After Chrome exits, run: launchctl bootstrap $DOMAIN '$PLIST'" >&2; return 1; }
  discover_workers; active_worker=$?
  [ "$active_worker" -eq 1 ] || { echo 'Could not verify worker shutdown; leaving the LaunchAgent unloaded.' >&2; return 1; }
  check_profile_locks || { echo "Worker remains unloaded. Clear the profile through normal Chrome shutdown, then run: launchctl bootstrap $DOMAIN '$PLIST'" >&2; return 1; }
  [ "$INSTALLED" -eq 1 ] || { echo "Worker plist is missing; install LaunchAgents to restore the worker." >&2; return 1; }
  launchctl bootstrap "$DOMAIN" "$PLIST" || { echo "Could not restore worker. Run: launchctl bootstrap $DOMAIN '$PLIST'" >&2; return 1; }
  SUSPENDED=0
}
cleanup_signal() {
  trap - INT TERM HUP
  echo 'Login interrupted.' >&2
  if [ "$CHROME_DONE" -eq 1 ]; then restore_worker || :; else echo "Worker remains unloaded until Chrome exits and profile locks clear. Recovery: launchctl bootstrap $DOMAIN '$PLIST'" >&2; fi
  exit 130
}
cleanup_exit() {
  local status=$? active_chrome active_worker chrome_status worker_status
  trap - EXIT
  if [ "$SUSPENDED" -eq 1 ]; then
    active_chrome=$(chrome_pids); chrome_status=$?
    discover_workers; worker_status=$?
    if [ "$chrome_status" -eq 1 ] && [ "$worker_status" -eq 1 ] && check_profile_locks; then
      CHROME_DONE=1
      restore_worker || :
    else
      echo "Worker remains unloaded until Chrome, worker processes, and profile locks are clear. Recovery: launchctl bootstrap $DOMAIN '$PLIST'" >&2
    fi
  fi
  exit "$status"
}
trap cleanup_signal INT TERM HUP
trap cleanup_exit EXIT

if [ "$LOADED" -eq 1 ] && [ "$STOP_WORKER" -ne 1 ]; then echo "Worker LaunchAgent is loaded and may start during login. Re-run with --stop-worker to suspend it." >&2; exit 1; fi
if [ "$LOADED" -eq 1 ]; then
  launchctl bootout "$DOMAIN/$LABEL" || { echo "Could not unload worker LaunchAgent $LABEL." >&2; exit 1; }
  SUSPENDED=1
elif [ "$INSTALLED" -eq 1 ] && [ "$STOP_WORKER" -eq 1 ]; then
  echo 'Worker LaunchAgent was already unloaded; it will remain unloaded after login.'
fi

discover_workers; worker_status=$?
[ "$worker_status" -ne 2 ] || exit 1
if [ "$worker_status" -eq 0 ]; then
  [ "$STOP_WORKER" -eq 1 ] || { echo 'An agent-worker is running. Stop it before login, or use --stop-worker.' >&2; exit 1; }
  for worker_pid in $WORKER_PIDS; do kill -TERM "$worker_pid" 2>/dev/null || { kill -0 "$worker_pid" 2>/dev/null && { echo "Could not stop worker PID $worker_pid." >&2; exit 1; }; }; done
fi
remaining=30
while [ "$remaining" -gt 0 ]; do
  discover_workers; worker_status=$?; [ "$worker_status" -ne 2 ] || exit 1
  chrome_output=$(chrome_pids); chrome_status=$?; [ "$chrome_status" -ne 2 ] || exit 1
  [ "$worker_status" -eq 1 ] && [ -z "$chrome_output" ] && break
  sleep 1; remaining=$((remaining - 1))
done
[ "$remaining" -gt 0 ] || { echo 'Timed out waiting for worker and its Chrome process to stop.' >&2; exit 1; }
if ! check_profile_path || ! check_profile_locks; then exit 1; fi
discover_workers; worker_status=$?; [ "$worker_status" -eq 1 ] || { echo 'Worker still owns the profile; refusing to launch Chrome.' >&2; exit 1; }
open -n -W -a "$CHROME_APP" --args "--user-data-dir=$PROFILE" https://nid.naver.com/nidlogin.login
chrome_status=$?
CHROME_DONE=1
remaining=30
while [ "$remaining" -gt 0 ]; do
  chrome_output=$(chrome_pids); chrome_status_check=$?; [ "$chrome_status_check" -ne 2 ] || break
  if [ -z "$chrome_output" ] && check_profile_locks; then break; fi
  sleep 1; remaining=$((remaining - 1))
done
if [ "$remaining" -eq 0 ]; then echo 'Chrome has not released the dedicated profile. Worker remains unloaded.' >&2; exit 1; fi
if [ "$chrome_status" -ne 0 ]; then restore_worker || :; echo "Launch Services failed to open Chrome (status $chrome_status)." >&2; exit "$chrome_status"; fi
if [ "$SUSPENDED" -eq 1 ]; then restore_worker || exit 1
elif [ "$INSTALLED" -eq 1 ] && [ "$LOADED" -eq 0 ]; then echo "Worker was already unloaded and remains unloaded. Restart explicitly with: launchctl bootstrap $DOMAIN '$PLIST'"; fi
check_profile_path && check_profile_locks || exit 1
echo 'Chrome exited and released the profile. The worker can safely start again.'
