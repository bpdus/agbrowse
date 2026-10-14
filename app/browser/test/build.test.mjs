// Tests for browser/build.mjs. No network, no real gclient/gn/autoninja: every
// external command goes through a fake runner that records argv arrays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT, FORBIDDEN_TOKENS, main, parseCli, renderArgsGn, renderGclient, loadLock, outDirRel,
} from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realLock = JSON.parse(fs.readFileSync(path.join(here, '..', 'chromium.lock.json'), 'utf8'));
const COMMIT = realLock.commit;
const [MAJOR, MINOR, BUILD, PATCH] = realLock.tag.split('.');

function makeProject({ depotTools = true, dirName = 'proj' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bdrv-')));
  const root = path.join(base, dirName);
  fs.mkdirSync(path.join(root, 'browser'), { recursive: true });
  fs.writeFileSync(path.join(root, 'browser', 'chromium.lock.json'), JSON.stringify(realLock));
  if (depotTools) {
    const dt = path.join(root, 'work', 'depot_tools');
    fs.mkdirSync(dt, { recursive: true });
    for (const t of ['gclient', 'gn', 'autoninja']) fs.writeFileSync(path.join(dt, t), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dt, 'stub-python', 'bin'), {recursive:true});
    fs.writeFileSync(path.join(dt, 'stub-python', 'bin', 'python3'), '', {mode:0o755});
    fs.writeFileSync(path.join(dt, 'python3_bin_reldir.txt'), 'stub-python/bin');
  }
  return root;
}

