#!/bin/bash
set -euo pipefail

WORKER_LABEL=me.bpdus.agbrowse.worker
GATEWAY_LABEL=me.bpdus.agbrowse.gateway
HOST=${AGBROWSE_HOST:-127.0.0.1}
PORT=${AGBROWSE_PORT:-7420}
GATEWAY_ID=${AGBROWSE_GATEWAY_ID:-}
AUDIENCE=${AGBROWSE_AUDIENCE:-}
NODE_BIN=${AGBROWSE_NODE_BIN:-}
ALLOWED_HOSTS=()
ALLOWED_ORIGINS=()
DRY_RUN=0
ROOT=${AGBROWSE_ROOT:-"${HOME:-}/.agbrowse-bpdus"}
SRC="$ROOT/src"
DOMAIN="gui/$(id -u)"
PLIST_DIR="$HOME/Library/LaunchAgents"

usage() {
  cat <<'EOF'
Usage: install-launchagents.sh install [--dry-run [worker|gateway|all]] [configuration]
       install-launchagents.sh uninstall
       install-launchagents.sh restart [worker|gateway|all]
       install-launchagents.sh status

Configuration flags: --host, --port, --gateway-id, --audience,
--allowed-host (repeatable), --allowed-origin (repeatable), --node-bin.
Environment defaults: AGBROWSE_HOST, AGBROWSE_PORT, AGBROWSE_GATEWAY_ID,
AGBROWSE_AUDIENCE, AGBROWSE_ALLOWED_HOSTS (space separated),
AGBROWSE_ALLOWED_ORIGINS (space separated), AGBROWSE_NODE_BIN.
EOF
}

die() { echo "install-launchagents: $*" >&2; exit 1; }
WORKER_PLIST="$PLIST_DIR/$WORKER_LABEL.plist"
GATEWAY_PLIST="$PLIST_DIR/$GATEWAY_LABEL.plist"

read_env_lists() {
  local item
  for item in ${AGBROWSE_ALLOWED_HOSTS:-}; do ALLOWED_HOSTS+=("$item"); done
  for item in ${AGBROWSE_ALLOWED_ORIGINS:-}; do ALLOWED_ORIGINS+=("$item"); done
}

parse_config() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --host|--port|--gateway-id|--audience|--allowed-host|--allowed-origin|--node-bin)
        [ "$#" -ge 2 ] || die "Missing value for $1"
        key=$1; value=$2; shift 2
        case "$key" in
          --host) HOST=$value ;; --port) PORT=$value ;; --gateway-id) GATEWAY_ID=$value ;;
          --audience) AUDIENCE=$value ;; --node-bin) NODE_BIN=$value ;;
          --allowed-host) ALLOWED_HOSTS+=("$value") ;; --allowed-origin) ALLOWED_ORIGINS+=("$value") ;;
        esac
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

