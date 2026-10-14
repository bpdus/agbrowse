[cli-relay · task · turn 02]

## Objective
방금 검토에서 확인한 UI 대화 섞임과 늦은 명령 응답을 수정한다.
## Scope
수정 가능: mybrowse/ui/app.mjs, mybrowse/ui/selection.mjs, mybrowse/test/ui-selection.test.mjs. 다른 파일은 읽기만 한다. 다른 CLI/하위 에이전트/설치 금지. 원 실행자가 엔진·daemon stop·lock을 수정 중이므로 그 파일은 절대로 바꾸지 않는다.
## Context
openSession 요청 토큰과 활성 세션 id를 함께 검증해야 한다. 홈·설정·새대화 이동도 대기 요청을 무효화해야 한다. 스트림마다 seq를 별도로 유지하고 모든 await 후 현재 세션/요청 토큰을 확인해야 한다. abort한 스트림이나 이전 대화의 이벤트는 새 대화에 섞이면 안 된다. command 응답도 원 대상이 아직 활성일 때만 반영한다. engine 이벤트 prefix engine. 를 이미 처리한다. Claude의 한 턴 복수 assistant_message는 누적하고 Codex의 assistant_delta 이후 finalmessage는 같은 문장을 중복 붙이지 않는다. health가 실패하면 제출 때 명확히 재조회/연결오류를 표시한다.
선택 상태 토큰을 작은 DOM 독립 selection 모듈로 분리해 Node내장 test로 늦은 A/B 응답·old stream·old command·home invalidation을 검증한다. UI CSP/innerHTML금지/메모리토큰은 유지한다. HTTP static allowlist에 selection.mjs 추가는 원 실행자가 한다. 필요한 실제 태스크 필드는 task(원 요약), prompt(현재 턴)다. 상태노트에 plain Englishengineerror를 임의번역해 의미를 바꾸지 않는다.
## Deliverable
세 파일과 실행한검사. 요청 토큰을 전달하는 흐름을 보고한다. 코드 추상화를 최소화한다.
## Acceptance
node --test mybrowse/test/ui-selection.test.mjs 통과. 화면을 빠르게 이동해도 오래된 응답을 반영하지 않는다. old command completion이 다른대화/홈/설정화면을 바꾸지 않는다. 실제내용을 textContent로 표시한다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-000151-claude-mybrowse-code-review/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-000151-claude-mybrowse-code-review/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-000151-claude-mybrowse-code-review/work/_relay/turn-02/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-000151-claude-mybrowse-code-review/work/_relay/turn-02/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
