[cli-relay · task · turn 06]

## Objective
Chromium의 unsafe buffer 규칙에 맞게 native IPC overlay만 수정한다.

## Scope
browser/overlay/chrome/browser/ui/webui/mybrowse/ipc_client_mac.cc만 수정한다. standalone native/ipc_client_mac.cc와 실제 Chromium 소스는 수정하지 않는다. 다른 CLI나 검증 우회는 금지한다.

## Context
실제 Chromium clang과 플러그인에서 5개 오류를 확인했다: Connect의 sun_path memcpy, WriteAll의 data.data()+off, ReadFrame의 unsigned char pointer p[1..3]. 계약과 timeout, framing, UID 확인을 바꾸지 말고 안전한 container로 바꾼다. GN은 base에 의존한다.

## Deliverable
Connect의 고정 sun_path 배열은 base::span(addr.sun_path).copy_prefix_from(base::span(path))를 사용하고 base/containers/span.h를 include한다. path length<=103 사전 조건은 유지한다. WriteAll에서는 std::string_view(data).substr(off)를 사용해 포인터 덧셈 없이 data()/size()를 전달한다. Decode는 std::string in의 in[0..3]을 unsigned char로 변환해 계산한다(in.size()>=4 검사 유지). unsafe suppressions, 플러그인 끄기, 경고 무시는 추가하지 않는다.

## Acceptance
변경 한 파일과 보고서를 작성한다. root가 실제 clang 문법 검사와 기존 전송 검사를 재실행한다. 실행하지 않은 검증은 통과라고 쓰지 않는다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-06/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-06/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
