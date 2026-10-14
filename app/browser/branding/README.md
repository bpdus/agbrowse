# apply-icon.mjs

Builds a macOS `app.icns` and `Assets.car` from `icon-source.png` (it must sit next to the script). It can also install both files into a Chromium checkout and/or a built `.app`.

```sh
node apply-icon.mjs --output DIR [--chromium-src DIR] [--app APP_PATH]
```

- `--output DIR`: a new directory. The script fails if it already exists; it never deletes or reuses one.
- `--chromium-src DIR`: replaces `chrome/app/theme/chromium/mac/{app.icns,Assets.car}`.
- `--app APP_PATH`: replaces `Contents/Resources/{app.icns,Assets.car}`. The path must end in `.app`, and `Info.plist` must already have `CFBundleIconFile=app.icns` and `CFBundleIconName=AppIcon`. The plist is never modified.
- With no target flags, the script only builds the artifacts.

## What it does

1. Checks every flag, path, and input before writing anything. Unknown or duplicate flags are errors. Target paths must be real directories and regular files, with no symlinks anywhere below the given root. The source must be a square RGBA PNG of at least 1024 px.
2. Builds `DIR/build/`:
   - `app.iconset/` with sizes 16, 32, 64, 128, 256, 512, and 1024 px, made by `sips` (resize only: alpha and artwork are kept as-is).
   - `app.icns`, made by `iconutil`.
   - `Assets.xcassets/` (root `Contents.json` plus `AppIcon.appiconset`, 16–512 pt at 1x and 2x).
   - `compiled/Assets.car` and `icon-info.plist`, made by `xcrun actool --platform macosx --minimum-deployment-target 11.0 --app-icon AppIcon`. The script confirms that the plist and the `.car` both name `AppIcon`.
3. Copies every target file to `DIR/backups/<chromium-src|app>/` and verifies each copy by hash. Then it overwrites the targets and checks every result by hash.
4. If any copy into a target fails, it restores every file it has already touched from the backups. The manifest then gets status `rolled-back`.
5. `DIR/manifest.json` records SHA-256 hashes for the source PNG, all artifacts, and each target before and after, along with the backup paths and the final status. Backups are never deleted.

All tools run through `spawnSync` with argument arrays (no shell). Any non-zero exit stops the run.

## Limitations

- macOS only. It needs `sips`, `iconutil`, `plutil`, and Xcode's `xcrun actool`/`assetutil`. Nothing gets installed.
- `sips`, `iconutil`, and `actool` write scratch files to the per-user system temp directory, so they fail inside a sandbox that blocks it.
- It does not re-sign the app. The current app is ad-hoc, linker-signed, and has no sealed resources, so replacing these resources needs no re-signing. A properly signed app would need re-signing afterward.
- Copying the files into `--chromium-src` only affects the next build. An existing `.app` changes only through `--app`.
- Finder and the Dock may keep showing the old icon from their cache. After applying, relaunch the app and check the icon in the Dock, Finder, and Cmd-Tab. If it is stale, run `touch APP_PATH` or restart the Dock.
- Undo: copy the files from `DIR/backups/<label>/` back to the paths listed in `manifest.json`.
