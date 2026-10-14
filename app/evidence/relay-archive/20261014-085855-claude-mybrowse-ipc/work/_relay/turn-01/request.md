[cli-relay · task · turn 01]

## Objective
specs/webui-ipc.md에 맞춰 무의존 Node24 Unix 소켓 서버를 구현한다.

## Scope
수정 가능: src/ipc.mjs, src/store.mjs, src/service.mjs, test/ipc.test.mjs. 나머지는 읽기만 한다. main.mjs는 루트가 통합한다. 다른 CLI나 하위 에이전트를 호출하지 않는다. 설치/배포/Chromium 빌드를 하지 않는다.

## Context
현재 제품의 SessionService는 실제 Codex/Claude 실행을 소유한다. browserReady=false를 유지한다. 실제 Chromium 컴파일은 루트가 별도 경로에서 실행 중이다. IPC는 네이티브 WebUI 통합 전에 독립 검사한다. 공식 로그인과 토큰을 읽거나 변경하지 않는다. 테스트 토큰만 사용한다. 기존 HTTP SSE 동작과 events(id,afterSeq) 전체 재생을 유지한다.

## Deliverable
export async function startIpcServer({service,token,hostId,baseDir?,receiveTimeoutMs=15000,maxConnections=32}) -> {socketPath, async close()}.
baseDir 기본값은 /tmp이다. baseDir은 실제 디렉터리이며 symlink이면 거부한다. 새 mkdtemp private0700 디렉터리와 socket0600, 경로길이103bytes 이하를 검사한다. 기존 파일 회수/삭제는 금지한다. close는 연결을 닫고 자신의 소켓/빈 디렉터리만 제거한다. close는 service를 닫지 않는다.
프레임 상한 1MiB, 한 연결 한 요청이다. net.createServer({allowHalfOpen:true})를 사용한다. 클라이언트 half-close 뒤에만 파싱/dispatch하여 추가 프레임이면 첫 변경도 실행하지 않는다. 형식/필드/자료형 검사와 hash+timingSafeEqual 토큰 인증을 구현한다. send/error 응답에 token/stack/내부path를 넣지 않는다. 최대연결 초과와 수신타임아웃을 처리한다. 출력 backpressure/종료까지 안전하게 처리한다. 연결 끊김으로 service 명령을 취소하지 않는다.
허용 op health/list/get/create/command/events만 구현한다. host mismatch409, create/get/command는 기존 서비스에 위임한다. events는 limit100/최대200, 안전한after_seq, SQL LIMIT limit+1로 유한 페이지를 반환한다. Store.events와 SessionService.events에 선택 limit을 추가하되 기존 호출은 전체를 반환한다. byte 상한에 맞춰 반환하며 첫 event가 너무 크면 event_too_large. 일반 응답이 상한 초과하면 response_too_large 오류, 내부 오류는 internal_error로 가린다.
실제 Unix socket Node 테스트를 작성한다. 테스트의 임시파일도 work 폴더 안에서만 만들어야 한다. 릴레이 작업 경로가 길어 socket bind를 못하면 루트용 테스트를 작성하고 미실행 원인을 보고한다. 샌드박스 bind제한을 가짜 실행 성공으로 표시하지 않는다. baseDir를 process.env.MYBROWSE_IPC_TEST_DIR로 지정 가능하게 테스트하여 루트가 /tmp의 짧은 경로에서 실제 검사한다.

## Acceptance
조각난 프레임/halfclose/추가프레임/잘못된토큰/UTF8/길이상한/알수없는필드/host불일치/재전송409/이벤트페이지/큰응답/수신타임아웃/종료정리를 검사한다. 유효한 browser 요청은 waiting_user이며 엔진은 실행하지 않는다. main/C++/실제Chromium은 미구현으로 명확히 표시한다. 루트가 코드와 검사 결과를 직접 검토한다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/turn-01/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/turn-01/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
