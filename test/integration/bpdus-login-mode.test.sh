#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export LOGIN_TEST_ROOT="$TMP"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReadEndpoint } from './skills/browser/agent-ipc.mjs';
const root = process.env.LOGIN_TEST_ROOT;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'login-mode-')));
const appRoot = join(home, '.agbrowse-bpdus');
mkdirSync(appRoot, { recursive: true });
const source = join(appRoot, 'src', 'skills', 'browser');
mkdirSync(source, { recursive: true });
for (const file of ['agent-login-cli.mjs','agent-ipc.mjs','agent-read-error.mjs']) copyFileSync(join(process.cwd(),'skills/browser',file), join(source,file));
mkdirSync(join(home, '.agbrowse-bpdus'), { recursive: true });
const endpoint = await startReadEndpoint({ socketPath: join(home, '.agbrowse-bpdus', 'agent-worker.sock'), dispatch: async (op) => op === 'login.status' ? { mode: 'normal', ready: true } : { mode: op === 'login.start' ? 'login' : 'normal', ready: true } });
const script = join(process.cwd(), 'bin/bpdus/login-mode.sh');
const env = { ...process.env, HOME: home, AGBROWSE_NODE_BIN: process.execPath, AGBROWSE_ROOT: appRoot };
try {
  for (const mode of ['status','start','end']) {
    const child = spawn('bash', [script, mode], { env, stdio: ['ignore','pipe','pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr); assert.match(stdout, /^mode=(normal|login) ready=yes\n$/);
  }
  const invalid = spawn('bash', [script, 'quit'], { env, stdio: 'ignore' });
  const invalidCode = await new Promise((resolve) => invalid.on('close', resolve));
  assert.equal(invalidCode, 2);
} finally { await endpoint.close(); rmSync(home, { recursive: true, force: true }); }
console.log('bpdus-login-mode: PASS');
JS
