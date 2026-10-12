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
exit 1
STUB
cat > "$TMP/bin/plutil" <<'STUB'
#!/bin/bash
exit 0
STUB
cat > "$TMP/bin/launchctl" <<'STUB'
#!/bin/bash
echo "$*" >> "$TRACE"
case "$1" in
  print)
    if [ "$2" = gui/501 ]; then exit 0; fi
    grep -Fq "$2" "$STATE" && { echo 'state = running'; echo 'pid = 4321'; echo 'last exit code = 0'; exit 0; }
    exit 1 ;;
  bootstrap) echo "$2/$3" >> "$STATE" ;;
  bootout) tmp="$STATE.tmp"; grep -Fv "$2" "$STATE" > "$tmp" || true; mv "$tmp" "$STATE" ;;
  kickstart) : ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/"*
SCRIPT="$ROOT/bin/bpdus/install-launchagents.sh"
# Dry-run must not mutate launchctl or the filesystem.
before=$(wc -c < "$TRACE")
"$SCRIPT" install --dry-run all --gateway-id 'id<&' --audience 'https://example.test/a?x=1&y=2' --allowed-host 'host with spaces' > "$TMP/dry"
[ "$(wc -c < "$TRACE")" -eq "$before" ]
[ ! -e "$HOME/Library/LaunchAgents" ]
grep -Fq '===== worker =====' "$TMP/dry"
grep -Fq '===== gateway =====' "$TMP/dry"
grep -Fq 'id&lt;&amp;' "$TMP/dry"
grep -Fq 'host with spaces' "$TMP/dry"
grep -Fq "$HOME/.agbrowse-bpdus/src" "$TMP/dry"
"$SCRIPT" install --gateway-id gw --audience https://example.test/mcp --allowed-host 'allowed.example'
[ -f "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist" ]
[ -f "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist" ]
grep -Fq 'agent-gateway.mjs' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
grep -Fq 'allowed.example' "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist"
"$SCRIPT" restart gateway
grep -Fq 'kickstart -k gui/501/me.bpdus.agbrowse.gateway' "$TRACE"
printf 'gui/501/me.bpdus.agbrowse.gateway\n' >> "$STATE"
"$SCRIPT" restart gateway
grep -Fq 'bootstrap gui/501 ' "$TRACE"
"$SCRIPT" uninstall
[ ! -e "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist" ]
[ ! -e "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist" ]
echo 'bpdus-launchagents: PASS'
