#!/usr/bin/env node
// Reproducible Chromium (chrome target) build driver for macOS.
// Steps: prepare | sync | gen | build | status. See browser/build-spec.md.
// Zero-dependency ESM, Node 24. Every external command is an argv array (no shell).

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1, // a child exited non-zero but reported no usable code
  USAGE: 2, // bad CLI input (unknown step, bad arch, bad jobs)
  PRECONDITION: 3, // environment/path/state does not allow the step
  TOOL_MISSING: 4, // git, python3, depot_tools, full Xcode, ...
  VERIFY_FAILED: 5, // a step ran but its result does not match the lock
});

export const STEPS = Object.freeze(['prepare', 'sync', 'gen', 'build', 'status']);
export const ARCHES = Object.freeze(['arm64', 'x64']);
export const LIPO_ARCH = Object.freeze({ arm64: 'arm64', x64: 'x86_64' });
export const DEPOT_TOOLS_URL = 'https://chromium.googlesource.com/chromium/tools/depot_tools.git';
export const EXPECTED_REPOSITORY = 'https://chromium.googlesource.com/chromium/src.git';
// build/config/mac/mac_sdk.gni at the locked commit (chromium-research/build_config_mac_mac_sdk.gni).
export const MAC_SDK_OFFICIAL_VERSION = '26.5';
// Same file: "Xcode 27+ is ARM-only"; Intel hosts need universal Xcode (< 27).
export const XCODE_ARM_ONLY_MAJOR = 27;
export const DEFAULT_MIN_FREE_GIB = Object.freeze({ prepare: 120, sync: 120, gen: 60, build: 50 });
export const DEFAULT_SYNC_JOBS = 8;
export const MAX_SYNC_JOBS = 32;
export const STATE_FILE = '.build-driver-state.json';
export const LOCK_FILE = '.build-driver.lock';
// Tokens that must never appear in any argv this driver executes.
export const FORBIDDEN_TOKENS = Object.freeze([
  'reset', 'clean', 'rm', '--force', '-f', '--reset', '-D', '--delete_unversioned_trees',
  '--upstream', 'checkout', 'stash', 'rebase-update', '-s', '--switch', '--install',
]);
// Paths Chromium accepts: no spaces (docs/mac_build_instructions.md); we also refuse shell metacharacters.
const SAFE_PATH = /^\/[A-Za-z0-9._\/+@-]*$/;

export class DriverError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new DriverError(code, message);
};

// ---------------------------------------------------------------- CLI

const USAGE = `usage: node browser/build.mjs <prepare|sync|gen|build|status> [options]
  --arch arm64|x64            target_cpu (required for gen/build)
  --jobs N                    explicit ninja job limit (required for build, 1..hw.ncpu)
  --sync-jobs N               gclient sync -j (default ${DEFAULT_SYNC_JOBS}, max ${MAX_SYNC_JOBS})
  --project-root DIR          product repo root (default: parent of browser/)
  --work-root DIR             checkout/cache root (default: project/work)
  --checkout-configuration small|default   DEPS checkout_configuration (default small)
  --revision-source commit|tag             value given to gclient --revision (default commit)
  --min-free-gib N            override disk free threshold for this step
  --allow-sdk-below-official  allow macOS SDK older than ${MAC_SDK_OFFICIAL_VERSION}
  --pin-depot-tools           set DEPOT_TOOLS_UPDATE=0 for child processes
  --caffeinate                wrap sync/build with /usr/bin/caffeinate -i
  --dry-run                   run read-only probes, print planned writes/argv, change nothing
  --json                      status: machine-readable output`;

const VALUE_OPTS = new Set(['--arch', '--jobs', '--sync-jobs', '--project-root', '--work-root', '--checkout-configuration',
  '--revision-source', '--min-free-gib']);
const FLAG_OPTS = new Set(['--allow-sdk-below-official', '--pin-depot-tools', '--caffeinate',
  '--dry-run', '--json', '--help']);

