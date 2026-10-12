#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home with spaces"
mkdir -p "$HOME/.agbrowse-bpdus/src/skills/browser" "$TMP/bin"
touch "$HOME/.agbrowse-bpdus/src/skills/browser/agent-worker.mjs" "$HOME/.agbrowse-bpdus/src/skills/browser/agent-gateway.mjs"
export HOME AGBROWSE_ROOT="$HOME/.agbrowse-bpdus" PATH="$TMP/bin:$PATH" TRACE="$TMP/trace" STATE="$TMP/state"
touch "$TRACE" "$STATE"
cat > "$TMP/bin/id" <<'STUB'
#!/bin/bash
case "$1" in -u) echo 501 ;; -un) echo jjbyun ;; *) exit 1 ;; esac
STUB
cat > "$TMP/bin/node" <<'STUB'
#!/bin/bash
echo node
STUB
cat > "$TMP/bin/pgrep" <<'STUB'
#!/bin/bash
if [ "${MANAGED_RUNNING:-0}" = 1 ]; then
  case "$*" in
    *agent-worker*) grep -Fq 'me.bpdus.agbrowse.worker' "$STATE" && { echo 424242; [ "${MIXED_RUNNING:-0}" = 1 ] && echo 424244; exit 0; } ;;
    *agent-gateway*) grep -Fq 'me.bpdus.agbrowse.gateway' "$STATE" && { echo 424243; exit 0; } ;;
  esac
fi
exit 1
STUB
cat > "$TMP/bin/ps" <<'STUB'
#!/bin/bash
case "$*" in
  *424242*) echo "  501 node $HOME/.agbrowse-bpdus/src/skills/browser/agent-worker.mjs" ;;
  *424243*) echo "  501 node $HOME/.agbrowse-bpdus/src/skills/browser/agent-gateway.mjs" ;;
  *424244*) echo "  501 node $HOME/.agbrowse-bpdus/src/skills/browser/agent-worker.mjs" ;;
  *) exit 1 ;;
esac
STUB
cat > "$TMP/bin/plutil" <<'STUB'
#!/bin/bash
exit 0
STUB
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/bash
echo "$*" >> "$TRACE"
exit 0
STUB
cat > "$TMP/bin/launchctl" <<'STUB'
#!/bin/bash
echo "$*" >> "$TRACE"
[ "${FAIL_BOOTSTRAP:-0}" = 1 ] && { [ "$1" = bootstrap ] || [ "$1" = kickstart ]; } && exit 9
case "$1" in
  print)
    if [ "$2" = gui/501 ]; then exit 0; fi
    if grep -Fq "$2" "$STATE"; then
      echo 'state = running'
      case "$2" in *worker) echo 'pid = 424242' ;; *gateway) echo 'pid = 424243' ;; esac
      echo 'last exit code = 0'
      exit 0
    fi
    exit 1 ;;
  bootstrap) label=${3##*/}; label=${label%.plist}; echo "$2/$label" >> "$STATE" ;;
  bootout) tmp="$STATE.tmp"; grep -Fv "$2" "$STATE" > "$tmp" || true; mv "$tmp" "$STATE" ;;
  kickstart) : ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/"*
