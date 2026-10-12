#!/bin/bash
set -euo pipefail
if [ "$#" -ne 1 ]; then echo 'Usage: login-mode.sh start|end|status' >&2; exit 2; fi
case "$1" in start|end|status) ;; *) echo 'Usage: login-mode.sh start|end|status' >&2; exit 2 ;; esac
ROOT=${AGBROWSE_ROOT:-"$HOME/.agbrowse-bpdus"}
NODE=${AGBROWSE_NODE_BIN:-node}
exec "$NODE" "$ROOT/src/skills/browser/agent-login-cli.mjs" "$1"
