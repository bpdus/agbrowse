# turn-01 보고

## 한 일
- `src/ipc.mjs`: `startIpcServer`와 테스트용 `attachIpcConnection`을 구현했다.
  - 프레임 상한 1MiB, 한 연결 한 요청, half-close 뒤에만 파싱/dispatch, 추가 프레임이면 실행 없이 거부.
  - 필드/자료형 검사, sha256+timingSafeEqual 인증, 수신 타임아웃(408), 최대 연결(503), `socket.end`로 backpressure 처리.
  - 내부 오류는 `internal_error`, 응답 상한 초과는 `response_too_large`.
  - events는 limit 100/최대 200, SQL LIMIT limit+1, byte 상한 절단, 첫 event 초과 시 `event_too_large`.
- baseDir: 기본 `/tmp`는 realpath로 해석한다(macOS에서 /tmp가 symlink이기 때문). 명시한 baseDir이 symlink면 거부한다. mkdtemp 0700, 소켓 0600 확인, 경로 103바이트 검사를 한다. close는 자기 소켓과 빈 디렉터리만 제거하고 service는 닫지 않는다.
- `Store.events`, `SessionService.events`에 선택 `limit`을 추가했다. 기존 호출은 전체를 반환한다.
- `test/ipc.test.mjs`: 요청한 항목 전체를 검사한다. `MYBROWSE_IPC_TEST_DIR`가 있으면 `startIpcServer`로, 없으면 work 안 상대 경로 소켓에 `attachIpcConnection`을 붙여 실행한다.

## 확인 결과와 미실행 원인
- 이 샌드박스는 소켓 bind를 막는다(listen EPERM). 샌드박스 밖 실행은 승인되지 않았다.
- 실행됨: 문법 검사, 기존 core/http 테스트 32개 통과, baseDir 거부 테스트 1개 통과.
- 미실행: 소켓을 쓰는 나머지 테스트 전부. 통과로 표시하지 않는다. work 경로가 132바이트라 `startIpcServer`는 짧은 경로가 필요하다.
- 루트 실행 명령: `MYBROWSE_IPC_TEST_DIR=/tmp node --test test/ipc.test.mjs`

## 남은 위험
- 소켓 로직이 실행 검증되지 않았다. 테스트 기대값이나 타이밍(linger 2초, 타임아웃 테스트)에서 수정이 필요할 수 있다.
- 최대 연결 초과 거절 소켓은 close()의 소켓 집합에 없어 최대 2초 뒤 정리된다.
- main.mjs 통합, C++/Mojo, 실제 Chromium은 미구현이다. browserReady=false를 유지한다.
