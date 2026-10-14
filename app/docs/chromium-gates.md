# Chromium 통합 게이트

2026-10-14에 MacBook의 Xcode 27.0(27A266a), SDK 27.0, Metal Toolchain 27A266a와 초기 설정 완료를 확인했습니다.
MacBook은 arm64이며 APFS를 사용합니다. 검사 시 가용 공간은 324GiB입니다.
iMac은 x86_64입니다. iMac의 마지막 검사에서는 Command Line Tools만 확인했습니다.
MacBook에서 고정 Chromium 체크아웃과 의존성 동기화를 완료했습니다. GN 생성도 성공했습니다. 현재 arm64 앱을 컴파일하고 있습니다. 앱 실행은 아직 확인하지 않았습니다.

| 게이트 | 통과에 필요한 증거 | 현재 상태 |
|---|---|---|
| 1a | 전체 Xcode, SDK, CPU, 디스크 | 빌드 Mac 준비 완료; iMac 대상 실행은 미검증 |
| 1b | 고정 커밋, GN chrome 빌드, 앱 실행 | 소스·의존성·GN 완료; arm64 컴파일 중 |
| 1c | 실제 스토어 Bitwarden 설치·유지·업데이트 | 미실행 |
| 1d | 자체 프로필 Native Messaging과 MCP 왕복 | 미실행 |
| 1e | 브랜딩·WebUI·Mojo 이후 재검증 | 미실행 |

## 빌드 시작 조건

전체 Xcode를 설치한 뒤 `xcodebuild -version`이 성공해야 합니다.
활성 개발자 경로는 전체 Xcode를 가리켜야 합니다.
`xcrun --sdk macosx metal --version`도 성공해야 합니다.
Chromium 커밋은 빌드 시작 전에 고정합니다. 해당 커밋의 요구 Xcode/SDK를 다시 확인합니다.
고정 커밋의 최소 SDK는 15이며 공식 빌드 SDK는 26.5입니다.
현재 SDK 27.0으로 개발 빌드를 시도합니다. 더 새 SDK의 실제 호환은 빌드로 확인해야 합니다.
소스와 빌드 캐시는 `work/chromium/`에 둡니다. 전역 셸 설정을 바꾸지 않습니다.
arm64 Mac에서 x64 교차 빌드가 가능합니다. 두 Mac에서 실제 실행하는 검사는 별도로 필요합니다.

## 데이터와 브리지

브라우저 데이터: `~/Library/Application Support/MyBrowse/Browser/`.
에이전트 데이터: `~/Library/Application Support/MyBrowse/Agent/`.
초기 개발용 Node 데몬은 실행 폴더의 `.mybrowse-data/`를 사용합니다.

공식 확장 호스트 이름은 `com.openai.codexextension`입니다.
MyBrowse 경로만 등록해야 합니다. 기존 Chrome manifest를 바꾸면 안 됩니다.
어댑터의 chrome/edge 목록과 공유 소켓을 그대로 사용하면 다른 브라우저에 붙을 수 있습니다.
전용 0700 소켓 경로와 브라우저·프로필 신원 확인을 먼저 구현해야 합니다.

Bitwarden을 압축 해제해 로드한 결과는 스토어 설치 증거로 인정하지 않습니다.
Bitwarden 생체 잠금 해제는 별도 호환 항목입니다.

출처: [고정 Chromium Mac 빌드 문서](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/docs/mac_build_instructions.md),
[고정 SDK 조건](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/build/config/mac/mac_sdk_overrides.gni),
[교차 빌드 문서](https://chromium.googlesource.com/chromium/src/+/cfaadc5a132d78e1828635aa8405a499f3e14864/docs/mac_arm64.md),
[Chrome MCP 고정 소스](https://github.com/iola1999/codex-control-chrome-mcp/tree/c701215a63fc5ca6bdc208deb27417cb7da3cb44).
