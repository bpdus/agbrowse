[cli-relay · task · turn 02]

## Objective
확정한 MyBrowse 스펙에 따라 SQLite 세션 데몬과 API를 구현하고 결정적 경계 검사를 작성한다.
## Scope
수정 가능: mybrowse/src/store.mjs, mybrowse/src/broker.mjs, mybrowse/src/service.mjs, mybrowse/src/http.mjs, mybrowse/test/core.test.mjs, mybrowse/test/http.test.mjs. 이 6개 파일만 생성/수정한다. mybrowse/specs/contracts.md와 plan.json은 읽기만 한다. 다른 CLI/하위 에이전트, 설치, 네트워크, 홈 디렉터리 접근은 금지한다.
## Context
현재 work에는 mybrowse/plan.json, specs/contracts.md, task-*.md가 있다. Node24.15 내장 sqlite/http/test만 사용하고 ESM .mjs로 만든다. 원 실행자가 src/engines, main.mjs, cli.mjs, UI를 병행 구현한다. 파일 소유권이 겹치지 않게 한다. API 정확한 exported 이름/시그니처는 contracts.md와 일치시킨다.
주의: Store: constructor(databasePath,hostId). Service methods create/list/get/command/events/subscribe/close. createHttpServer({service,token,hostId,uiDir})는 server를 반환한다. 브라우저 미통합이면 반드시 waiting_user. health capabilities queue_boundary=turn_end, browser=false, opencodex=false와 engines를 표시한다. /ui index/app/style은 토큰 없이 정적 파일만 제공하고 UI api는 bearer인증한다. health외 API 모두 인증하며 wrongOrigin/host는 거부한다. callback 이벤트를 구독하고 SSE replay를 구현한다. create 및 commands는 중복키 payload mismatch를 거부한다. status와revision이 올바른지 확인한다. 세션 API 응답은 {session:<Session>}, 목록은 {sessions:[Session]}, command도 {session}이다. /health는 {host, capabilities}이다.
engine callbacks onEvent,onId,onEnd,onWaiting, start가 async handle을 반환한다. 서비스는 실제 session.engine_session_id를 유지한다. 다음 턴 실행 시 session.prompt를 queued/resume text로 설정하되 원래 작업 요약은 보존한다. handle.stop/steer만 있다. onEnd.status done/failed/paused/uncertain. onWaiting callback 후 늦은 completion이 waiting을 덮어쓰지 않게 한다.
command expected_revision/request_id는 필수. steer 미지원은 409. stop시 시작 중 핸들이 없는 race까지 중단해야 한다. 소유 세션 latecallbacks는 ignored. in-flight mutation이 있으면 uncertain 우선. 시작 중 호출한 stop의 반환 이후 새 엔진을 활성화하지 않는다. core tests에서는 fakeengine을 사용하고 실제검증이라고 하지 않는다.
## Deliverable
위 6개 파일, 테스트 결과, 실제 미지원/미검증 항목을 보고한다. 필요하면 스펙의 모순을 먼저 식별하고 안전한 수정 제안과 구현 선택을 보고한다.
## Acceptance
node --test mybrowse/test/core.test.mjs mybrowse/test/http.test.mjs 통과. SQLite restart, duplicate/create/command, conflicts, badhost, cancellation-race, queueafterturn, stale-revision, lease/block/uncertain, SSE replay, token/origin/body-limit을 실제 동작으로 검사한다. 6개 파일만 변경한다. 전역 설정과 실행 중 브라우저는 건드리지 않는다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261013-234244-claude-mybrowse-plan-review/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261013-234244-claude-mybrowse-plan-review/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261013-234244-claude-mybrowse-plan-review/work/_relay/turn-02/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261013-234244-claude-mybrowse-plan-review/work/_relay/turn-02/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
