#!/bin/bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home with spaces"
ROOT="$HOME/.agbrowse-bpdus"
mkdir -p "$HOME/Library/LaunchAgents" "$TMP/bin" "$ROOT/src/skills/browser"
cp "$REPO"/skills/browser/*.mjs "$ROOT/src/skills/browser/"
mkdir -p "$ROOT/state" "$ROOT/keys" "$TMP/device-keys"
chmod 700 "$ROOT/state" "$ROOT/keys" "$TMP/device-keys"
touch "$HOME/Library/LaunchAgents/me.bpdus.agbrowse.gateway.plist" "$ROOT/state/loaded"
export HOME AGBROWSE_ROOT="$ROOT" AGBROWSE_NODE_BIN="$(command -v node)" TRACE="$TMP/trace" ACTIVE=0
cat > "$TMP/bin/launchctl" <<'STUB'
#!/bin/bash
echo "$*" >> "$TRACE"
case "$1" in
 print) [ -e "$ROOT/state/loaded" ] ;;
 bootout) rm -f "$ROOT/state/loaded" ;;
 bootstrap) touch "$ROOT/state/loaded" ;;
 *) exit 1 ;;
esac
STUB
cat > "$TMP/bin/pgrep" <<'STUB'
#!/bin/bash
if [ "${ACTIVE:-0}" = 1 ]; then echo 4242; exit 0; fi
exit 1
STUB
cat > "$TMP/bin/sleep" <<'STUB'
#!/bin/bash
:
STUB
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
DEVICE="$TMP/device-id"
REPO_ROOT="$REPO" DEVICE_FILE="$DEVICE" KEY_DIR="$TMP/device-keys" node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { createAuthService } from './skills/browser/agent-auth.mjs';
import { createDevFileKeyStore, createJsonStateStore } from './skills/browser/agent-auth-store.mjs';
const stateStore = createJsonStateStore({ directory: `${process.env.AGBROWSE_ROOT}/state` });
const keyStore = createDevFileKeyStore({ directory: `${process.env.AGBROWSE_ROOT}/keys` });
const deviceKeys = createDevFileKeyStore({ directory: process.env.KEY_DIR });
const auth = createAuthService({ stateStore, keyStore, gatewayId: 'test-gateway', audience: 'https://gateway.example/mcp' });
const publicKey = deviceKeys.ensureKey('test-device');
await auth.openPairingWindow();
const pending = await auth.submitPairing({ publicKey, name: 'test device', requestedScopes: ['browser:read'] });
const paired = await auth.confirmPairing({ pendingId: pending.pending_id, code: pending.confirmation_code, fingerprint: pending.fingerprint, grantedScopes: ['browser:read'] });
writeFileSync(process.env.DEVICE_FILE, paired.device_id);
auth.close(); deviceKeys.close();
JS
DEVICE_ID=$(cat "$DEVICE")
SCRIPT="$REPO/bin/bpdus/grant-login-scope.sh"
"$SCRIPT" "$DEVICE_ID" > "$TMP/grant.out"
grep -Fq 'Granted login:operate' "$TMP/grant.out"
[ -e "$ROOT/state/loaded" ]
node --input-type=module - "$ROOT/state/state.json" "$DEVICE_ID" <<'JS'
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const state=JSON.parse(readFileSync(process.argv[2],'utf8')); const device=state.devices[process.argv[3]];
assert.deepEqual(device.scopes,['browser:read','login:operate']); assert.equal(device.epoch,2);
JS
# Preserve an initially unloaded gateway state.
rm "$ROOT/state/loaded"
"$SCRIPT" "$DEVICE_ID" > "$TMP/grant-again.out"
[ ! -e "$ROOT/state/loaded" ]
# Refuse to write while gateway process ownership remains, then restore its prior loaded state.
touch "$ROOT/state/loaded"
ACTIVE=1; export ACTIVE
if "$SCRIPT" "$DEVICE_ID" > "$TMP/busy.out" 2> "$TMP/busy.err"; then exit 1; fi
grep -Fq 'writer did not stop' "$TMP/busy.err"
[ -e "$ROOT/state/loaded" ]
echo 'bpdus-grant-login-scope: PASS'
