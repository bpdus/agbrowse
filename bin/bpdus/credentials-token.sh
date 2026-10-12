#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node skills/browser/agent-credentials-admin.mjs > /dev/tty