const camel = (flag) => flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseIntStrict(name, value, min, max) {
  if (!/^[0-9]+$/.test(value)) fail(EXIT.USAGE, `${name} must be an integer, got "${value}"`);
  const n = Number(value);
  if (n < min || n > max) fail(EXIT.USAGE, `${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

export function parseCli(argv) {
  const opts = { step: null, pinDepotTools: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (opts.step) fail(EXIT.USAGE, `unexpected argument "${a}"`);
      opts.step = a;
      continue;
    }
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (FLAG_OPTS.has(flag)) {
      if (inline !== null) fail(EXIT.USAGE, `${flag} takes no value`);
      opts[camel(flag)] = true;
    } else if (VALUE_OPTS.has(flag)) {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(EXIT.USAGE, `${flag} needs a value`);
      opts[camel(flag)] = v;
    } else {
      fail(EXIT.USAGE, `unknown option "${flag}"`);
    }
  }
  if (opts.help) return opts;
  if (!STEPS.includes(opts.step)) fail(EXIT.USAGE, `step must be one of ${STEPS.join('/')}, got "${opts.step ?? ''}"`);
  if (opts.arch !== undefined && !ARCHES.includes(opts.arch)) {
    fail(EXIT.USAGE, `--arch must be arm64 or x64, got "${opts.arch}"`);
  }
  if ((opts.step === 'gen' || opts.step === 'build') && !opts.arch) fail(EXIT.USAGE, `${opts.step} requires --arch`);
  if (opts.step === 'build' && opts.jobs === undefined) fail(EXIT.USAGE, 'build requires an explicit --jobs N');
  if (opts.jobs !== undefined) opts.jobs = parseIntStrict('--jobs', opts.jobs, 1, 4096);
  opts.syncJobs = opts.syncJobs === undefined ? DEFAULT_SYNC_JOBS : parseIntStrict('--sync-jobs', opts.syncJobs, 1, MAX_SYNC_JOBS);
  if (opts.minFreeGib !== undefined) opts.minFreeGib = parseIntStrict('--min-free-gib', opts.minFreeGib, 1, 100000);
  opts.checkoutConfiguration ??= 'small';
  if (!['small', 'default'].includes(opts.checkoutConfiguration)) {
    fail(EXIT.USAGE, '--checkout-configuration must be small or default');
  }
  opts.revisionSource ??= 'commit';
  if (!['commit', 'tag'].includes(opts.revisionSource)) fail(EXIT.USAGE, '--revision-source must be commit or tag');
  return opts;
}

// ---------------------------------------------------------------- lock + layout

export function loadLock(lockPath) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (e) {
    fail(EXIT.PRECONDITION, `cannot read lock ${lockPath}: ${e.message}`);
  }
  if (lock.repository !== EXPECTED_REPOSITORY) fail(EXIT.PRECONDITION, `lock repository must be ${EXPECTED_REPOSITORY}`);
  if (!/^[0-9a-f]{40}$/.test(lock.commit ?? '')) fail(EXIT.PRECONDITION, 'lock commit must be a 40-char lowercase SHA-1');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(lock.tag ?? '')) fail(EXIT.PRECONDITION, 'lock tag must look like MAJOR.MINOR.BUILD.PATCH');
  if (lock.target !== 'chrome') fail(EXIT.PRECONDITION, 'lock target must be "chrome"');
  if (lock.depot_tools_repository !== DEPOT_TOOLS_URL || !/^[0-9a-f]{40}$/.test(lock.depot_tools_commit ?? '')) {
    fail(EXIT.PRECONDITION, 'lock must pin the official depot_tools repository and commit');
  }
  if (!Array.isArray(lock.architectures) || !lock.architectures.every((a) => ARCHES.includes(a))) {
    fail(EXIT.PRECONDITION, 'lock architectures must be a subset of arm64/x64');
  }
  return lock;
}

export function resolveLayout(projectRoot, workRoot) {
  const root = path.resolve(projectRoot);
  const workDir = path.resolve(workRoot ?? path.join(root, 'work'));
  const chromiumDir = path.join(workDir, 'chromium');
  return {
    projectRoot: root,
    lockPath: path.join(root, 'browser', 'chromium.lock.json'),
    workDir,
    chromiumDir,
    srcDir: path.join(chromiumDir, 'src'),
    gclientFile: path.join(chromiumDir, '.gclient'),
    stateFile: path.join(chromiumDir, STATE_FILE),
    lockFile: path.join(chromiumDir, LOCK_FILE),
    depotToolsDir: path.join(workDir, 'depot_tools'),
    vpythonRoot: path.join(workDir, 'vpython'),
  };
}

export const outDirName = (arch) => `Release-${arch}`;
export const outDirRel = (arch) => path.posix.join('out', outDirName(arch));

function nearestExisting(p) {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

export function validatePaths(layout, home) {
  for (const [name, p] of Object.entries({ projectRoot: layout.projectRoot, workDir: layout.workDir,
    chromiumDir: layout.chromiumDir, depotToolsDir: layout.depotToolsDir })) {
    if (/\s/.test(p)) fail(EXIT.PRECONDITION, `${name} contains whitespace; Chromium requires a path without spaces: "${p}"`);
    if (!SAFE_PATH.test(p)) fail(EXIT.PRECONDITION, `${name} has characters outside [A-Za-z0-9._/+@-]: "${p}"`);
    const real = fs.realpathSync(nearestExisting(p));
    if (/\s/.test(real) || !SAFE_PATH.test(real)) fail(EXIT.PRECONDITION, `${name} resolves to an unsafe real path "${real}"`);
  }
  if (home) {
    const forbidden = [
      path.join(home, 'Library', 'Application Support', 'Google'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
    ];
    for (const f of forbidden) {
      if (layout.chromiumDir === f || layout.chromiumDir.startsWith(f + path.sep)) {
        fail(EXIT.PRECONDITION, `refusing to place the checkout inside user browser data (${f})`);
      }
    }
    if (layout.projectRoot === home) fail(EXIT.PRECONDITION, 'project root must not be the home directory itself');
  }
}

// ---------------------------------------------------------------- generated files

export function renderGclient(lock, checkoutConfiguration) {
  return [
    '# Generated by browser/build.mjs from browser/chromium.lock.json. Do not edit by hand.',
    `# tag ${lock.tag}`,
    'solutions = [',
    '  {',
    '    "name": "src",',
    `    "url": "${lock.repository}@${lock.commit}",`,
    '    "managed": False,',
    '    "custom_deps": {},',
    '    "custom_vars": {',
    `      "checkout_configuration": "${checkoutConfiguration}",`,
    '    },',
    '  },',
    ']',
    'target_os = ["mac"]',
    '',
  ].join('\n');
}

export function gnArgs(arch) {
  if (!ARCHES.includes(arch)) fail(EXIT.USAGE, `invalid arch "${arch}"`);
  return [
    ['target_os', '"mac"'],
    ['target_cpu', `"${arch}"`],
    ['is_debug', 'false'],
    ['is_component_build', 'true'],
    ['symbol_level', '0'],
    ['use_system_xcode', 'true'],
    ['is_official_build', 'false'],
    ['is_chrome_branded', 'false'],
    ['use_remoteexec', 'false'],
  ];
}

