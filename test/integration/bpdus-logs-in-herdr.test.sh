#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home with spaces"
mkdir -p "$HOME/.agbrowse-bpdus/src" "$TMP/bin"
export HOME TRACE="$TMP/trace" EXISTING=0
cat > "$TMP/bin/node" <<'STUB'
#!/bin/bash
exec /usr/bin/node "$@"
STUB
cat > "$TMP/bin/herdr" <<'STUB'
#!/bin/bash
echo "$*" >> "$TRACE"
case "$1 $2" in
  'tab list') if [ "$EXISTING" = 1 ]; then echo 'agbrowse running'; fi; exit 0 ;;
  'tab create') printf '{"result":{"pane_id":"pane-left"}}\n' ;;
  'pane split') printf '{"pane_id":"pane-right"}\n' ;;
  'pane run') : ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:/usr/bin:/bin"
"$ROOT/bin/bpdus/logs-in-herdr.sh" > "$TMP/out"
grep -Fq "tail -F '$HOME/.agbrowse-bpdus/logs/worker.log'" "$TRACE"
grep -Fq "tail -F '$HOME/.agbrowse-bpdus/logs/gateway.log'" "$TRACE"
grep -Fq 'pane split pane-left --direction right' "$TRACE"
EXISTING=1; export EXISTING
if "$ROOT/bin/bpdus/logs-in-herdr.sh" > "$TMP/existing.out" 2> "$TMP/existing.err"; then exit 1; fi
grep -Fq "tab 'agbrowse' already exists" "$TMP/existing.err"
echo 'bpdus-logs-in-herdr: PASS'
