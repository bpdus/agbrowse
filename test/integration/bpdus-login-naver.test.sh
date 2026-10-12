#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
HOME="$TMP/home"
BIN="$TMP/bin"
APP="$TMP/Google Chrome.app"
LABEL=me.bpdus.agbrowse.worker
mkdir -p "$HOME/.agbrowse-bpdus/agent-profile" "$HOME/Library/LaunchAgents" "$BIN" "$APP/Contents/MacOS"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
touch "$PLIST"
export HOME TRACE="$TMP/trace" STATE="$TMP/state" PROFILE="$HOME/.agbrowse-bpdus/agent-profile" APP
: > "$TRACE"; : > "$STATE"
cat > "$APP/Contents/MacOS/Google Chrome" <<'STUB'
#!/bin/bash
exit 0
STUB
cat > "$BIN/id" <<'STUB'
#!/bin/bash
[ "$1" = -u ] && { echo 501; exit; }
exec /usr/bin/id "$@"
STUB
cat > "$BIN/pgrep" <<'STUB'
#!/bin/bash
case "$*" in
  *agent-worker*) [ "${WORKER_RUNNING:-0}" = 1 ] && { echo 424242; exit 0; } || exit 1 ;;
  *agent-profile*) [ -e "$TMP_CHROME_PROCESS" ] && { echo 434343; exit 0; } || exit 1 ;;
  *) exit 1 ;;
esac
STUB
cat > "$BIN/ps" <<'STUB'
#!/bin/bash
case "$*" in *424242*) echo "  501 node /Users/jjbyun/.agbrowse-bpdus/src/skills/browser/agent-worker.mjs" ;; *434343*) echo "  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$PROFILE" ;; *) exit 1 ;; esac
STUB
cat > "$BIN/launchctl" <<'STUB'
#!/bin/bash
echo "$*" >> "$TRACE"
case "$1" in
 print) [ "$2" = gui/501 ] && exit 0; grep -Fq "$2" "$STATE" ;;
 bootout) grep -Fv "$2" "$STATE" > "$STATE.tmp" || true; mv "$STATE.tmp" "$STATE" ;;
 bootstrap) echo "$2/$3" >> "$STATE" ;;
 *) exit 1 ;;
esac
STUB
cat > "$BIN/open" <<'STUB'
echo "$*" >> "$TRACE"
printf '%s\n' "$@" > "$OPEN_ARGS"
touch "$TMP_CHROME_PROCESS" "$PROFILE/SingletonLock"
if [ "${HOLD_OPEN:-0}" = 1 ]; then while [ ! -e "$OPEN_RELEASE" ]; do /bin/sleep 0.02; done; fi
rm -f "$TMP_CHROME_PROCESS" "$PROFILE/SingletonLock"
exit "${OPEN_STATUS:-0}"
STUB
cat > "$BIN/sleep" <<'STUB'
[ "${FAST_SLEEP:-0}" = 1 ] && exit 0
exec /bin/sleep "$@"
STUB
chmod +x "$BIN/"* "$APP/Contents/MacOS/Google Chrome"
export PATH="$BIN:/usr/bin:/bin" CHROME_APP="$APP" TMP_CHROME_PROCESS="$TMP/chrome-process" OPEN_ARGS="$TMP/open-args" OPEN_RELEASE="$TMP/open-release"
SCRIPT="$ROOT/bin/bpdus/login-naver.sh"

# A loaded service blocks an unapproved profile handoff.
echo "gui/501/$LABEL" > "$STATE"
if "$SCRIPT" > "$TMP/no-stop.out" 2> "$TMP/no-stop.err"; then exit 1; fi
grep -Fq 'is loaded' "$TMP/no-stop.err"
[ -e "$STATE" ]