export function renderArgsGn(arch) {
  return [
    '# Generated by browser/build.mjs. Do not edit; use a different out dir for experiments.',
    ...gnArgs(arch).map(([k, v]) => `${k} = ${v}`),
    '',
  ].join('\n');
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- argv builders

export function depotTool(layout, name) {
  return path.join(layout.depotToolsDir, name);
}

export function syncArgv(layout, lock, opts) {
  const rev = opts.revisionSource === 'tag' ? `refs/tags/${lock.tag}` : lock.commit;
  const argv = [depotTool(layout, 'gclient'), 'sync', '--no-history', '--revision', `src@${rev}`,
    '--jobs', String(opts.syncJobs)];
  return opts.caffeinate ? ['/usr/bin/caffeinate', '-i', ...argv] : argv;
}

export function gnGenArgv(layout, arch) {
  return [depotTool(layout, 'gn'), 'gen', outDirRel(arch)];
}

export function buildArgv(layout, arch, jobs, opts = {}) {
  const argv = [depotTool(layout, 'autoninja'), '-C', outDirRel(arch), '-j', String(jobs), 'chrome'];
  return opts.caffeinate ? ['/usr/bin/caffeinate', '-i', ...argv] : argv;
}

export function assertSafeArgv(argv) {
  for (const t of argv.slice(1)) {
    if (FORBIDDEN_TOKENS.includes(t)) fail(EXIT.PRECONDITION, `internal safety check: refusing argv with "${t}": ${JSON.stringify(argv)}`);
  }
}

export function childEnv(layout, opts, baseEnv = process.env) {
  const env = { ...baseEnv };
  // Upstream docs append depot_tools to PATH; tools are still invoked by absolute path.
  env.PATH = `${baseEnv.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}:${layout.depotToolsDir}`;
  env.VPYTHON_VIRTUALENV_ROOT = layout.vpythonRoot;
  env.CIPD_CACHE_DIR = path.join(layout.workDir, 'cipd-cache');
  env.DEPOT_TOOLS_METRICS = '0';
  if (opts.pinDepotTools) env.DEPOT_TOOLS_UPDATE = '0';
  return env;
}

// ---------------------------------------------------------------- runner

export function defaultRunner(argv, { cwd, env, capture = true, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error: e.code ?? e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let escalation = null;
    const killGroup = (signal) => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
      catch (e) { if (e.code !== 'ESRCH') spawnError = e.code ?? e.message; }
    };
    const interrupt = (signal) => {
      killGroup(signal);
      escalation ??= setTimeout(() => killGroup('SIGKILL'), 5000);
      escalation.unref();
    };
    const sigint = () => interrupt('SIGINT');
    const sigterm = () => interrupt('SIGTERM');
    const sighup = () => interrupt('SIGTERM');
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    process.on('SIGHUP', sighup);
    const timeout = capture ? setTimeout(() => interrupt('SIGTERM'), timeoutMs) : null;
    timeout?.unref();
    child.stdout?.on('data', (d) => { stdout = (stdout + d).slice(-16 * 1024 * 1024); });
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-16 * 1024 * 1024); });
    child.on('error', (e) => { spawnError = e.code ?? e.message; });
    child.on('close', (code, signal) => {
      process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); process.off('SIGHUP', sighup);
      clearTimeout(timeout); clearTimeout(escalation);
      resolve({ code, signal, stdout, stderr, error: spawnError });
    });
  });
}

export function exitCodeOf(res) {
  if (res.error === 'ENOENT') return EXIT.TOOL_MISSING;
  if (res.signal) {
    const n = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[res.signal] ?? 0;
    return 128 + n;
  }
  if (typeof res.code === 'number') return res.code;
  return EXIT.FAILURE;
}

// ---------------------------------------------------------------- probes