SCRIPT="$ROOT/bin/bpdus/install-launchagents.sh"
# Dry-run must not mutate launchctl or the filesystem.
before=$(wc -c < "$TRACE")
AGBROWSE_ALLOWED_HOSTS='environment.example' "$SCRIPT" install --dry-run all --gateway-id 'id<&' --audience 'https://example.test/a?x=1&y=2' --allowed-host 'host with spaces' > "$TMP/dry"
[ "$(wc -c < "$TRACE")" -eq "$before" ]
[ ! -e "$HOME/Library/LaunchAgents" ]
grep -Fq '===== worker =====' "$TMP/dry"
grep -Fq '===== gateway =====' "$TMP/dry"
grep -Fq 'id&lt;&amp;' "$TMP/dry"
grep -Fq 'host with spaces' "$TMP/dry"
! grep -Fq -- '--allowed-origin' "$TMP/dry"
! grep -Fq 'environment.example' "$TMP/dry"
grep -Fq "$HOME/.agbrowse-bpdus/src" "$TMP/dry"
"$SCRIPT" install --port 7444 --gateway-id gw --audience https://example.test/mcp --allowed-host 'allowed.example' --node-bin "$TMP/bin/node"
[ -f "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist" ]
[ -f "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist" ]
grep -Fq 'agent-gateway.mjs' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
grep -Fq 'allowed.example' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
grep -Fq "$TMP/bin/node" "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
grep -Fq '<key>ProgramArguments</key>' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
grep -Fq '<key>KeepAlive</key>\n  <true/>' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist" || grep -A1 -Fq '<key>KeepAlive</key>' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist"
grep -Fq '<dict><key>SuccessfulExit</key><false/></dict>' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
grep -Fq '<string>--state-dir</string>' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
if "$SCRIPT" install --host 0.0.0.0 --gateway-id gw --audience https://example.test/mcp > "$TMP/invalid.out" 2> "$TMP/invalid.err"; then exit 1; fi
grep -Fq 'must remain 127.0.0.1' "$TMP/invalid.err"

# Reinstall unloads exact labels before loading replacements.
MANAGED_RUNNING=1; export MANAGED_RUNNING
"$SCRIPT" install --port 7444 --gateway-id gw2 --audience https://example.test/mcp
"$SCRIPT" install --port 7444 --gateway-id gw3 --audience https://example.test/mcp
worker_boot=$(grep -nF 'bootout gui/501/me.bpdus.agbrowse.worker' "$TRACE" | tail -1 | cut -d: -f1)
gateway_boot=$(grep -nF 'bootout gui/501/me.bpdus.agbrowse.gateway' "$TRACE" | tail -1 | cut -d: -f1)
worker_load=$(grep -nF 'bootstrap gui/501 ' "$TRACE" | tail -2 | head -1 | cut -d: -f1)
[ "$worker_boot" -lt "$gateway_boot" ] && [ "$gateway_boot" -lt "$worker_load" ]
# A managed PID cannot hide an additional unmanaged process during preflight.
MIXED_RUNNING=1; export MIXED_RUNNING
bootouts_before=$(grep -c '^bootout ' "$TRACE" || true)
if "$SCRIPT" install --port 7444 --gateway-id rejected --audience https://example.test/mcp > "$TMP/mixed.out" 2> "$TMP/mixed.err"; then exit 1; fi
grep -Fq 'stray PID(s): 424244' "$TMP/mixed.err"
[ "$(grep -c '^bootout ' "$TRACE" || true)" -eq "$bootouts_before" ]
unset MIXED_RUNNING
"$SCRIPT" restart gateway
grep -Fq 'kickstart -k gui/501/me.bpdus.agbrowse.gateway' "$TRACE"
grep -Fv 'me.bpdus.agbrowse.worker' "$STATE" > "$STATE.tmp" || true; mv "$STATE.tmp" "$STATE"
"$SCRIPT" restart worker
grep -Fq "bootstrap gui/501 $HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist" "$TRACE"
"$SCRIPT" status > "$TMP/status"
grep -Fq 'worker installed=yes' "$TMP/status"
grep -Fq 'worker loaded=yes' "$TMP/status"
grep -Fq 'http://127.0.0.1:7444/healthz' "$TRACE"
touch "$HOME/Library/LaunchAgents/unrelated.plist"
FAIL_BOOTSTRAP=1; export FAIL_BOOTSTRAP
if "$SCRIPT" restart gateway > "$TMP/failure.out" 2> "$TMP/failure.err"; then exit 1; fi
grep -Fq 'kickstart failed' "$TMP/failure.err"
unset FAIL_BOOTSTRAP
"$SCRIPT" uninstall
[ ! -e "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist" ]
[ ! -e "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist" ]
[ -e "$HOME/Library/LaunchAgents/unrelated.plist" ]
echo 'bpdus-launchagents: PASS'