# Explicit handoff unloads before Launch Services, waits through Chrome's profile lock, then restores.
HOLD_OPEN=1; export HOLD_OPEN
"$SCRIPT" --stop-worker > "$TMP/login.out" 2> "$TMP/login.err" & LOGIN_PID=$!
tries=0
while [ ! -e "$TMP_CHROME_PROCESS" ] && [ "$tries" -lt 100 ]; do /bin/sleep .02; tries=$((tries + 1)); done
[ -e "$TMP_CHROME_PROCESS" ]
grep -Fq "bootout gui/501/$LABEL" "$TRACE"
if grep -Fq "bootstrap gui/501 $PLIST" "$TRACE"; then exit 1; fi
grep -Fxq -- '-n' "$OPEN_ARGS"
grep -Fxq -- '-W' "$OPEN_ARGS"
grep -Fxq -- "$APP" "$OPEN_ARGS"
grep -Fxq -- "--user-data-dir=$PROFILE" "$OPEN_ARGS"
grep -Fxq -- 'https://nid.naver.com/nidlogin.login' "$OPEN_ARGS"
: > "$OPEN_RELEASE"
wait "$LOGIN_PID"
[ -e "$PLIST" ]
boot_line=$(grep -nF "bootout gui/501/$LABEL" "$TRACE" | head -1 | cut -d: -f1)
open_line=$(grep -nF -- "-n -W -a $APP" "$TRACE" | head -1 | cut -d: -f1)
restore_line=$(grep -nF "bootstrap gui/501 $PLIST" "$TRACE" | head -1 | cut -d: -f1)
[ "$boot_line" -lt "$open_line" ] && [ "$open_line" -lt "$restore_line" ]
! grep -E -- '--use-mock-keychain|--password-store=basic' "$TRACE"

# Pre-existing unloaded state stays unloaded and emits explicit recovery guidance.
: > "$TRACE"
"$SCRIPT" > "$TMP/unloaded.out"
! grep -Fq "bootstrap gui/501 $PLIST" "$TRACE"
grep -Fq 'remains unloaded' "$TMP/unloaded.out"

# Launch failure does not restore while Chrome still owns its profile; a clean failure can restore.
echo "gui/501/$LABEL" > "$STATE"
OPEN_STATUS=7; HOLD_OPEN=0; export OPEN_STATUS HOLD_OPEN
if "$SCRIPT" --stop-worker > "$TMP/fail.out" 2> "$TMP/fail.err"; then exit 1; fi
grep -Fq 'Launch Services failed' "$TMP/fail.err"

# Interruption keeps the worker unloaded while Chrome owns the profile and restores after release.
echo "gui/501/$LABEL" > "$STATE"
rm -f "$OPEN_RELEASE" "$TMP_CHROME_PROCESS"
OPEN_STATUS=0; HOLD_OPEN=1; export OPEN_STATUS HOLD_OPEN
"$SCRIPT" --stop-worker > "$TMP/interrupted.out" 2> "$TMP/interrupted.err" & LOGIN_PID=$!
tries=0
while [ ! -e "$TMP_CHROME_PROCESS" ] && [ "$tries" -lt 100 ]; do /bin/sleep .02; tries=$((tries + 1)); done
[ -e "$TMP_CHROME_PROCESS" ]
kill -TERM "$LOGIN_PID"
/bin/sleep .05
! grep -Fq "bootstrap gui/501 $PLIST" "$TRACE"
touch "$OPEN_RELEASE"
wait "$LOGIN_PID" || true
grep -Fq 'Login interrupted' "$TMP/interrupted.err"
grep -Fq "bootstrap gui/501 $PLIST" "$TRACE"

# Absolute worker script paths are recognized and still require the explicit stop flag.
WORKER_RUNNING=1 FAST_SLEEP=1
export WORKER_RUNNING FAST_SLEEP
if "$SCRIPT" --stop-worker > "$TMP/worker-timeout.out" 2> "$TMP/worker-timeout.err"; then exit 1; fi
grep -Fq 'Timed out waiting' "$TMP/worker-timeout.err" || { cat "$TMP/worker-timeout.err"; exit 1; }

echo 'bpdus-login-naver: PASS'