resolve_node() {
  local candidate
  if [ -n "$NODE_BIN" ]; then candidate=$NODE_BIN
  else candidate=$(PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" command -v node || true)
  fi
  [ -n "$candidate" ] || die "Node was not found in the configured PATH."
  case "$candidate" in /*) ;; *) candidate=$(PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" command -v "$candidate" || true) ;; esac
  [ -n "$candidate" ] && [ -x "$candidate" ] || die "Node executable is unavailable: $NODE_BIN"
  NODE_BIN=$candidate
}

validate_install() {
  [ "$(id -un)" = "jjbyun" ] || die "Run as the owning user jjbyun."
  if [ "$DRY_RUN" -eq 0 ]; then
    launchctl print "$DOMAIN" >/dev/null 2>&1 || die "GUI launchd domain $DOMAIN is unavailable; log into the Mac GUI first."
  fi
  [ "$HOST" = "127.0.0.1" ] || die "Gateway host must remain 127.0.0.1."
  case "$PORT" in ''|*[!0-9]*) die "Port must be an integer from 1 to 65535." ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Port must be an integer from 1 to 65535."
  [ -n "$GATEWAY_ID" ] || die "--gateway-id (or AGBROWSE_GATEWAY_ID) is required."
  [ -n "$AUDIENCE" ] || die "--audience (or AGBROWSE_AUDIENCE) is required."
  resolve_node
  [ -f "$SRC/skills/browser/agent-worker.mjs" ] || die "Worker source not found under $SRC."
  [ -f "$SRC/skills/browser/agent-gateway.mjs" ] || die "Gateway source not found under $SRC."
}

xml() {
  local value=$1
  value=${value//&/\&amp;}; value=${value//</\&lt;}; value=${value//>/\&gt;}
  value=${value//\"/\&quot;}; value=${value//\'/\&apos;}
  printf '%s' "$value"
}

string_entry() { printf '    <string>%s</string>\n' "$(xml "$1")"; }
arg_entry() { printf '    <string>%s</string>\n' "$(xml "$1")"; }

render_plist() {
  local service=$1 label source log arg host
  local args=()
  if [ "$service" = worker ]; then
    label=$WORKER_LABEL; source="$SRC/skills/browser/agent-worker.mjs"; log="$ROOT/logs/worker.log"
    args=("$NODE_BIN" "$source")
  else
    label=$GATEWAY_LABEL; source="$SRC/skills/browser/agent-gateway.mjs"; log="$ROOT/logs/gateway.log"
    args=("$NODE_BIN" "$source" --host "$HOST" --port "$PORT" --state-dir "$ROOT/state" --key-dir "$ROOT/keys" --gateway-id "$GATEWAY_ID" --audience "$AUDIENCE")
    for host in "${ALLOWED_HOSTS[@]}"; do args+=(--allowed-host "$host"); done
    for host in "${ALLOWED_ORIGINS[@]}"; do args+=(--allowed-origin "$host"); done
  fi
  cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>
EOF
  printf '  <string>%s</string>\n  <key>LimitLoadToSessionType</key>\n  <string>Aqua</string>\n  <key>WorkingDirectory</key>\n  <string>%s</string>\n  <key>ProgramArguments</key>\n  <array>\n' "$(xml "$label")" "$(xml "$SRC")"
  for arg in "${args[@]}"; do arg_entry "$arg"; done
  printf '  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>%s</string>\n    <key>PATH</key>\n    <string>%s</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>\n  <key>StandardOutPath</key>\n  <string>%s</string>\n  <key>StandardErrorPath</key>\n  <string>%s</string>\n</dict></plist>\n' "$(xml "$HOME")" "$(xml "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")" "$(xml "$log")" "$(xml "$log")"
}

label_for() { [ "$1" = worker ] && printf '%s' "$WORKER_LABEL" || printf '%s' "$GATEWAY_LABEL"; }
plist_for() { [ "$1" = worker ] && printf '%s' "$WORKER_PLIST" || printf '%s' "$GATEWAY_PLIST"; }
select_services() {
  case "${1:-all}" in worker|gateway) SERVICES=("$1") ;; all) SERVICES=(worker gateway) ;; *) die "Expected worker, gateway, or all." ;; esac
}
loaded() { launchctl print "$DOMAIN/$(label_for "$1")" >/dev/null 2>&1; }
bootout_if_loaded() { if loaded "$1"; then launchctl bootout "$DOMAIN/$(label_for "$1")" || die "launchctl bootout failed for $(label_for "$1")."; fi; }
wait_unloaded() {
  local service=$1 tries=15
  while loaded "$service" && [ "$tries" -gt 0 ]; do sleep 1; tries=$((tries - 1)); done
  loaded "$service" && die "Timed out waiting for $(label_for "$service") to unload."
}

install_agents() {
  local selection=${1:-all} service tmpw tmpg
  select_services "$selection"
  validate_install
  [ "$selection" = all ] || :
  if pgrep -f 'skills/browser/agent-(worker|gateway)[.]mjs' >/dev/null 2>&1; then
    die "Unmanaged agent process found. Stop the old herdr worker and gateway gracefully, verify Chrome/profile shutdown, then retry."
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    for service in "${SERVICES[@]}"; do
      printf '\n===== %s =====\n' "$service"; render_plist "$service"
    done
    return
  fi
  mkdir -p "$PLIST_DIR" "$ROOT/logs" || die "Could not create LaunchAgents/log directories."
  chmod 700 "$ROOT/logs"
  tmpw=$(mktemp "$PLIST_DIR/.agbrowse.worker.XXXXXX"); tmpg=$(mktemp "$PLIST_DIR/.agbrowse.gateway.XXXXXX")
  render_plist worker > "$tmpw"; render_plist gateway > "$tmpg"
  plutil -lint "$tmpw" >/dev/null && plutil -lint "$tmpg" >/dev/null || { rm -f "$tmpw" "$tmpg"; die "Generated plist validation failed."; }
  # Both files are staged and valid before either installed plist is replaced.
  bootout_if_loaded worker; wait_unloaded worker
  bootout_if_loaded gateway; wait_unloaded gateway
  mv -f "$tmpw" "$WORKER_PLIST"; mv -f "$tmpg" "$GATEWAY_PLIST"
  for service in "${SERVICES[@]}"; do
    launchctl bootstrap "$DOMAIN" "$(plist_for "$service")" || die "launchctl bootstrap failed for $(label_for "$service")."
  done
}

uninstall_agents() {
  [ "$(id -un)" = "jjbyun" ] || die "Run as the owning user jjbyun."
  launchctl print "$DOMAIN" >/dev/null 2>&1 || die "GUI launchd domain $DOMAIN is unavailable."
  local service file
  for service in worker gateway; do bootout_if_loaded "$service"; wait_unloaded "$service"; done
  for service in worker gateway; do file=$(plist_for "$service"); [ ! -e "$file" ] || rm -f "$file" || die "Could not remove $file."; done
}

restart_agents() {
  select_services "${1:-all}"
  [ "$(id -un)" = "jjbyun" ] || die "Run as the owning user jjbyun."
  launchctl print "$DOMAIN" >/dev/null 2>&1 || die "GUI launchd domain $DOMAIN is unavailable."
  local service file
  for service in "${SERVICES[@]}"; do
    file=$(plist_for "$service"); [ -f "$file" ] || die "Not installed: $file"
    if loaded "$service"; then launchctl kickstart -k "$DOMAIN/$(label_for "$service")" || die "launchctl kickstart failed for $(label_for "$service")."
    else launchctl bootstrap "$DOMAIN" "$file" || die "launchctl bootstrap failed for $(label_for "$service")."; fi
  done
}

status_agents() {
  local service label output pid exit_status state
  for service in worker gateway; do
    label=$(label_for "$service"); file=$(plist_for "$service")
    if [ -f "$file" ]; then echo "$service installed=yes"; else echo "$service installed=no"; fi
    if loaded "$service"; then
      output=$(launchctl print "$DOMAIN/$label") || die "Could not inspect $label."
      echo "$service loaded=yes"
      pid=$(printf '%s\n' "$output" | sed -n 's/^[[:space:]]*pid = //p' | head -1)
      exit_status=$(printf '%s\n' "$output" | sed -n 's/^[[:space:]]*last exit code = //p' | head -1)
      state=$(printf '%s\n' "$output" | sed -n 's/^[[:space:]]*state = //p' | head -1)
      [ -n "$pid" ] && echo "$service running=yes pid=$pid" || echo "$service running=no pid=none"
      echo "$service last_exit_status=${exit_status:-unknown} state=${state:-unknown}"
      if [ "$service" = gateway ] && [ -n "$pid" ]; then curl --fail --silent "http://127.0.0.1:$PORT/healthz" || echo "gateway healthz=failed"; fi
    else echo "$service loaded=no"; echo "$service running=no pid=none"; echo "$service last_exit_status=unknown"; fi
  done
}

read_env_lists
[ "$#" -gt 0 ] || { usage >&2; exit 2; }
command_name=$1; shift
case "$command_name" in
  install)
    if [ "${1:-}" = --dry-run ]; then DRY_RUN=1; shift; selection=all; case "${1:-}" in worker|gateway|all) selection=$1; shift ;; esac
    else selection=all; fi
    parse_config "$@"; install_agents "$selection" ;;
  uninstall) [ "$#" -eq 0 ] || die "uninstall takes no arguments."; uninstall_agents ;;
  restart) [ "$#" -le 1 ] || die "restart accepts at most one service."; restart_agents "${1:-all}" ;;
  status) [ "$#" -eq 0 ] || die "status takes no arguments."; status_agents ;;
  -h|--help|help) usage ;;
  *) usage >&2; die "Unknown command: $command_name" ;;
esac
