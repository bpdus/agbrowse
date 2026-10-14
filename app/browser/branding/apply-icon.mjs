#!/usr/bin/env node
// Package icon-source.png (next to this script) into app.icns + Assets.car and
// optionally install both into a Chromium checkout and/or a built .app bundle.
//
// Usage: node apply-icon.mjs --output DIR [--chromium-src DIR] [--app APP_PATH]
//
// Native macOS tools only (sips, iconutil, plutil, xcrun actool/assetutil).
// The source PNG is never modified; target files are backed up before writing.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants, copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node apply-icon.mjs --output DIR [--chromium-src DIR] [--app APP_PATH]';
const FLAGS = { '--output': 'output', '--chromium-src': 'chromiumSrc', '--app': 'app' };
const TARGET_FILES = ['app.icns', 'Assets.car'];
const CHROMIUM_BRANDING_DIR = 'chrome/app/theme/chromium/mac';
const ICON_NAME = 'AppIcon';
const ICONSET = [16, 32, 128, 256, 512].flatMap((pt) => [
  { pt, scale: 1, px: pt, name: `icon_${pt}x${pt}.png` },
  { pt, scale: 2, px: pt * 2, name: `icon_${pt}x${pt}@2x.png` },
]);

function fail(msg) {
  throw new Error(msg);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    const key = FLAGS[arg];
    if (!key) fail(`Unknown argument: ${arg}\n${USAGE}`);
    if (key in opts) fail(`Duplicate flag: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) fail(`Missing value for ${arg}`);
    opts[key] = path.resolve(value);
  }
  if (!opts.output) fail(`--output is required\n${USAGE}`);
  if (opts.app && path.extname(opts.app) !== '.app') fail(`--app must end with .app: ${opts.app}`);
  return opts;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) fail(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}\n${r.stderr || r.stdout}`.trim());
  }
  return r.stdout;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fileRecord(file) {
  return { path: file, sha256: sha256(file), bytes: lstatSync(file).size };
}

// Every component from root down to file must be a real directory/file, never a symlink.
function assertRealPath(root, rel, kind) {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) fail(`Not found: ${root}`);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`Not a real directory: ${root}`);
  let cur = root;
  const parts = rel.split('/');
  parts.forEach((part, idx) => {
    cur = path.join(cur, part);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) fail(`Not found: ${cur}`);
    if (st.isSymbolicLink()) fail(`Symlink not allowed: ${cur}`);
    const last = idx === parts.length - 1;
    if (last && kind === 'file' && !st.isFile()) fail(`Not a regular file: ${cur}`);
    if ((!last || kind === 'dir') && !st.isDirectory()) fail(`Not a directory: ${cur}`);
  });
  return cur;
}

