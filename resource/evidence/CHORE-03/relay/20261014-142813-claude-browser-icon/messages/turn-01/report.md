# turn-01 보고

## 한 일
- `apply-icon.mjs`를 만들었습니다. Node ESM 내장 모듈만 쓰고, 외부 도구는 모두 `spawnSync`에 인자 배열로 넘겨 shell 없이 실행합니다.
  - 인자 검사: 모르는 플래그, 중복 플래그, 값 누락을 거부합니다. `--output`은 반드시 받고, 이미 있으면 실패합니다. `--app`은 `.app`으로 끝나야 합니다.
  - 경로 검사: 지정한 root부터 대상 파일까지 모든 경로 단계가 실제 디렉터리나 일반 파일이어야 하며 symlink를 허용하지 않습니다. `--app`이면 Info.plist의 `CFBundleIconFile`이 app.icns(또는 app)이고 `CFBundleIconName`이 AppIcon인지 읽기 전용으로 확인합니다. 이 검사는 output을 만들기 전과 대상에 쓰기 직전에 두 번 합니다.
  - 원본 확인: 원본 PNG가 정사각형 RGBA이고 1024px 이상인지 확인합니다. 생성 전후의 해시를 비교해 원본이 바뀌지 않았는지도 확인합니다.
  - 생성: sips로 크기만 조절해 iconset을 만듭니다(16~1024px, 크기마다 알파와 픽셀 크기 확인). 이어서 iconutil로 `app.icns`를 만들고 icns 시그니처를 확인합니다. xcassets에는 root `Contents.json`과 `AppIcon.appiconset`(16~512, 1x/2x)을 넣습니다. 지정된 인자로 actool을 실행한 뒤 partial plist의 `CFBundleIconName=AppIcon`과 `assetutil --info`의 AppIcon 항목을 확인합니다.
  - 적용: 대상 파일을 모두 `backups/<label>/`에 백업하고 해시로 검증한 다음에만 덮어씁니다. 복사할 때마다 해시를 확인하고, 실패하면 이미 건드린 파일을 백업으로 되돌립니다(manifest 상태 `rolled-back`). 되돌리지 못한 파일이 있으면 오류 메시지에 그 경로를 적습니다.
  - `manifest.json`에는 원본, 산출물, 대상의 적용 전·후 해시와 백업 경로, 상태를 기록합니다. 상태는 generating, generated, backed-up, applied, rolled-back, generation-failed 중 하나입니다.
- `README.md`에 짧은 사용법과 제약을 적었습니다(서명, 아이콘 캐시, sandbox의 임시 폴더 제한, 되돌리는 방법).

## 확인 방법
- `node --check apply-icon.mjs`가 통과했습니다.
- 인자 오류 7가지, 인자 없음, symlink 대상, 잘못된 CFBundleIconName은 모두 output을 만들기 전에 exit 1로 거부했습니다.
- 확인용으로 만든 `_fx`와 `_scratch-gen`은 지웠습니다. `icon-source.png`는 수정하지 않았습니다.

## 남은 위험
- **아이콘 생성과 적용·롤백을 끝까지 실행해 보지 못했습니다.** 이 sandbox에서는 sips, iconutil, actool이 모두 사용자별 시스템 임시 폴더(`/var/folders/.../T`)에 쓰지 못해 실패했습니다. sandbox 해제 실행도 거부됐습니다. root는 sandbox 밖에서 다음 순서로 확인해야 합니다.
  1. 생성만: `node apply-icon.mjs --output <새 폴더>`
  2. 실제 .app의 복사본에 `--app` 적용
  3. 실제 대상에 적용
  4. 네이티브 UI 확인(Dock, Finder, Cmd-Tab)
- actool은 `compiled/` 안에 `AppIcon.icns`도 함께 만듭니다. 대상에 복사하는 파일은 iconutil로 만든 `app.icns`뿐입니다.
- 실패 시 actool이 exit 1을 내는 것을 확인했습니다. exit 0인데 `com.apple.actool.errors`가 출력되는 경우에도 실패로 처리하도록 guard를 추가했습니다.
- Chromium 쪽은 브랜딩 파일만 바꾸므로 다음 빌드부터 반영됩니다. Chromium source의 plist는 확인하지 않습니다.