async function probe(ctx, argv, cwd, timeoutMs = 15000) {
  const res = await ctx.run(argv, { cwd, env: ctx.env, capture: true, timeoutMs });
  return { ok: res.error === null && res.code === 0, out: (res.stdout ?? '').trim(), res };
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export async function probeHost(ctx) {
  if (ctx.platform !== 'darwin') fail(EXIT.PRECONDITION, `macOS host required, got ${ctx.platform}`);
  if (!['arm64', 'x64'].includes(ctx.arch)) fail(EXIT.PRECONDITION, `unsupported node arch ${ctx.arch}`);
  const rosetta = 'driver is running under Rosetta translation; use a native arm64 node so gclient sees host_cpu=arm64';
  const translated = await probe(ctx, ['/usr/sbin/sysctl', '-n', 'sysctl.proc_translated']);
  if (translated.ok && translated.out === '1') fail(EXIT.PRECONDITION, rosetta);
  if (ctx.arch === 'x64') {
    const arm = await probe(ctx, ['/usr/sbin/sysctl', '-n', 'hw.optional.arm64']);
    if (arm.ok && arm.out === '1') fail(EXIT.PRECONDITION, rosetta);
    if (!translated.ok && !arm.ok) fail(EXIT.TOOL_MISSING, 'cannot rule out Rosetta: both translation and hardware probes failed');
  }
  const cpus = ctx.ncpu;
  if (!Number.isInteger(cpus) || cpus < 1) fail(EXIT.TOOL_MISSING, 'cannot determine logical CPU count');
  // A native (non-translated) node reports the real hardware arch.
  return { hostCpu: ctx.arch, ncpu: cpus };
}

export async function probeDisk(ctx, p) {
  const target = nearestExisting(p);
  const df = await probe(ctx, ['/bin/df', '-Pk', target]);
  if (!df.ok) fail(EXIT.TOOL_MISSING, `df failed for ${target}`);
  const line = df.out.split('\n').filter(Boolean).at(-1) ?? '';
  const cols = line.trim().split(/\s+/);
  const availKiB = Number(cols[3]);
  const mountPoint = cols.slice(5).join(' ');
  if (!Number.isFinite(availKiB) || !mountPoint) fail(EXIT.TOOL_MISSING, `cannot parse df output: ${line}`);
  const mount = await probe(ctx, ['/sbin/mount']);
  let fsType = null;
  if (mount.ok) {
    for (const l of mount.out.split('\n')) {
      const m = /^.+ on (.+) \(([^,)]+)/.exec(l);
      if (m && m[1] === mountPoint) fsType = m[2].trim();
    }
  }
  return { path: target, freeGiB: availKiB / (1024 * 1024), mountPoint, fsType };
}

export async function probeXcode(ctx, hostCpu, opts) {
  const sel = await probe(ctx, ['/usr/bin/xcode-select', '-p']);
  if (!sel.ok) fail(EXIT.TOOL_MISSING, 'xcode-select -p failed; install full Xcode (Command Line Tools alone are not enough)');
  if (sel.out.includes('CommandLineTools') || !sel.out.includes('.app/')) {
    fail(EXIT.TOOL_MISSING, `active developer dir is "${sel.out}"; full Xcode is required (CLT only). ` +
      'Select it manually (driver never runs xcode-select -s) or set DEVELOPER_DIR.');
  }
  const ver = await probe(ctx, ['/usr/bin/xcodebuild', '-version']);
  const m = /Xcode\s+([0-9.]+)[\s\S]*Build version\s+(\S+)/.exec(ver.out);
  if (!ver.ok || !m) fail(EXIT.TOOL_MISSING, `xcodebuild -version failed (license or install issue): ${ver.res.stderr ?? ''}`.trim());
  const first = await probe(ctx, ['/usr/bin/xcodebuild', '-checkFirstLaunchStatus']);
  if (!first.ok) fail(EXIT.PRECONDITION, 'Xcode first launch is not complete; run "xcodebuild -runFirstLaunch" manually');
  const sdk = await probe(ctx, ['/usr/bin/xcrun', '--sdk', 'macosx', '--show-sdk-version']);
  if (!sdk.ok || !/^\d+(\.\d+)*$/.test(sdk.out)) fail(EXIT.TOOL_MISSING, 'xcrun --sdk macosx --show-sdk-version failed');
  const xcodeVersion = m[1];
  const xcodeMajor = Number(xcodeVersion.split('.')[0]);
  if (hostCpu === 'x64' && xcodeMajor >= XCODE_ARM_ONLY_MAJOR) {
    fail(EXIT.PRECONDITION, `Xcode ${xcodeVersion} is ARM-only per mac_sdk.gni; Intel hosts need universal Xcode < ${XCODE_ARM_ONLY_MAJOR}`);
  }
  if (compareVersions(sdk.out, MAC_SDK_OFFICIAL_VERSION) < 0 && !opts.allowSdkBelowOfficial) {
    fail(EXIT.PRECONDITION, `macOS SDK ${sdk.out} < official ${MAC_SDK_OFFICIAL_VERSION}; pass --allow-sdk-below-official to try anyway`);
  }
  const metal = await probe(ctx, ['/usr/bin/xcrun', '--sdk', 'macosx', 'metal', '--version']);
  if (!metal.ok) fail(EXIT.TOOL_MISSING, 'Metal compiler is unavailable; install the Xcode MetalToolchain component before building');
  return { developerDir: sel.out, xcodeVersion, xcodeBuild: m[2], sdkVersion: sdk.out, metalVersion: metal.out };
}

async function probeBaseTools(ctx) {
  for (const argv of [['git', '--version'], ['python3', '--version']]) {
    const r = await probe(ctx, argv);
    if (!r.ok) fail(EXIT.TOOL_MISSING, `${argv[0]} is not available (${r.res.error ?? `exit ${r.res.code}`})`);
  }
}

export function depotToolsMissing(layout) {
  return ['gclient', 'gn', 'autoninja'].filter((t) => {
    try {
      fs.accessSync(depotTool(layout, t), fs.constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
}

export async function inspectSource(ctx, lock, { checkDirty = false } = {}) {
  const { srcDir } = ctx.layout;
  const info = { exists: fs.existsSync(srcDir), isGit: false, head: null, origin: null, dirty: null, version: null };
  if (!info.exists) return info;
  info.isGit = fs.existsSync(path.join(srcDir, '.git'));
  if (!info.isGit) return info;
  const head = await probe(ctx, ['git', '-C', srcDir, 'rev-parse', 'HEAD']);
  info.head = head.ok ? head.out : null;
  const origin = await probe(ctx, ['git', '-C', srcDir, 'config', '--get', 'remote.origin.url']);
  info.origin = origin.ok ? origin.out : null;
  if (checkDirty) {
    const st = await probe(ctx, ['git', '-C', srcDir, 'status', '--porcelain', '--untracked-files=no'], undefined, 60000);
    info.dirty = st.ok ? st.out.length > 0 : null;
  }
  info.version = readChromeVersion(srcDir);
  info.headMatches = info.head === lock.commit;
  info.versionMatches = info.version === lock.tag;
  return info;
}

export function readChromeVersion(srcDir) {
  try {
    const txt = fs.readFileSync(path.join(srcDir, 'chrome', 'VERSION'), 'utf8');
    const v = Object.fromEntries(txt.split('\n').filter((l) => l.includes('=')).map((l) => l.trim().split('=')));
    return [v.MAJOR, v.MINOR, v.BUILD, v.PATCH].join('.');
  } catch {
    return null;
  }
}

const normalizeUrl = (u) => (u ?? '').replace(/\/$/, '').replace(/\.git$/, '');

// ---------------------------------------------------------------- state

export function readState(layout) {
  try {
    return JSON.parse(fs.readFileSync(layout.stateFile, 'utf8'));
  } catch {
    return { schema: 1, sync: null, gen: {}, build: {} };
  }
}

function writeState(ctx, state) {
  if (ctx.dryRun) return;
  const tmp = `${ctx.layout.stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, ctx.layout.stateFile);
}

function acquireLock(ctx) {
  if (ctx.dryRun) return () => {};
  const { lockFile } = ctx.layout;
  const nonce = randomUUID();
  const content = JSON.stringify({pid: process.pid, nonce});
  try {
    fs.writeFileSync(lockFile, content, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    fail(EXIT.PRECONDITION, `driver lock already exists: ${lockFile}; inspect its owner before recovery`);
  }
  return () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8') === content) fs.unlinkSync(lockFile);
    } catch { /* already gone */ }
  };
}

// Write a file we own; never overwrite different content.
function writeOwnedFile(ctx, file, content, what) {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === content) return 'unchanged';
    fail(EXIT.PRECONDITION, `${what} exists with different content: ${file}. The driver does not overwrite it; ` +
      'inspect and move it aside manually.');
  }
  if (ctx.dryRun) {
    ctx.log(`[dry-run] would write ${file}`);
    return 'planned';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
  return 'written';
}

async function execStep(ctx, argv, cwd) {
  assertSafeArgv(argv);
  ctx.log(`$ (cwd ${cwd}) ${JSON.stringify(argv)}`);
  if (ctx.dryRun) {
    ctx.log('[dry-run] not executed');
    return { code: 0, signal: null, error: null, dryRun: true };
  }
  return ctx.run(argv, { cwd, env: ctx.env, capture: false });
}

// ---------------------------------------------------------------- shared preflight

async function preflight(ctx, step, { xcode }) {
  validatePaths(ctx.layout, ctx.home);
  const host = await probeHost(ctx);
  await probeBaseTools(ctx);
  const disk = await probeDisk(ctx, ctx.layout.chromiumDir);
  if (disk.fsType !== 'apfs') fail(EXIT.PRECONDITION, `checkout volume ${disk.mountPoint} is "${disk.fsType}", APFS required`);
  const min = ctx.opts.minFreeGib ?? DEFAULT_MIN_FREE_GIB[step];
  if (disk.freeGiB < min) {
    fail(EXIT.PRECONDITION, `only ${disk.freeGiB.toFixed(1)} GiB free on ${disk.mountPoint}; ${step} needs >= ${min} GiB`);
  }
  const xc = xcode ? await probeXcode(ctx, host.hostCpu, ctx.opts) : null;
  if (xcode) {
    const pointer = path.join(ctx.layout.depotToolsDir, 'python3_bin_reldir.txt');
    let relative = '';
    try { relative = fs.readFileSync(pointer, 'utf8').trim(); } catch {}
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      fail(EXIT.TOOL_MISSING, 'depot_tools Python bootstrap is missing; run the pinned ensure_bootstrap before gen/build');
    }
    try { fs.accessSync(path.join(ctx.layout.depotToolsDir, relative, 'python3'), fs.constants.X_OK); }
    catch { fail(EXIT.TOOL_MISSING, 'depot_tools bootstrapped Python is unavailable; run the pinned ensure_bootstrap'); }
  }
  ctx.log(`host ${host.hostCpu}, ${host.ncpu} cpus, ${disk.freeGiB.toFixed(1)} GiB free (${disk.fsType})` +
    (xc ? `, Xcode ${xc.xcodeVersion} (${xc.xcodeBuild}), SDK ${xc.sdkVersion}` : ''));
  return { host, disk, xcode: xc };
}

async function requireDepotTools(ctx) {
  const missing = depotToolsMissing(ctx.layout);
  if (missing.length) {
    fail(EXIT.TOOL_MISSING, `depot_tools missing ${missing.join(', ')} in ${ctx.layout.depotToolsDir}; ` +
      'provide the pinned depot_tools checkout before prepare');
  }
  const head = await probe(ctx, ['git', '-C', ctx.layout.depotToolsDir, 'rev-parse', 'HEAD']);
  const origin = await probe(ctx, ['git', '-C', ctx.layout.depotToolsDir, 'config', '--get', 'remote.origin.url']);
  if (!head.ok || head.out !== ctx.lock.depot_tools_commit || !origin.ok || normalizeUrl(origin.out) !== normalizeUrl(DEPOT_TOOLS_URL)) {
    fail(EXIT.PRECONDITION, `depot_tools does not match locked repository/commit ${ctx.lock.depot_tools_commit}; refusing to update it automatically`);
  }
}

function requireArchInLock(ctx, arch) {
  if (!ctx.lock.architectures.includes(arch)) fail(EXIT.USAGE, `arch ${arch} is not listed in the lock`);
}

function requireExistingSourceSafe(ctx, src, {allowIncomplete = false} = {}) {
  if (!src.exists) return;
  if (!src.isGit) fail(EXIT.PRECONDITION, `${ctx.layout.srcDir} exists but is not a git checkout; the driver will not delete it`);
  if (normalizeUrl(src.origin) !== normalizeUrl(ctx.lock.repository)) {
    fail(EXIT.PRECONDITION, `src origin is "${src.origin}", expected ${ctx.lock.repository}`);
  }
  if (src.dirty === null) fail(EXIT.PRECONDITION, 'cannot determine src dirty state; refusing to sync');
  if (src.dirty) {
    fail(EXIT.PRECONDITION, 'src has local modifications to tracked files; commit/stash them yourself (no automatic reset/clean)');
  }
  if (!src.headMatches && !(allowIncomplete && src.head === null)) fail(EXIT.PRECONDITION, `existing src HEAD ${src.head ?? '(unknown)'} differs from locked ${ctx.lock.commit}; refusing to move an existing checkout`);
}

function requireSourceAtLock(ctx, src) {
  if (!src.exists || !src.isGit) fail(EXIT.PRECONDITION, 'no source checkout; run prepare and sync');
  if (!src.headMatches) {
    fail(EXIT.VERIFY_FAILED, `src HEAD ${src.head ?? '(unknown)'} != locked ${ctx.lock.commit}; run sync (no automatic reset)`);
  }
  if (!src.versionMatches) fail(EXIT.VERIFY_FAILED, `chrome/VERSION is ${src.version}, lock tag is ${ctx.lock.tag}`);
}

function requireSyncComplete(ctx, state) {
  if (state.sync?.status !== 'completed' || state.sync.commit !== ctx.lock.commit) {
    fail(EXIT.PRECONDITION, `sync is not complete for ${ctx.lock.commit} (state: ${state.sync?.status ?? 'none'}); rerun sync`);
  }
  if (!fs.existsSync(path.join(ctx.layout.srcDir, 'build', 'config', 'gclient_args.gni'))) {
    fail(EXIT.VERIFY_FAILED, 'src/build/config/gclient_args.gni missing; gclient hooks did not finish, rerun sync');
  }
}

// ---------------------------------------------------------------- steps

async function stepPrepare(ctx) {
  const { layout } = ctx;
  await preflight(ctx, 'prepare', { xcode: false });
  if (!ctx.dryRun) fs.mkdirSync(layout.chromiumDir, { recursive: true });
  ctx.holdLock();
  await requireDepotTools(ctx);
  await warnIfTracked(ctx);
  const gclient = renderGclient(ctx.lock, ctx.opts.checkoutConfiguration);
  ctx.log(`.gclient: ${writeOwnedFile(ctx, layout.gclientFile, gclient, '.gclient')}`);
  const src = await inspectSource(ctx, ctx.lock, { checkDirty: true });
  requireExistingSourceSafe(ctx, src);
  const state = readState(layout);
  state.lockCommit = ctx.lock.commit;
  state.prepare = { at: ctx.now(), checkoutConfiguration: ctx.opts.checkoutConfiguration };
  writeState(ctx, state);
  ctx.log(`prepared ${layout.chromiumDir} for ${ctx.lock.tag} (${ctx.lock.commit}). This step did not download or build.`);
  return EXIT.OK;
}

async function warnIfTracked(ctx) {
  if (!fs.existsSync(path.join(ctx.layout.projectRoot, '.git'))) return;
  const r = await probe(ctx, ['git', '-C', ctx.layout.projectRoot, 'check-ignore', '-q', 'work/chromium']);
  if (r.res.code === 1) ctx.warn('work/chromium is not git-ignored in the project repo; add work/ to .gitignore manually');
}

async function stepSync(ctx) {
  const { layout, lock } = ctx;
  if (!fs.existsSync(layout.chromiumDir)) fail(EXIT.PRECONDITION, 'run prepare first');
  await preflight(ctx, 'sync', { xcode: false });
  await requireDepotTools(ctx);
  const expected = renderGclient(lock, ctx.opts.checkoutConfiguration);
  if (!fs.existsSync(layout.gclientFile)) fail(EXIT.PRECONDITION, '.gclient missing; run prepare');
  if (fs.readFileSync(layout.gclientFile, 'utf8') !== expected) {
    fail(EXIT.PRECONDITION, '.gclient differs from the lock-derived content (check --checkout-configuration)');
  }
  const before = await inspectSource(ctx, lock, { checkDirty: true });
  const state = readState(layout);
  const ownedIncomplete = state.sync?.commit === lock.commit && state.sync?.sourceCreatedByDriver === true &&
    ['running', 'interrupted', 'failed'].includes(state.sync?.status);
  requireExistingSourceSafe(ctx, before, {allowIncomplete: ownedIncomplete});
  const sourceCreatedByDriver = !before.exists || state.sync?.sourceCreatedByDriver === true;
  const resumed = state.sync && state.sync.status !== 'completed';
  if (resumed) ctx.log(`resuming sync after previous status "${state.sync.status}"`);
  state.lockCommit = lock.commit;
  state.sync = { status: 'running', commit: lock.commit, sourceCreatedByDriver, startedAt: ctx.now(), resumed: Boolean(resumed) };
  writeState(ctx, state);
  const res = await execStep(ctx, syncArgv(layout, lock, ctx.opts), layout.chromiumDir);
  const code = exitCodeOf(res);
  if (ctx.dryRun) return EXIT.OK;
  if (code !== 0) {
    state.sync = { ...state.sync, status: res.signal ? 'interrupted' : 'failed', exitCode: code, endedAt: ctx.now() };
    writeState(ctx, state);
    ctx.error(`gclient sync exited with ${code}; source is NOT complete. Rerun "sync" to resume.`);
    return code;
  }
  const after = await inspectSource(ctx, lock);
  if (!after.headMatches || !after.versionMatches) {
    state.sync = { ...state.sync, status: 'failed', exitCode: EXIT.VERIFY_FAILED, endedAt: ctx.now(), head: after.head };
    writeState(ctx, state);
    fail(EXIT.VERIFY_FAILED, `after sync HEAD=${after.head} VERSION=${after.version}; expected ${lock.commit} / ${lock.tag}`);
  }
  if (!fs.existsSync(path.join(layout.srcDir, 'build', 'config', 'gclient_args.gni'))) {
    state.sync = { ...state.sync, status: 'failed', exitCode: EXIT.VERIFY_FAILED, endedAt: ctx.now() };
    writeState(ctx, state);
    fail(EXIT.VERIFY_FAILED, 'gclient_args.gni missing after sync; hooks incomplete');
  }
  state.sync = { ...state.sync, status: 'completed', exitCode: 0, endedAt: ctx.now(), head: after.head };
  writeState(ctx, state);
  ctx.log(`source synced at ${lock.commit} (${lock.tag}). This is source only; nothing is built.`);
  return EXIT.OK;
}

async function stepGen(ctx) {
  const { layout, lock } = ctx;
  const arch = ctx.opts.arch;
  requireArchInLock(ctx, arch);
  if (!fs.existsSync(layout.chromiumDir)) fail(EXIT.PRECONDITION, 'run prepare first');
  await preflight(ctx, 'gen', { xcode: true });
  await requireDepotTools(ctx);
  const src = await inspectSource(ctx, lock);
  requireSourceAtLock(ctx, src);
  const state = readState(layout);
  requireSyncComplete(ctx, state);
  const argsGn = renderArgsGn(arch);
  const outAbs = path.join(layout.srcDir, outDirRel(arch));
  ctx.log(`args.gn: ${writeOwnedFile(ctx, path.join(outAbs, 'args.gn'), argsGn, 'args.gn')}`);
  const res = await execStep(ctx, gnGenArgv(layout, arch), layout.srcDir);
  const code = exitCodeOf(res);
  if (ctx.dryRun) return EXIT.OK;
  state.gen ??= {};
  if (code !== 0) {
    state.gen[arch] = { status: 'failed', exitCode: code, at: ctx.now() };
    writeState(ctx, state);
    ctx.error(`gn gen exited with ${code}`);
    return code;
  }
  if (!fs.existsSync(path.join(outAbs, 'build.ninja'))) {
    state.gen[arch] = { status: 'failed', exitCode: EXIT.VERIFY_FAILED, at: ctx.now() };
    writeState(ctx, state);
    fail(EXIT.VERIFY_FAILED, `gn gen returned 0 but ${outAbs}/build.ninja is missing`);
  }
  state.gen[arch] = { status: 'completed', exitCode: 0, at: ctx.now(), commit: lock.commit, argsHash: sha256(argsGn) };
  writeState(ctx, state);
  ctx.log(`generated ${outDirRel(arch)}. Not built yet.`);
  return EXIT.OK;
}

async function stepBuild(ctx) {
  const { layout, lock } = ctx;
  const { arch, jobs } = ctx.opts;
  requireArchInLock(ctx, arch);
  if (!fs.existsSync(layout.chromiumDir)) fail(EXIT.PRECONDITION, 'run prepare first');
  const { host } = await preflight(ctx, 'build', { xcode: true });
  if (jobs > host.ncpu) fail(EXIT.USAGE, `--jobs ${jobs} exceeds hw.ncpu ${host.ncpu}`);
  await requireDepotTools(ctx);
  const src = await inspectSource(ctx, lock);
  requireSourceAtLock(ctx, src);
  const state = readState(layout);
  requireSyncComplete(ctx, state);
  const outAbs = path.join(layout.srcDir, outDirRel(arch));
  const argsGn = renderArgsGn(arch);
  let current = null;
  try {
    current = fs.readFileSync(path.join(outAbs, 'args.gn'), 'utf8');
  } catch { /* handled below */ }
  if (current !== argsGn) fail(EXIT.PRECONDITION, `${outDirRel(arch)}/args.gn missing or not driver-generated; run gen --arch ${arch}`);
  if (!fs.existsSync(path.join(outAbs, 'build.ninja'))) fail(EXIT.PRECONDITION, `${outDirRel(arch)} not generated; run gen`);
  state.build ??= {};
  state.build[arch] = { status: 'running', jobs, commit: lock.commit, argsHash: sha256(argsGn), startedAt: ctx.now() };
  writeState(ctx, state);
  const res = await execStep(ctx, buildArgv(layout, arch, jobs, ctx.opts), layout.srcDir);
  const code = exitCodeOf(res);
  if (ctx.dryRun) return EXIT.OK;
  if (code !== 0) {
    state.build[arch] = { ...state.build[arch], status: res.signal ? 'interrupted' : 'failed', exitCode: code, endedAt: ctx.now() };
    writeState(ctx, state);
    ctx.error(`autoninja exited with ${code}; build is NOT complete`);
    return code;
  }
  const bin = await verifyBinary(ctx, arch);
  if (!bin.ok) {
    state.build[arch] = { ...state.build[arch], status: 'unverified', exitCode: EXIT.VERIFY_FAILED, endedAt: ctx.now() };
    writeState(ctx, state);
    fail(EXIT.VERIFY_FAILED, `autoninja returned 0 but ${bin.reason}`);
  }
  state.build[arch] = { ...state.build[arch], status: 'completed', exitCode: 0, endedAt: ctx.now(), binary: bin.binary };
  writeState(ctx, state);
  ctx.log(`built ${bin.binary} (${LIPO_ARCH[arch]}). Development build only; not signed, not store/release verified.`);
  return EXIT.OK;
}

export const binaryPath = (layout, arch) =>
  path.join(layout.srcDir, outDirRel(arch), 'Chromium.app', 'Contents', 'MacOS', 'Chromium');

async function verifyBinary(ctx, arch) {
  const binary = binaryPath(ctx.layout, arch);
  if (!fs.existsSync(binary)) return { ok: false, binary, reason: `${binary} does not exist` };
  const lipo = await probe(ctx, ['/usr/bin/lipo', '-archs', binary]);
  if (!lipo.ok) return { ok: false, binary, reason: `lipo -archs failed for ${binary}` };
  if (lipo.out.split(/\s+/).join(' ') !== LIPO_ARCH[arch]) {
    return { ok: false, binary, reason: `${binary} archs "${lipo.out}" != ${LIPO_ARCH[arch]}` };
  }
  return { ok: true, binary };
}

// status never downloads, never writes. "built" requires binary evidence.
export async function collectStatus(ctx) {
  const { layout, lock } = ctx;
  const state = readState(layout);
  const out = {
    lock: { tag: lock.tag, commit: lock.commit, build_verified: lock.build_verified ?? false },
    paths: { chromiumDir: layout.chromiumDir, depotToolsDir: layout.depotToolsDir },
    depotToolsMissing: depotToolsMissing(layout),
    gclient: fs.existsSync(layout.gclientFile) ? 'present' : 'missing',
    source: 'absent',
    sync: state.sync ?? null,
    arches: {},
  };
  const src = await inspectSource(ctx, lock);
  out.head = src.head;
  out.version = src.version;
  if (src.exists && !src.isGit) out.source = 'not_a_git_checkout';
  else if (src.exists && src.head !== null && !src.headMatches) out.source = 'head_mismatch';
  else if (src.exists && state.sync?.status === 'completed' && state.sync.commit === lock.commit && src.versionMatches) {
    out.source = 'source_ready';
  } else if (src.exists || state.sync) out.source = 'source_incomplete';
  for (const arch of lock.architectures) {
    const outAbs = path.join(layout.srcDir, outDirRel(arch));
    let argsOk = false;
    try {
      argsOk = fs.readFileSync(path.join(outAbs, 'args.gn'), 'utf8') === renderArgsGn(arch);
    } catch { /* absent */ }
    const generated = argsOk && fs.existsSync(path.join(outAbs, 'build.ninja'));
    const b = state.build?.[arch];
    let s = out.source === 'source_ready' ? (generated ? 'generated' : 'source_ready') : out.source;
    if (out.source === 'source_ready' && generated && b) {
      if (b.status === 'completed' && b.exitCode === 0 && b.commit === lock.commit && b.argsHash === sha256(renderArgsGn(arch))) {
        s = (await verifyBinary(ctx, arch)).ok ? 'built' : 'build_unverified';
      } else {
        s = b.status === 'running' ? 'build_incomplete' : `build_${b.status}`;
      }
    }
    out.arches[arch] = { state: s, outDir: outDirRel(arch), lastBuild: b ?? null };
  }
  return out;
}

async function stepStatus(ctx) {
  const st = await collectStatus(ctx);
  if (ctx.opts.json) {
    ctx.log(JSON.stringify(st, null, 2));
  } else {
    ctx.log(`lock ${st.lock.tag} ${st.lock.commit} (lock build_verified=${st.lock.build_verified})`);
    ctx.log(`depot_tools: ${st.depotToolsMissing.length ? `missing ${st.depotToolsMissing.join(', ')}` : 'present'}`);
    ctx.log(`.gclient: ${st.gclient}; source: ${st.source}; HEAD ${st.head ?? '-'}; VERSION ${st.version ?? '-'}`);
    ctx.log(`sync: ${st.sync ? `${st.sync.status} (exit ${st.sync.exitCode ?? '-'})` : 'never run'}`);
    for (const [arch, a] of Object.entries(st.arches)) ctx.log(`${arch}: ${a.state} (${a.outDir})`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------- main

const STEP_FNS = { prepare: stepPrepare, sync: stepSync, gen: stepGen, build: stepBuild, status: stepStatus };

export async function main(argv, deps = {}) {
  const log = deps.log ?? ((l) => process.stdout.write(l + '\n'));
  const error = deps.error ?? ((l) => process.stderr.write(l + '\n'));
  let ctx = null;
  try {
    const opts = parseCli(argv);
    if (opts.help) {
      log(USAGE);
      return EXIT.OK;
    }
    const here = path.dirname(fileURLToPath(import.meta.url));
    const layout = resolveLayout(opts.projectRoot ?? path.dirname(here), opts.workRoot);
    ctx = {
      opts,
      layout,
      lock: loadLock(layout.lockPath),
      run: deps.run ?? defaultRunner,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      ncpu: deps.ncpu ?? os.availableParallelism(),
      home: deps.home ?? process.env.HOME,
      now: deps.now ?? (() => new Date().toISOString()),
      dryRun: Boolean(opts.dryRun),
      log,
      error,
      warn: (l) => error(`warning: ${l}`),
    };
    ctx.env = childEnv(layout, opts, deps.env ?? process.env);
    ctx.release = null;
    ctx.holdLock = () => {
      if (!ctx.release && fs.existsSync(layout.chromiumDir)) ctx.release = acquireLock(ctx);
    };
    if (opts.step !== 'status') ctx.holdLock();
    return await STEP_FNS[opts.step](ctx);
  } catch (e) {
    if (e instanceof DriverError) {
      error(`error: ${e.message}`);
      if (e.code === EXIT.USAGE) error(USAGE);
      return e.code;
    }
    error(`error: ${e.stack ?? e}`);
    return EXIT.FAILURE;
  } finally {
    ctx?.release?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