function plistValue(plist, key) {
  return run('plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
}

function pngInfo(file) {
  const out = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', '-g', 'format', file]);
  const get = (k) => (out.match(new RegExp(`${k}: (\\S+)`)) || [])[1];
  return {
    width: Number(get('pixelWidth')), height: Number(get('pixelHeight')),
    hasAlpha: get('hasAlpha') === 'yes', format: get('format'),
  };
}

function resolveTargets(opts) {
  const targets = [];
  if (opts.chromiumSrc) {
    const dir = assertRealPath(opts.chromiumSrc, CHROMIUM_BRANDING_DIR, 'dir');
    TARGET_FILES.forEach((f) => assertRealPath(opts.chromiumSrc, `${CHROMIUM_BRANDING_DIR}/${f}`, 'file'));
    targets.push({ label: 'chromium-src', root: opts.chromiumSrc, dir });
  }
  if (opts.app) {
    const dir = assertRealPath(opts.app, 'Contents/Resources', 'dir');
    TARGET_FILES.forEach((f) => assertRealPath(opts.app, `Contents/Resources/${f}`, 'file'));
    const infoPlist = assertRealPath(opts.app, 'Contents/Info.plist', 'file');
    const iconFile = plistValue(infoPlist, 'CFBundleIconFile');
    const iconName = plistValue(infoPlist, 'CFBundleIconName');
    if (iconFile !== 'app.icns' && iconFile !== 'app') fail(`Unexpected CFBundleIconFile: ${iconFile}`);
    if (iconName !== ICON_NAME) fail(`Unexpected CFBundleIconName: ${iconName} (expected ${ICON_NAME})`);
    targets.push({ label: 'app', root: opts.app, dir });
  }
  return targets;
}

function generate(sourcePng, out) {
  const build = path.join(out, 'build');
  const iconset = path.join(build, 'app.iconset');
  const xcassets = path.join(build, 'Assets.xcassets');
  const appiconset = path.join(xcassets, `${ICON_NAME}.appiconset`);
  const compiled = path.join(build, 'compiled');
  for (const d of [build, iconset, xcassets, appiconset, compiled]) mkdirSync(d);

  // Resize only; sips keeps RGBA, no padding, masking, or recoloring.
  for (const { px, name } of ICONSET) {
    const dest = path.join(iconset, name);
    run('sips', ['-s', 'format', 'png', '-z', String(px), String(px), sourcePng, '--out', dest]);
    const info = pngInfo(dest);
    if (info.width !== px || info.height !== px || !info.hasAlpha) {
      fail(`Bad resized PNG ${name}: ${JSON.stringify(info)}`);
    }
    copyFileSync(dest, path.join(appiconset, name), constants.COPYFILE_EXCL);
  }

  const icns = path.join(build, 'app.icns');
  run('iconutil', ['-c', 'icns', '-o', icns, iconset]);
  if (readFileSync(icns).subarray(0, 4).toString('latin1') !== 'icns') fail('iconutil output is not an icns file');

  writeFileSync(path.join(xcassets, 'Contents.json'),
    `${JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(path.join(appiconset, 'Contents.json'), `${JSON.stringify({
    images: ICONSET.map(({ pt, scale, name }) => ({
      filename: name, idiom: 'mac', scale: `${scale}x`, size: `${pt}x${pt}`,
    })),
    info: { author: 'xcode', version: 1 },
  }, null, 2)}\n`, { flag: 'wx' });

  const partialPlist = path.join(compiled, 'icon-info.plist');
  const actoolOut = run('xcrun', ['actool', '--compile', compiled, '--platform', 'macosx',
    '--minimum-deployment-target', '11.0', '--app-icon', ICON_NAME,
    '--output-partial-info-plist', partialPlist, xcassets]);
  if (actoolOut.includes('com.apple.actool.errors')) fail(`actool reported errors:\n${actoolOut}`);
  const car = path.join(compiled, 'Assets.car');
  assertRealPath(compiled, 'Assets.car', 'file');
  if (plistValue(partialPlist, 'CFBundleIconName') !== ICON_NAME) fail('actool partial plist has wrong CFBundleIconName');
  const carInfo = JSON.parse(run('xcrun', ['assetutil', '--info', car]));
  if (!carInfo.some((e) => e.Name === ICON_NAME)) fail(`Assets.car has no ${ICON_NAME} entry`);

  return {
    files: { 'app.icns': icns, 'Assets.car': car },
    records: {
      'app.icns': fileRecord(icns),
      'Assets.car': fileRecord(car),
      'icon-info.plist': fileRecord(partialPlist),
      iconset: ICONSET.map(({ name }) => fileRecord(path.join(iconset, name))),
    },
  };
}

function apply(targets, artifacts, out, manifest, writeManifest) {
  // Back up every target file before touching any of them.
  const entries = [];
  for (const t of targets) {
    const backupDir = path.join(out, 'backups', t.label);
    mkdirSync(backupDir, { recursive: true });
    const files = TARGET_FILES.map((name) => {
      const dest = path.join(t.dir, name);
      const backup = path.join(backupDir, name);
      copyFileSync(dest, backup, constants.COPYFILE_EXCL);
      const before = sha256(dest);
      if (sha256(backup) !== before) fail(`Backup verification failed: ${backup}`);
      const entry = { name, path: dest, backup, before, after: null, src: artifacts.files[name] };
      entries.push(entry);
      return entry;
    });
    manifest.targets.push({ label: t.label, root: t.root, dir: t.dir, files });
  }
  manifest.status = 'backed-up';
  writeManifest();

  const touched = [];
  try {
    for (const e of entries) {
      touched.push(e);
      copyFileSync(e.src, e.path);
      e.after = sha256(e.path);
      if (e.after !== artifacts.records[e.name].sha256) fail(`Copy verification failed: ${e.path}`);
    }
  } catch (err) {
    const rollback = touched.map((e) => {
      try {
        if (sha256(e.path) !== e.before) copyFileSync(e.backup, e.path);
        e.after = sha256(e.path);
        return { path: e.path, restored: e.after === e.before };
      } catch (rbErr) {
        return { path: e.path, restored: false, error: rbErr.message };
      }
    });
    manifest.status = 'rolled-back';
    manifest.error = err.message;
    manifest.rollback = rollback;
    writeManifest();
    const bad = rollback.filter((r) => !r.restored);
    if (bad.length) err.message += `\nROLLBACK INCOMPLETE, restore from backups manually: ${JSON.stringify(bad)}`;
    throw err;
  }
  for (const e of entries) delete e.src;
  manifest.status = 'applied';
  writeManifest();
}

function main() {
  if (process.platform !== 'darwin') fail('macOS only');
  const opts = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePng = assertRealPath(scriptDir, 'icon-source.png', 'file');
  const srcInfo = pngInfo(sourcePng);
  if (srcInfo.format !== 'png' || srcInfo.width !== srcInfo.height || srcInfo.width < 1024 || !srcInfo.hasAlpha) {
    fail(`icon-source.png must be a square RGBA PNG >= 1024px: ${JSON.stringify(srcInfo)}`);
  }
  const srcHash = sha256(sourcePng);

  // Validate targets before generating so bad paths fail fast; re-validated before apply.
  resolveTargets(opts);

  const out = opts.output;
  if (lstatSync(out, { throwIfNoEntry: false })) fail(`--output already exists (refusing to reuse): ${out}`);
  mkdirSync(out);

  const manifest = {
    tool: 'apply-icon.mjs',
    createdAt: new Date().toISOString(),
    status: 'generating',
    source: { path: sourcePng, sha256: srcHash, ...srcInfo },
    artifacts: null,
    targets: [],
  };
  const manifestPath = path.join(out, 'manifest.json');
  const writeManifest = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeManifest();

  try {
    const artifacts = generate(sourcePng, out);
    if (sha256(sourcePng) !== srcHash) fail('icon-source.png changed during generation');
    manifest.artifacts = artifacts.records;
    manifest.status = 'generated';
    writeManifest();

    const targets = resolveTargets(opts);
    if (targets.length) apply(targets, artifacts, out, manifest, writeManifest);
  } catch (err) {
    if (manifest.status === 'generating') {
      manifest.status = 'generation-failed';
      manifest.error = err.message;
      writeManifest();
    }
    throw err;
  }

  console.log(`status: ${manifest.status}`);
  console.log(`artifacts: ${path.join(out, 'build')}`);
  for (const t of manifest.targets) console.log(`applied: ${t.dir}`);
  console.log(`manifest: ${manifestPath}`);
}

try {
  main();
} catch (err) {
  console.error(`apply-icon: ${err.message}`);
  process.exit(1);
}
