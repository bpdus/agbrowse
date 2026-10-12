#!/bin/bash
set -euo pipefail

HOME_DIR=${HOME:?HOME must be set}
ROOT="$HOME_DIR/.agbrowse-bpdus"
SRC="$ROOT/src"
WORKER_LOG="$ROOT/logs/worker.log"
GATEWAY_LOG="$ROOT/logs/gateway.log"
HERDR=${HERDR_BIN:-herdr}
NODE=${NODE_BIN:-node}

fail() { echo "logs-in-herdr: $*" >&2; exit 1; }
[ -d "$SRC" ] || fail "Source directory is missing: $SRC"
command -v "$HERDR" >/dev/null 2>&1 || fail "herdr executable was not found."
command -v "$NODE" >/dev/null 2>&1 || fail "Node executable was not found."

existing=$($HERDR tab list 2>&1) || fail "Could not inspect existing herdr tabs: $existing"
if printf '%s\n' "$existing" | grep -E '(^|[^[:alnum:]_-])agbrowse([^[:alnum:]_-]|$)' >/dev/null; then
  fail "herdr tab 'agbrowse' already exists; close or rename it before creating the log view."
fi

pane_id() {
  "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const f=o=>{if(o&&typeof o==="object"){for(const[k,v]of Object.entries(o)){if(k==="pane_id"&&typeof v==="string"&&v)return v;const r=f(v);if(r)return r}}};const id=f(JSON.parse(s));if(!id)process.exit(2);console.log(id)}catch{process.exit(2)}})' || return 1
}
shell_quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

left=$($HERDR tab create --label agbrowse --cwd "$SRC" | pane_id) || fail "Could not create herdr tab or parse its pane ID."
[ -n "$left" ] || fail 'herdr returned an empty left pane ID.'
right=$($HERDR pane split "$left" --direction right --cwd "$SRC" | pane_id) || fail "Could not split the log-view tab or parse its right pane ID."
[ -n "$right" ] || fail 'herdr returned an empty right pane ID.'
worker_command="tail -F $(shell_quote "$WORKER_LOG")"
gateway_command="tail -F $(shell_quote "$GATEWAY_LOG")"
$HERDR pane run "$left" "$worker_command" || fail 'Could not start the worker log viewer.'
$HERDR pane run "$right" "$gateway_command" || fail 'Could not start the gateway log viewer.'
echo "Log viewers started in herdr tab agbrowse (worker=$left gateway=$right). Closing these panes stops only tail; launchd owns service lifecycle."
