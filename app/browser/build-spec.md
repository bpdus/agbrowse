# Chromium 빌드 명세

작성일: 2026-10-14. 대상은 `browser/build.mjs`입니다.
제품은 고정 Chromium의 `chrome` 타깃을 사용합니다.
arm64와 x64를 별도 개발 빌드로 만듭니다.

## 현재 조건

MacBook은 arm64이며 Xcode 27.0(27A266a)과 SDK 27.0을 사용합니다.
실제 검사에서 Xcode 초기 설정 완료와 APFS를 확인했습니다.
고정 소스의 최소 SDK는 15이며 공식 빌드 SDK는 26.5입니다.
이 드라이버는 기본 SDK 검사 기준을 26.5로 유지합니다.
SDK 27.0의 실제 빌드 호환은 컴파일로 확인해야 합니다.

Chromium 커밋은 `cfaadc5a132d78e1828635aa8405a499f3e14864`입니다.
태그는 `155.0.8059.40`입니다.
depot_tools 커밋은 `52ae103994896b9ce7742a605de8f43b410e5515`입니다.
두 저장소의 주소와 커밋을 `chromium.lock.json`에 기록했습니다.

## 경로와 실행 경계

`--project-root`는 제품 소스 위치를 지정합니다.
`--work-root`는 큰 다운로드와 빌드 캐시 위치를 지정합니다.
기본 캐시는 제품의 `work/`입니다.
이번 작업에서는 현재 작업 폴더의 `work/`를 명시합니다.
제품 산출물 폴더에는 Chromium 체크아웃을 넣지 않습니다.

| 캐시 내부 경로 | 역할 |
|---|---|
| `chromium/src/` | 고정 Chromium 소스와 의존성입니다. |
| `chromium/src/out/Release-arm64/` | arm64 개발 빌드입니다. |
| `chromium/src/out/Release-x64/` | x64 개발 빌드입니다. |
| `depot_tools/` | 고정 빌드 도구입니다. |
| `vpython/`, `cipd-cache/` | 다운로드와 Python 캐시입니다. |

Chromium은 공백 없는 체크아웃 경로와 APFS를 요구합니다.
드라이버는 경로·디스크·CPU·도구·Xcode를 검사합니다.
빌드 병렬 작업 수는 반드시 지정하며 논리 CPU 수를 넘을 수 없습니다.
기본 가용 공간 기준은 prepare/sync 120GiB, gen 60GiB, build 50GiB입니다.
이 공간 기준은 개발용 추정입니다. 실제 사용량은 단계마다 확인합니다.

## 다섯 단계

1. `prepare`는 잠금에서 `.gclient`를 만듭니다. 기존 내용과 다르면 덮어쓰지 않습니다.
2. `sync`는 고정 커밋으로 `gclient sync --no-history`를 실행합니다. 실패한 다운로드는 같은 폴더에서 다시 실행합니다.
3. `gen`은 지정 아키텍처의 GN 설정과 `build.ninja`를 만듭니다. 의존성 동기화가 완료되어야 합니다.
4. `build`는 `autoninja -C out/Release-<arch> -j <N> chrome`를 실행합니다. 종료 코드와 바이너리 아키텍처를 확인합니다.
5. `status`는 기록과 실제 파일을 함께 검사합니다. 다운로드와 생성만 끝났으면 빌드 완료로 표시하지 않습니다.

`prepare` 자체는 Chromium을 다운로드하지 않습니다.
이 작업의 첫 소스 체크아웃은 루트가 고정 태그로 시작했습니다.
첫 체크아웃이 끝난 뒤 드라이버가 정확한 SHA를 검사합니다.
기존 소스의 저장소·커밋이 다르거나 추적 파일이 수정됐으면 동기화를 거부합니다.
드라이버는 기존 체크아웃을 자동 이동하거나 초기화하지 않습니다.

## 개발 빌드 설정

```gn
target_os = "mac"
target_cpu = "arm64" # x64 빌드에서는 "x64"
is_debug = false
is_component_build = true
symbol_level = 0
use_system_xcode = true
is_official_build = false
is_chrome_branded = false
use_remoteexec = false
```

`.gclient`는 `checkout_configuration = "small"`을 사용합니다.
고정 DEPS는 개발에 필요하지 않은 시험 데이터를 생략하는 설정으로 `small`을 제공합니다.
컴포넌트 빌드는 개발용입니다. 배포용 앱은 별도 빌드와 검사가 필요합니다.
`use_lld=false`는 x64 교차 빌드와 설정을 맞추기 위해 추가하지 않았습니다.

