# turn-02 보고: 세션 데몬 코어와 HTTP API

## 한 일
`mybrowse/specs/contracts.md`에 맞춰 6개 파일을 새로 만들었습니다. 그 밖의 파일은 바꾸지 않았습니다.

- `src/store.mjs`: `Store(databasePath, hostId)`를 구현했습니다. 사용하는 저장소는 `node:sqlite`입니다.
  - 테이블은 sessions, events, commands 세 개입니다.
  - 세션 생성 시 `(host, client_id, request_id)` 키로 원자적으로 중복을 막습니다.
  - 같은 키로 다른 본문이 오면 `request_conflict`를 반환합니다.
  - 재시작하면 `running`과 `queued` 세션을 `uncertain`으로 바꾸고 `recovered_uncertain` 이벤트를 남깁니다. 재실행은 하지 않습니다.
  - `update`의 `expectedRevision`으로 낙관적 잠금을 적용합니다. `bump:false`는 엔진 ID 기록에만 씁니다.
- `src/broker.mjs`: `acquire`, `release`, `block`, `allow`, `dispatch`를 구현했습니다.
  - lease는 host, profile, tab 단위입니다. tab을 생략하면 프로필 전체를 잡습니다.
  - dispatch는 실행 직전에 block, revision, lease를 차례로 검사합니다. revision은 함수로 넘기면 dispatch 시점의 값을 읽습니다.
  - `chrome_evaluate`와 알 수 없는 도구는 mutation으로 처리합니다. mutation이 예외로 끝나면 `uncertain`, `executed:'unknown'`을 반환합니다.
- `src/service.mjs`: `SessionService`가 엔진 실행을 소유합니다.
  - 실행마다 run 토큰을 두고, 현재 run의 callback만 받아들입니다. 늦게 온 callback이나 지난 run의 callback은 무시합니다.
  - `onWaiting` 뒤에 오는 완료 신호는 `waiting_user`를 덮어쓰지 못합니다.
  - 시작 중에 stop이 오면 상태를 즉시 `paused`로 바꿉니다. 그 뒤 handle이 도착하면 바로 `stop()`을 호출하고 활성화하지 않습니다.
  - stop 순서는 broker block을 먼저 하고 그다음 `engine.stop`입니다. in-flight mutation이 있으면 `uncertain`을 우선합니다.
  - queue는 현재 턴이 `done`으로 끝난 뒤 같은 engine_session_id로 새 턴을 시작합니다. 원래 작업은 `task`에 보존하고, 이번 턴 지시는 `prompt`에 넣습니다.
- `src/http.mjs`: `createHttpServer({service, token, hostId, uiDir})`를 구현했습니다.
  - `listen`을 감싸서 127.0.0.1에서만 받도록 강제합니다.
  - Host 헤더와 Origin은 서버 자신의 loopback 값만 허용합니다. CORS 헤더는 보내지 않습니다.
  - 토큰은 timing-safe 방식으로 비교합니다. URL에 토큰이 있으면 거부합니다.
  - 본문은 64KiB로 제한하고 JSON 형식만 받습니다.
  - SSE는 구독을 먼저 시작한 뒤 저장된 이벤트를 재생하고, seq로 중복을 제거합니다. `Last-Event-ID`와 heartbeat도 지원합니다.
  - `/ui`는 허용 목록에 있는 파일만 CSP 헤더와 함께 토큰 없이 제공합니다.
- `test/core.test.mjs`: 경계 검사 23개입니다. 가짜 엔진을 쓰므로 실제 LLM 검증이 아닙니다.
- `test/http.test.mjs`: HTTP 검사 9개입니다. 가짜 엔진과 메모리 소켓 쌍을 씁니다.

## 확인 방법
- `node --test mybrowse/test/core.test.mjs mybrowse/test/http.test.mjs`를 3회 반복했고 매회 32/32 통과했습니다.
- 샌드박스가 loopback listen을 EPERM으로 막았습니다. 그래서 HTTP 검사는 실제 `node:http` 서버와 클라이언트를 메모리 Duplex 쌍으로 연결해 실행했습니다. stub한 것은 `server.address()` 하나입니다.
  - 파싱, 라우팅, 헤더, SSE는 실제 코드 경로를 탑니다.
  - 실제 TCP 바인딩은 검증하지 않았습니다.
- 실패한 실행이 `$TMPDIR`에 남긴 임시 디렉터리는 삭제했습니다.

## 구현 중 내린 선택 (계약에 명시되지 않은 부분)
1. `Store.create`는 `{session, created}`를 반환합니다.
2. `service.get`은 세션이 없으면 404 `ServiceError`를 던집니다.
3. 재시작할 때 `queued` 상태도 `uncertain`으로 바꿉니다. 엔진 프로세스가 이미 시작됐을 수 있기 때문입니다.
4. queue와 steer는 실행 중인 턴이 있을 때만 받습니다. 없으면 409 `not_running`입니다.
   - stop도 실행 중이 아니면 409입니다.
   - steer, queue, resume에는 text가 필요합니다.
5. steer는 revision을 먼저 올린 뒤 `handle.steer`를 기다립니다. 실패하면 502 `steer_failed`를 반환하고, 이때 revision은 이미 올라가 있습니다. 대신 명령 검사가 모두 동기로 끝나므로 같은 revision으로 들어온 두 명령이 동시에 통과할 수 없습니다.
6. `close()`는 실행 중인 세션을 `paused`로 바꾸고 `daemon_stopped` 이벤트를 남깁니다. in-flight mutation이 있으면 `uncertain`입니다.
7. 엔진 이벤트 타입에는 `engine.` 접두사를 붙입니다.
8. stop은 queue를 지우지 않습니다. resume 뒤 턴이 `done`으로 끝나면 남은 queue가 이어서 전달됩니다.

## 남은 위험과 미검증 항목
- 실제 Codex와 Claude 드라이버의 callback 순서는 아직 확인하지 않았습니다. `src/engines`는 이번 범위 밖입니다.
- 실제 TCP 바인딩과 `main.mjs`의 listen 호출 방식(127.0.0.1 또는 localhost만 허용)이 서로 맞는지 확인해야 합니다.
- Broker의 관찰 도구 이름은 추정한 값입니다. 실제 MCP 파이프에 연결하지 않았으므로 `browserReady`는 false로 유지해야 합니다.
- 명령 기록(`recordCommand`)은 상태 update와 같은 트랜잭션이 아닙니다. 두 호출은 연속된 동기 호출이지만, 그 사이에 프로세스가 죽으면 재전송한 명령이 다시 실행될 수 있습니다.
- Chromium, 확장, Muse VM, opencodex, 두 Mac 실행은 모두 미검증입니다.
