[cli-relay · task · turn 04]

## Objective
앱 내부 목록이 다른 탭의 대화 생성과 상태 변경을 반영하도록 수정한다.

## Scope
browser/overlay/chrome/browser/resources/mybrowse/app.ts와 bridge.ts만 수정한다. 나머지는 읽기만 한다. 다른 CLI 호출, 설치, 실제 Chromium 소스 수정은 금지한다.

## Context
현재 main은 refreshSessions를 한 번만 호출한다. 별도 sidebar WebContents는 새 대화를 계속 반영해야 한다. 목록과 health 읽기는 유한 재시도하며 실패해도 기존 데이터를 보존한다. 오프라인에서도 페이지가 다시 연결을 확인해야 한다. 동시에 여러 목록 조회가 겹치지 않도록 await 후 timeout을 예약한다. pagehide 시 타이머를 취소한다. 변이 요청은 자동 재시도하지 않는다.

## Deliverable
3초 내외 비중첩 목록/health 갱신을 추가하고, 초기 실행과 수명 종료 처리를 정리한다. BridgeError의 proxy_error가 mutating request에서 발생한 경우 결과가 불확실하다는 표지를 유지한다. 실제 health capabilities 구조와 status schema는 specs 및 staged 자료에 맞춘다. UI에 모델 계정, token, 경로는 노출하지 않는다. 기존 selection guard와 이벤트 cursor를 보존한다.

## Acceptance
두 파일에 한정한 변경과 result.json/report.md를 작성한다. 실행하지 않은 TypeScript/GN 검사를 통과했다고 쓰지 않는다. 짧게 마무리한다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-04/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-04/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