## 중단과 재개

동시 실행은 PID와 난수 식별값을 가진 잠금으로 막습니다.
오래되거나 잘못된 잠금도 자동 삭제하지 않습니다.
SIGINT와 SIGTERM을 받으면 소유한 자식 프로세스 그룹에 전달합니다.
자식 종료를 확인한 뒤 드라이버가 잠금을 해제합니다.
실패와 중단은 상태 파일에 기록합니다.

외부 명령은 셸 문자열 대신 인자 배열로 실행합니다.
depot_tools 자동 업데이트와 사용량 보고는 끕니다.
vpython과 CIPD 캐시는 지정한 작업 폴더를 사용합니다.
사용자의 셸 설정과 기존 Chrome 프로필은 수정하지 않습니다.
업스트림 도구의 자체 캐시와 소스 내부 정리 훅은 별도로 실행될 수 있습니다.

## 현재 작업 명령

아래 명령은 현재 작업 폴더에서 실행합니다.

```sh
node outputs/mybrowse/browser/build.mjs prepare --work-root "$PWD/work"
node outputs/mybrowse/browser/build.mjs sync --work-root "$PWD/work" --caffeinate
node outputs/mybrowse/browser/build.mjs gen --work-root "$PWD/work" --arch arm64
node outputs/mybrowse/browser/build.mjs build --work-root "$PWD/work" --arch arm64 --jobs 6 --caffeinate
node outputs/mybrowse/browser/build.mjs status --work-root "$PWD/work" --json
```

x64 빌드에서는 gen과 build의 `--arch`를 `x64`로 지정합니다.
arm64 Mac에서 x64 교차 빌드를 만들 수 있습니다.
대상 iMac에서 앱만 실행한다면 Xcode가 필요하지 않습니다.
iMac에서 직접 빌드한다면 Intel용 Xcode가 필요합니다.

## 수락 증거와 남은 확인

드라이버 검사는 실제 다운로드 없이 위험한 명령과 실패 분기를 확인합니다.
실제 앱의 빌드·실행·스토어 검사는 별도 증거가 필요합니다.
바이너리가 존재하고 아키텍처가 맞아도 GUI 실행을 확인했다고 기록하지 않습니다.

- 고정 의존성 다운로드와 arm64 GN 생성을 실제 실행으로 확인했습니다.
- arm64·x64 컴파일과 대상 Mac 실행은 각각 확인합니다.
- 스토어·Bitwarden·MCP 통합은 앱에서 확인합니다.
- 서명·공증·업데이트는 개발 빌드와 별도로 확인합니다.

CLIrelay가 최초 드라이버를 작성했습니다.
최초 호출은 최종 보고 전에 시간 제한으로 종료했습니다.
루트가 실제 파일을 검토하고 경로·잠금·소스 고정·취소 처리를 보완했습니다.

## 출처

[고정 Mac 빌드 문서](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/docs/mac_build_instructions.md),
[SDK 최소 조건](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/build/config/mac/mac_sdk_overrides.gni),
[공식 SDK 조건](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/build/config/mac/mac_sdk.gni),
[arm64·x64 교차 빌드](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/docs/mac_arm64.md),
[고정 DEPS](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/DEPS).

## 실제 실행에서 보완한 조건

업데이트를 끈 gclient 실행만으로는 GN용 Python 경로 파일이 생성되지 않았습니다.
고정 depot_tools의 `ensure_bootstrap`을 실행하여 Python 3.11.8을 준비했습니다.
도구 폴더를 PATH에 추가한 후 부트스트랩 호출이 오류 출력 없이 끝났습니다.
그 뒤 arm64 GN 생성이 성공했습니다. depot_tools 커밋은 바뀌지 않았습니다.

첫 컴파일에서 Metal Toolchain 누락을 확인했습니다.
`xcodebuild -downloadComponent MetalToolchain`으로 공식 구성 요소를 설치했습니다.
Metal 버전과 설치 상태를 확인한 뒤 같은 빌드를 재개했습니다.
현재 arm64 컴파일은 6개 병렬 작업으로 실행 중입니다.
컴파일 완료와 실제 앱 실행은 아직 확인하지 않았습니다.
