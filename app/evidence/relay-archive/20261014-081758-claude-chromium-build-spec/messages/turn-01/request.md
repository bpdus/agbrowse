[cli-relay · task · turn 01]

## Objective
고정 Chromium 소스를 내려받고 arm64/x64 개발 빌드를 만드는 재현 가능한 빌드 드라이버와 상세 명세를 구현한다.

## Scope
수정 가능: browser/build.mjs, browser/build-spec.md, browser/test/build.test.mjs. 나머지는 읽기만 한다. 설치·다운로드·실제 빌드는 하지 않는다. 다른 CLI나 하위 에이전트를 호출하지 않는다.

## Context
browser/chromium.lock.json과 chromium-research/의 고정 커밋 자료를 읽는다. 루트가 Mac에서 실제 다운로드와 빌드를 한다. MacBook arm64: Xcode27.0/27A266a, firstLaunch 성공, SDK27.0, 328GiB 가용. iMac x86_64는 아직 CLT뿐이다. 기존 제품 Node24.15, 무의존 ESM이다. 독립 Chromium chrome target이 최종 목표이며 Electron/WKWebView/외부 Chrome으로 바꾸면 안 된다. 전체 Chromium의 소스와 산출물은 project/work/chromium에 둔다. depot_tools는 project/work/depot_tools에 둔다. 홈/사용자 원본 Chrome 설정을 변경하지 않는다.

## Deliverable
명시적 단계 prepare/sync/gen/build/status를 제공하는 Node ESM 드라이버와 명세. prepare는 경로를 검증하고 .gclient와 고정 커밋 source checkout을 준비한다. sync는 gclient --no-history와 잠금 커밋을 쓰며 중단 후 재개가 가능하다. gen은 target_cpu arm64 또는 x64, is_debug=false, is_component_build=true, symbol_level=0, use_system_xcode=true, is_official_build=false, is_chrome_branded=false 및 검증된 설정으로 chrome 빌드파일을 만든다. build는 명시적 제한된 jobs로 autoninja chrome를 실행한다. 디스크/CPU/Xcode/소스 SHA 검증과 실패 exit code 전달이 필요하다. 자동 git reset/clean/삭제/사용자 shell설정 수정은 금지한다. 다운로드 상태를 완료 빌드라고 표시하면 안 된다. gclient configuration small은 자료의 지원 범위를 검토한다.

## Acceptance
실제 실행 argv 배열을 사용한다. 경로 공백/이미 존재하는 소스/HEAD 불일치/잘못된 arch/툴 부재를 처리한다. 테스트는 실제 다운로드 없이 위험한 명령과 검증 분기를 확인한다. 루트는 실제 파일과 테스트를 다시 검증한다. 불확실한 upstream 플래그는 명세에 밝힌다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-081758-claude-chromium-build-spec/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-081758-claude-chromium-build-spec/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-081758-claude-chromium-build-spec/work/_relay/turn-01/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-081758-claude-chromium-build-spec/work/_relay/turn-01/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