// Simulated host + tools. Mutating commands produce the files real tools would.
function fakeHost(root, over = {}) {
  const h = {
    nodeArch: 'arm64', arm64: '1', translated: '0', availKiB: String(328 * 1024 * 1024), fsType: 'apfs',
    xcodeSelect: '/Applications/Xcode.app/Contents/Developer', xcodebuild: 'Xcode 27.0\nBuild version 27A266a',
    firstLaunch: 0, sdk: '27.0', metalInstalled: true, head: COMMIT, origin: realLock.repository, dirty: '', dirtyError: false, missing: [], depotHead: realLock.depot_tools_commit,
    syncResult: { code: 0 }, syncHead: COMMIT, gnCode: 0, buildResult: { code: 0 }, lipo: 'arm64', makeBinary: true,
    ...over,
  };
  const calls = [];
  const src = path.join(root, 'work', 'chromium', 'src');
  const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', error: null });
  const bad = (code = 1) => ({ code, signal: null, stdout: '', stderr: 'fail', error: null });
  const run = async (argv0, opts) => {
    calls.push({ argv: argv0, cwd: opts?.cwd, env: opts?.env });
    const argv = argv0[0] === '/usr/bin/caffeinate' ? argv0.slice(2) : argv0;
    const cmd = path.basename(argv[0]);
    const joined = argv.join(' ');
    if (h.missing.includes(cmd)) return { code: null, signal: null, stdout: '', stderr: '', error: 'ENOENT' };
    if (cmd === 'sysctl') {
      const key = argv[2];
      if (key === 'hw.optional.arm64') return h.arm64 === null ? bad() : ok(h.arm64);
      if (key === 'sysctl.proc_translated') return h.translated === null ? bad() : ok(h.translated);
    }
    if (cmd === 'df') {
      return ok(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 999 1 ${h.availKiB} 1% /System/Volumes/Data\n`);
    }
    if (cmd === 'mount') return ok(`/dev/disk3s5 on /System/Volumes/Data (${h.fsType}, local, journaled)\n`);
    if (cmd === 'git' && argv[1] === '--version') return ok('git version 2.50.1');
    if (cmd === 'python3') return ok('Python 3.13.0');
    if (cmd === 'xcode-select') return h.xcodeSelect === null ? bad(2) : ok(h.xcodeSelect);
    if (cmd === 'xcodebuild' && argv[1] === '-version') return h.xcodebuild === null ? bad(69) : ok(h.xcodebuild);
    if (cmd === 'xcodebuild' && argv[1] === '-checkFirstLaunchStatus') return h.firstLaunch === 0 ? ok() : bad(h.firstLaunch);
    if (cmd === 'xcrun') return argv.includes('metal') ? (h.metalInstalled ? ok('Metal compiler') : bad(69)) : ok(h.sdk);
    if (cmd === 'git' && joined.includes('rev-parse HEAD')) {
      if (argv[2].endsWith('/depot_tools')) return ok(h.depotHead);
      return h.head ? ok(h.head) : bad(128);
    }
    if (cmd === 'git' && joined.includes('remote.origin.url')) return ok(argv[2].endsWith('/depot_tools') ? realLock.depot_tools_repository : h.origin);
    if (cmd === 'git' && joined.includes('status --porcelain')) return h.dirtyError ? bad() : ok(h.dirty);
    if (cmd === 'git' && argv[1] === 'clone') {
      const dt = argv[3];
      fs.mkdirSync(dt, { recursive: true });
      for (const t of ['gclient', 'gn', 'autoninja']) fs.writeFileSync(path.join(dt, t), '', { mode: 0o755 });
      return ok();
    }
    if (cmd === 'git' && argv[3] === 'check-ignore') return ok();
    if (cmd === 'gclient') {
      if (h.syncResult.code === 0 && !h.syncResult.signal) writeSource(src, MAJOR);
      h.head = h.syncHead;
      return { stdout: '', stderr: '', error: null, signal: null, ...h.syncResult };
    }
    if (cmd === 'gn') {
      if (h.gnCode === 0) fs.writeFileSync(path.join(opts.cwd, argv[2], 'build.ninja'), '');
      return h.gnCode === 0 ? ok() : bad(h.gnCode);
    }
    if (cmd === 'autoninja') {
      if (h.buildResult.code === 0 && h.makeBinary) {
        const bin = path.join(opts.cwd, argv[2], 'Chromium.app', 'Contents', 'MacOS');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'Chromium'), '');
      }
      return { stdout: '', stderr: '', error: null, signal: null, ...h.buildResult };
    }
    if (cmd === 'lipo') return ok(h.lipo);
    throw new Error(`unexpected command in test: ${JSON.stringify(argv)}`);
  };
  return { h, calls, run, src };
}

function writeSource(src, major = MAJOR) {
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.mkdirSync(path.join(src, 'chrome'), { recursive: true });
  fs.writeFileSync(path.join(src, 'chrome', 'VERSION'), `MAJOR=${major}\nMINOR=${MINOR}\nBUILD=${BUILD}\nPATCH=${PATCH}\n`);
  fs.mkdirSync(path.join(src, 'build', 'config'), { recursive: true });
  fs.writeFileSync(path.join(src, 'build', 'config', 'gclient_args.gni'), '');
}

async function drive(root, fake, args) {
  const out = [];
  const err = [];
  const code = await main([...args, '--project-root', root], {
    run: fake.run, platform: 'darwin', arch: fake.h.nodeArch, ncpu: 10, home: '/Users/tester', env: { PATH: '/usr/bin:/bin' },
    log: (l) => out.push(l), error: (l) => err.push(l), now: () => '2026-10-14T00:00:00Z',
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const ran = (fake, name) => fake.calls.filter((c) => c.argv.some((a) => path.basename(a) === name));

function assertNoDangerousArgv(fake) {
  for (const { argv } of fake.calls) {
    for (const t of argv.slice(1)) assert.ok(!FORBIDDEN_TOKENS.includes(t), `forbidden token ${t} in ${JSON.stringify(argv)}`);
    assert.ok(!(path.basename(argv[0]) === 'git' && ['reset', 'clean', 'checkout', 'stash'].includes(argv[3] ?? argv[1])),
      `destructive git argv ${JSON.stringify(argv)}`);
    assert.notEqual(path.basename(argv[0]), 'rm');
    assert.ok(!(path.basename(argv[0]) === 'xcode-select' && argv[1] !== '-p'), 'xcode-select may only be queried');
    assert.ok(argv.every((a) => typeof a === 'string'), 'argv must be strings');
  }
}

async function fullPipeline(root, fake, arch = 'arm64') {
  assert.equal((await drive(root, fake, ['prepare'])).code, EXIT.OK);
  assert.equal((await drive(root, fake, ['sync'])).code, EXIT.OK);
  assert.equal((await drive(root, fake, ['gen', '--arch', arch])).code, EXIT.OK);
}

// ------------------------------------------------------------- CLI

test('invalid arch is a usage error and runs nothing', async () => {
  const root = makeProject();
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['gen', '--arch', 'x86_64']);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /--arch must be arm64 or x64/);
  assert.equal(fake.calls.length, 0);
});

test('build without --jobs, with bad --jobs, and unknown step are usage errors', () => {
  assert.throws(() => parseCli(['build', '--arch', 'arm64']), /explicit --jobs/);
  assert.throws(() => parseCli(['build', '--arch', 'arm64', '--jobs', '0']), /between 1/);
  assert.throws(() => parseCli(['build', '--arch', 'arm64', '--jobs', '4x']), /integer/);
  assert.throws(() => parseCli(['deploy']), /step must be one of/);
  assert.throws(() => parseCli(['gen']), /requires --arch/);
});

test('lock validation rejects a bad commit', () => {
  const root = makeProject();
  const p = path.join(root, 'browser', 'chromium.lock.json');
  fs.writeFileSync(p, JSON.stringify({ ...realLock, commit: 'abc' }));
  assert.throws(() => loadLock(p), /40-char/);
});

// ------------------------------------------------------------- paths / host

test('project path with a space is refused before any tool runs', async () => {
  const root = makeProject({ dirName: 'my proj' });
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /whitespace/);
  assert.equal(fake.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'work', 'chromium')));
});

test('non-mac host, Rosetta, non-APFS and low disk are refused', async () => {
  const root = makeProject();
  const nonMac = fakeHost(root);
  const r0 = await main(['prepare', '--project-root', root], { run: nonMac.run, platform: 'linux', log: () => {}, error: () => {} });
  assert.equal(r0, EXIT.PRECONDITION);
  for (const [over, re] of [
    [{ translated: '1' }, /Rosetta/],
    [{ nodeArch: 'x64', arm64: '1' }, /Rosetta/],
    [{ fsType: 'hfs' }, /APFS required/],
    [{ availKiB: String(50 * 1024 * 1024) }, /needs >= 120 GiB/],
  ]) {
    const fake = fakeHost(root, over);
    const r = await drive(root, fake, ['prepare']);
    assert.equal(r.code, EXIT.PRECONDITION, re.source);
    assert.match(r.err, re);
  }
});

test('x64 node that cannot rule out Rosetta is refused', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { nodeArch: 'x64', arm64: null, translated: null });
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.TOOL_MISSING);
  assert.match(r.err, /cannot rule out Rosetta/);
});

test('missing git or python3 is a tool error', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { missing: ['python3'] });
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.TOOL_MISSING);
  assert.match(r.err, /python3 is not available/);
});

test('an unpinned depot_tools revision is refused before sync', async () => {
  const root = makeProject();
  const fake = fakeHost(root, {depotHead: '0'.repeat(40)});
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /depot_tools does not match/);
  assert.equal(ran(fake, 'gclient').length, 0);
});

test('missing depot_tools fails without creating an unpinned checkout', async () => {
  const root = makeProject({depotTools: false});
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.TOOL_MISSING);
  assert.match(r.err, /depot_tools missing gclient, gn, autoninja/);
  assert.equal(fake.calls.filter(c => c.argv.includes('clone')).length, 0);
  assert.throws(() => parseCli(['prepare', '--clone-depot-tools']), /unknown option/);
});

// ------------------------------------------------------------- prepare

test('prepare writes a pinned .gclient and never overwrites a different one', async () => {
  const root = makeProject();
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.OK, r.err);
  const gclientPath = path.join(root, 'work', 'chromium', '.gclient');
  const text = fs.readFileSync(gclientPath, 'utf8');
  assert.equal(text, renderGclient(realLock, 'small'));
  assert.match(text, new RegExp(`src.git@${COMMIT}`));
  assert.match(text, /"managed": False/);
  assert.match(text, /"checkout_configuration": "small"/);
  assert.match(r.out, /This step did not download or build/);
  assert.equal(ran(fake, 'gclient').length, 0, 'prepare must not download');

  // idempotent
  assert.equal((await drive(root, fakeHost(root), ['prepare'])).code, EXIT.OK);
  // different config -> refuse, file untouched
  const r3 = await drive(root, fakeHost(root), ['prepare', '--checkout-configuration', 'default']);
  assert.equal(r3.code, EXIT.PRECONDITION);
  assert.match(r3.err, /exists with different content/);
  assert.equal(fs.readFileSync(gclientPath, 'utf8'), text);
});

test('prepare with an existing dirty or foreign src refuses and deletes nothing', async () => {
  const root = makeProject();
  const src = path.join(root, 'work', 'chromium', 'src');
  writeSource(src);
  fs.writeFileSync(path.join(src, 'local.patch'), 'keep me');
  const dirty = fakeHost(root, { dirty: ' M chrome/app/chrome_main.cc' });
  const r = await drive(root, dirty, ['prepare']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /local modifications/);
  assert.ok(fs.existsSync(path.join(src, 'local.patch')));
  assertNoDangerousArgv(dirty);

  const foreign = fakeHost(root, { origin: 'https://example.com/fork.git' });
  assert.equal((await drive(root, foreign, ['prepare'])).code, EXIT.PRECONDITION);

  const root2 = makeProject();
  fs.mkdirSync(path.join(root2, 'work', 'chromium', 'src'), { recursive: true });
  const r2 = await drive(root2, fakeHost(root2), ['prepare']);
  assert.equal(r2.code, EXIT.PRECONDITION);
  assert.match(r2.err, /not a git checkout/);
});

test('prepare and sync refuse an existing checkout at another commit', async () => {
  const root = makeProject();
  writeSource(path.join(root, 'work', 'chromium', 'src'));
  const fake = fakeHost(root, { head: 'f'.repeat(40) });
  const r = await drive(root, fake, ['prepare']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /refusing to move/);
  const sync = await drive(root, fake, ['sync']);
  assert.equal(sync.code, EXIT.PRECONDITION);
  assert.equal(ran(fake, 'gclient').length, 0);
});

// ------------------------------------------------------------- sync

test('sync runs gclient with --no-history and the locked commit as an argv array', async () => {
  const root = makeProject({ dirName: 'p' });
  const fake = fakeHost(root, { head: null });
  await drive(root, fake, ['prepare']);
  const r = await drive(root, fake, ['sync', '--caffeinate']);
  assert.equal(r.code, EXIT.OK, r.err);
  const sync = fake.calls.find((c) => c.argv.includes('sync'));
  assert.deepEqual(sync.argv, ['/usr/bin/caffeinate', '-i', path.join(root, 'work', 'depot_tools', 'gclient'),
    'sync', '--no-history', '--revision', `src@${COMMIT}`, '--jobs', '8']);
  assert.equal(sync.cwd, path.join(root, 'work', 'chromium'));
  assert.ok(sync.env.PATH.endsWith(`:${path.join(root, 'work', 'depot_tools')}`));
  assert.match(r.out, /source only; nothing is built/);
  assertNoDangerousArgv(fake);

  const st = await drive(root, fakeHost(root), ['status', '--json']);
  const json = JSON.parse(st.out);
  assert.equal(json.source, 'source_ready');
  assert.equal(json.arches.arm64.state, 'source_ready');
  assert.notEqual(json.arches.x64.state, 'built');
});

test('sync --revision-source tag uses the tag ref but still verifies the commit', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null, syncHead: 'e'.repeat(40) });
  await drive(root, fake, ['prepare']);
  const r = await drive(root, fake, ['sync', '--revision-source', 'tag']);
  assert.ok(fake.calls.some((c) => c.argv.includes(`src@refs/tags/${realLock.tag}`)));
  assert.equal(r.code, EXIT.VERIFY_FAILED);
  assert.match(r.err, /after sync HEAD=e+/);
  const st = JSON.parse((await drive(root, fakeHost(root, { head: 'e'.repeat(40) }), ['status', '--json'])).out);
  assert.equal(st.source, 'head_mismatch');
});

test('interrupted or failed sync propagates the exit code and resumes on rerun', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null, syncResult: { code: null, signal: 'SIGINT' } });
  await drive(root, fake, ['prepare']);
  const r = await drive(root, fake, ['sync']);
  assert.equal(r.code, 130);
  assert.match(r.err, /NOT complete/);
  let st = JSON.parse((await drive(root, fakeHost(root, { head: null }), ['status', '--json'])).out);
  assert.equal(st.sync.status, 'interrupted');
  assert.equal(st.arches.arm64.state, 'source_incomplete');

  const failing = fakeHost(root, { head: null, syncResult: { code: 2 } });
  assert.equal((await drive(root, failing, ['sync'])).code, 2);

  const resume = fakeHost(root, { head: null });
  const r2 = await drive(root, resume, ['sync']);
  assert.equal(r2.code, EXIT.OK);
  assert.match(r2.out, /resuming sync after previous status "failed"/);
  st = JSON.parse((await drive(root, fakeHost(root), ['status', '--json'])).out);
  assert.equal(st.sync.status, 'completed');
});

test('sync refuses a dirty checkout and a modified .gclient', async () => {
  const root = makeProject();
  await drive(root, fakeHost(root), ['prepare']);
  writeSource(path.join(root, 'work', 'chromium', 'src'));
  const dirty = fakeHost(root, { dirty: ' M BUILD.gn' });
  assert.equal((await drive(root, dirty, ['sync'])).code, EXIT.PRECONDITION);
  assert.equal(ran(dirty, 'gclient').length, 0);

  fs.appendFileSync(path.join(root, 'work', 'chromium', '.gclient'), '# edited\n');
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['sync']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /\.gclient differs/);
  assert.equal(ran(fake, 'gclient').length, 0);
});

test('sync without prepare is refused', async () => {
  const root = makeProject();
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['sync']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.equal(ran(fake, 'gclient').length, 0);
});

// ------------------------------------------------------------- gen

test('gen writes the required args.gn and runs gn gen', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null });
  await fullPipeline(root, fake, 'x64');
  const args = fs.readFileSync(path.join(root, 'work', 'chromium', 'src', 'out', 'Release-x64', 'args.gn'), 'utf8');
  assert.equal(args, renderArgsGn('x64'));
  for (const line of ['target_cpu = "x64"', 'is_debug = false', 'is_component_build = true', 'symbol_level = 0',
    'use_system_xcode = true', 'is_official_build = false', 'is_chrome_branded = false']) {
    assert.ok(args.includes(line), line);
  }
  const gn = fake.calls.find((c) => path.basename(c.argv[0]) === 'gn');
  assert.deepEqual(gn.argv, [path.join(root, 'work', 'depot_tools', 'gn'), 'gen', 'out/Release-x64']);
  assert.equal(gn.cwd, path.join(root, 'work', 'chromium', 'src'));
  const st = JSON.parse((await drive(root, fakeHost(root), ['status', '--json'])).out);
  assert.equal(st.arches.x64.state, 'generated');
  assertNoDangerousArgv(fake);
});

test('gen refuses HEAD mismatch, incomplete sync, foreign args.gn', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null });
  await drive(root, fake, ['prepare']);
  await drive(root, fake, ['sync']);

  const mismatch = fakeHost(root, { head: 'a'.repeat(40) });
  const r = await drive(root, mismatch, ['gen', '--arch', 'arm64']);
  assert.equal(r.code, EXIT.VERIFY_FAILED);
  assert.match(r.err, /HEAD a+ != locked/);
  assert.equal(ran(mismatch, 'gn').length, 0);

  const outDir = path.join(root, 'work', 'chromium', 'src', 'out', 'Release-arm64');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'args.gn'), 'is_debug = true\n');
  const foreign = fakeHost(root);
  const r2 = await drive(root, foreign, ['gen', '--arch', 'arm64']);
  assert.equal(r2.code, EXIT.PRECONDITION);
  assert.equal(fs.readFileSync(path.join(outDir, 'args.gn'), 'utf8'), 'is_debug = true\n');

  const root2 = makeProject();
  const f2 = fakeHost(root2, { head: null, syncResult: { code: 1 } });
  await drive(root2, f2, ['prepare']);
  await drive(root2, f2, ['sync']);
  writeSource(path.join(root2, 'work', 'chromium', 'src'));
  const r3 = await drive(root2, fakeHost(root2), ['gen', '--arch', 'arm64']);
  assert.equal(r3.code, EXIT.PRECONDITION);
  assert.match(r3.err, /sync is not complete/);
});

test('gen requires full Xcode, completed first launch, Intel-compatible Xcode, and SDK >= official', async () => {
  const root = makeProject();
  await fullPipeline(root, fakeHost(root, { head: null }));
  const cases = [
    [{ xcodeSelect: '/Library/Developer/CommandLineTools' }, EXIT.TOOL_MISSING, /CLT only/],
    [{ xcodeSelect: null }, EXIT.TOOL_MISSING, /xcode-select -p failed/],
    [{ xcodebuild: null }, EXIT.TOOL_MISSING, /xcodebuild -version failed/],
    [{ firstLaunch: 1 }, EXIT.PRECONDITION, /first launch/],
    [{ nodeArch: 'x64', arm64: null }, EXIT.PRECONDITION, /ARM-only/],
    [{ sdk: '26.2' }, EXIT.PRECONDITION, /< official 26.5/],
  ];
  for (const [over, code, re] of cases) {
    const fake = fakeHost(root, over);
    const r = await drive(root, fake, ['gen', '--arch', 'x64']);
    assert.equal(r.code, code, re.source);
    assert.match(r.err, re);
    assert.equal(ran(fake, 'gn').length, 0);
  }
  const intel26 = fakeHost(root, { nodeArch: 'x64', arm64: null, xcodebuild: 'Xcode 26.6\nBuild version 17X1', sdk: '26.5' });
  assert.equal((await drive(root, intel26, ['gen', '--arch', 'x64'])).code, EXIT.OK);
  const oldSdk = fakeHost(root, { sdk: '26.2' });
  assert.equal((await drive(root, oldSdk, ['gen', '--arch', 'arm64', '--allow-sdk-below-official'])).code, EXIT.OK);
});

// ------------------------------------------------------------- build

test('build runs autoninja chrome with explicit bounded jobs and verifies the binary', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null });
  await fullPipeline(root, fake);
  const r = await drive(root, fake, ['build', '--arch', 'arm64', '--jobs', '6']);
  assert.equal(r.code, EXIT.OK, r.err);
  const b = fake.calls.find((c) => path.basename(c.argv[0]) === 'autoninja');
  assert.deepEqual(b.argv, [path.join(root, 'work', 'depot_tools', 'autoninja'), '-C', outDirRel('arm64'), '-j', '6', 'chrome']);
  assert.ok(fake.calls.some((c) => c.argv[0] === '/usr/bin/lipo'));
  const st = JSON.parse((await drive(root, fakeHost(root), ['status', '--json'])).out);
  assert.equal(st.arches.arm64.state, 'built');
  assert.equal(st.lock.build_verified, false, 'driver never edits the lock');
  assertNoDangerousArgv(fake);
});

test('build rejects jobs above hw.ncpu and missing gen', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null });
  await drive(root, fake, ['prepare']);
  await drive(root, fake, ['sync']);
  const r0 = await drive(root, fakeHost(root), ['build', '--arch', 'arm64', '--jobs', '4']);
  assert.equal(r0.code, EXIT.PRECONDITION);
  assert.match(r0.err, /run gen/);
  await drive(root, fakeHost(root), ['gen', '--arch', 'arm64']);
  const big = fakeHost(root);
  const r = await drive(root, big, ['build', '--arch', 'arm64', '--jobs', '64']);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /exceeds hw.ncpu 10/);
  assert.equal(ran(big, 'autoninja').length, 0);
});

test('failed build propagates the exit code and is never reported as built', async () => {
  const root = makeProject();
  await fullPipeline(root, fakeHost(root, { head: null }));
  const fake = fakeHost(root, { buildResult: { code: 7 } });
  const r = await drive(root, fake, ['build', '--arch', 'arm64', '--jobs', '4']);
  assert.equal(r.code, 7);
  assert.match(r.err, /NOT complete/);
  const st = JSON.parse((await drive(root, fakeHost(root), ['status', '--json'])).out);
  assert.equal(st.arches.arm64.state, 'build_failed');
});

test('autoninja exit 0 without a binary of the right arch is not "built"', async () => {
  const root = makeProject();
  await fullPipeline(root, fakeHost(root, { head: null }));
  const noBin = fakeHost(root, { makeBinary: false });
  const r = await drive(root, noBin, ['build', '--arch', 'arm64', '--jobs', '2']);
  assert.equal(r.code, EXIT.VERIFY_FAILED);
  let st = JSON.parse((await drive(root, fakeHost(root), ['status', '--json'])).out);
  assert.equal(st.arches.arm64.state, 'build_unverified');

  const wrongArch = fakeHost(root, { lipo: 'x86_64' });
  assert.equal((await drive(root, wrongArch, ['build', '--arch', 'arm64', '--jobs', '2'])).code, EXIT.VERIFY_FAILED);
  st = JSON.parse((await drive(root, fakeHost(root, { lipo: 'x86_64' }), ['status', '--json'])).out);
  assert.notEqual(st.arches.arm64.state, 'built');
});

test('status after a later HEAD change no longer reports built', async () => {
  const root = makeProject();
  const fake = fakeHost(root, { head: null });
  await fullPipeline(root, fake);
  await drive(root, fake, ['build', '--arch', 'arm64', '--jobs', '2']);
  const st = JSON.parse((await drive(root, fakeHost(root, { head: 'b'.repeat(40) }), ['status', '--json'])).out);
  assert.equal(st.arches.arm64.state, 'head_mismatch');
});

// ------------------------------------------------------------- dry run / safety

test('dry-run executes no mutating command and writes nothing', async () => {
  const root = makeProject();
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['prepare', '--dry-run']);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.match(r.out, /\[dry-run\] would write .*\.gclient/);
  assert.ok(!fs.existsSync(path.join(root, 'work', 'chromium')));
  assert.equal(ran(fake, 'gclient').length, 0);
});

test('a concurrent driver lock blocks a second run', async () => {
  const root = makeProject();
  await drive(root, fakeHost(root), ['prepare']);
  fs.writeFileSync(path.join(root, 'work', 'chromium', '.build-driver.lock'), String(process.pid));
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['sync']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /lock already exists/);
  assert.ok(fs.existsSync(path.join(root, 'work', 'chromium', '.build-driver.lock')), 'foreign lock kept');
});

test('dead or malformed driver locks are preserved for owner inspection', async () => {
  const root = makeProject();
  await drive(root, fakeHost(root), ['prepare']);
  const lockPath = path.join(root, 'work', 'chromium', '.build-driver.lock');
  for (const content of ['999999999', '{malformed']) {
    fs.writeFileSync(lockPath, content);
    const fake = fakeHost(root);
    assert.equal((await drive(root, fake, ['sync'])).code, EXIT.PRECONDITION);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), content);
    assert.equal(ran(fake, 'gclient').length, 0);
  }
});

test('native Intel hosts do not require Apple Silicon translation keys', async () => {
  const root = makeProject();
  const fake = fakeHost(root, {nodeArch: 'x64', arm64: '0', translated: null});
  assert.equal((await drive(root, fake, ['prepare'])).code, EXIT.OK);
});

test('a separate work root keeps checkout caches out of product files', async () => {
  const root = makeProject();
  const cache = path.join(root, 'cache-root');
  const depot = path.join(cache, 'depot_tools');
  fs.mkdirSync(depot, {recursive: true});
  for (const tool of ['gclient', 'gn', 'autoninja']) fs.writeFileSync(path.join(depot, tool), '', {mode: 0o755});
  const fake = fakeHost(root);
  const r = await drive(root, fake, ['prepare', '--work-root', cache]);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.ok(fs.existsSync(path.join(cache, 'chromium', '.gclient')));
  assert.ok(!fs.existsSync(path.join(root, 'work', 'chromium')));
  assert.ok(fake.calls.every(c => c.env.DEPOT_TOOLS_UPDATE === '0' && c.env.DEPOT_TOOLS_METRICS === '0'));
});

test('the driver source never spawns through a shell or calls destructive commands', () => {
  const srcText = fs.readFileSync(path.join(here, '..', 'build.mjs'), 'utf8');
  assert.ok(!/shell:\s*true/.test(srcText));
  assert.ok(/import \{ spawn \} from 'node:child_process';/.test(srcText));
  assert.ok(!/execSync|execFile|spawnSync/.test(srcText));
  assert.ok(!/rmSync|rmdirSync|fs\.rm\(/.test(srcText));
  assert.ok(!/'reset'\s*\]|'clean'\s*\]|\.zshrc|\.bash_profile/.test(srcText.replace(/FORBIDDEN_TOKENS[\s\S]*?\]\);/, '')));
});

test('a failed dirty-state probe refuses sync before any mutation', async () => {
  const root = makeProject();
  await drive(root, fakeHost(root), ['prepare']);
  writeSource(path.join(root, 'work', 'chromium', 'src'));
  const fake = fakeHost(root, {dirtyError: true});
  const r = await drive(root, fake, ['sync']);
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(r.err, /cannot determine src dirty state/);
  assert.equal(ran(fake, 'gclient').length, 0);
});

test('gen refuses a missing Metal compiler before generating build files', async () => {
  const root=makeProject();
  const fake=fakeHost(root,{metalInstalled:false});
  await drive(root,fake,['prepare']);
  const r=await drive(root,fake,['gen','--arch','arm64']);
  assert.equal(r.code,EXIT.TOOL_MISSING);
  assert.match(r.err,/Metal compiler is unavailable/);
  assert.equal(ran(fake,'gn').length,0);
});

test('gen refuses an unbootstrapped depot_tools Python runtime', async () => {
  const root=makeProject();
  fs.writeFileSync(path.join(root,'work','depot_tools','python3_bin_reldir.txt'),'');
  const fake=fakeHost(root);
  await drive(root,fake,['prepare']);
  const r=await drive(root,fake,['gen','--arch','arm64']);
  assert.equal(r.code,EXIT.TOOL_MISSING);
  assert.match(r.err,/Python bootstrap is missing/);
  assert.equal(ran(fake,'gn').length,0);
});

test('only a recorded driver-owned incomplete source can resume without HEAD', async () => {
  const root = makeProject();
  await drive(root, fakeHost(root), ['prepare']);
  const cache = path.join(root, 'work', 'chromium');
  writeSource(path.join(cache, 'src'));
  const before = fakeHost(root, {head: null});
  assert.equal((await drive(root, before, ['sync'])).code, EXIT.PRECONDITION);
  fs.writeFileSync(path.join(cache, '.build-driver-state.json'), JSON.stringify({sync:{status:'interrupted', commit:COMMIT, sourceCreatedByDriver:true}}));
  const owned = fakeHost(root, {head:null});
  assert.equal((await drive(root, owned, ['sync'])).code, EXIT.OK);
  assert.equal(ran(owned, 'gclient').length, 1);
});
