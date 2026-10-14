# turn-03 보고

## 한 일
- `Store.listSummaries(beforeRowid, limit)`: host 범위, rowid 내림차순, 선택 `rowid < ?`, `LIMIT limit+1`로 읽는다. 컬럼은 `substr(task,1,240)` 제목과 id/host/engine/mode/status/revision/created_at/updated_at뿐이다. prompt, result, queue는 읽지 않는다. 반환값은 `{sessions, next_before_rowid, has_more}`이고 빈 페이지에서는 `next_before_rowid`가 null이다. 인자가 잘못되면 TypeError를 던진다.
- `SessionService.listSummaries(...)`는 인자를 검사하고 400 `invalid_request`로 거부한 뒤 Store에 위임한다. 기존 `Store.list()`와 `SessionService.list()`는 바꾸지 않았다.
- IPC `list`: payload에서 `limit`(1~200, 기본 100)과 `before_rowid`(양의 safe integer)만 허용한다. 그 외 필드와 자료형은 400이다.
- listen 직후 실패 정리: listen 성공을 `listening`으로 따로 기록한다. 성공 뒤 lstat이나 소켓 mode 검사가 실패하면 `socketId` 유무와 관계없이 `shutdown()`(디렉터리 rename 후 `server.close`)을 실행한다. listen 자체가 실패하면 빈 디렉터리만 rmdir한다.
  - `socketId`가 없으면 파일을 지우지 않는다. 이 경우 이동한 private 디렉터리는 복구되거나 sibling 이름(`.mybrowse-closing-*`)으로 남을 수 있다. 이것이 보존 가능한 실패 경로다.
  - `socketId`는 listen 직후 lstat 성공 뒤에 기록한다. 그 lstat이 실패하면 같은 경로가 되어 소켓 파일은 지워지지 않고 listener만 닫힌다.
- 테스트: 기존 oversized list 테스트를 페이지 테스트로 바꿨다.
  - 230개 세션(400KB 프롬프트 포함)을 3페이지로 중복·누락 없이 읽고, title 240자와 요약 컬럼 9개를 확인한다.
  - 큰 result는 list에 포함되지 않으며, `get`은 `response_too_large`를 반환한다.
  - 잘못된 cursor/limit 거부 테스트를 추가했다.
  - `service.list`를 덮어쓰던 두 테스트는 `listSummaries`를 덮어쓰도록 바꿨다.
  - 이전 테스트 20개는 유지했다.

## 확인
- 문법 검사와 기존 core/http 테스트 32개는 통과했다.
- 메모리 Store에 230개 세션과 1MB result를 넣고 `listSummaries`를 직접 호출했다. 230건 중복·누락이 없었고, 최신순이었으며, 잘못된 입력은 400이었다.
- 이 샌드박스는 소켓 bind를 막는다(EPERM). IPC 소켓 테스트는 미실행이고 통과로 표시하지 않는다.
- 루트 실행 명령: `MYBROWSE_IPC_TEST_DIR=/private/tmp node --test test/ipc.test.mjs`

## 남은 위험
- listen 직후 검사 실패 경로는 주입 방법이 없어 테스트가 없다. 코드 검토로만 확인했다.
- 새 IPC list 테스트의 기대값(페이지 수 3, get 크기 한계 등)은 실제 실행에서 확인이 필요하다.
- main.mjs의 연결 정리는 수정하지 않았다.
