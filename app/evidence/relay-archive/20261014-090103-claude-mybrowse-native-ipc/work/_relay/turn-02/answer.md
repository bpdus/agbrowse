**REVISE**

다른 파일을 자동으로 지우는 경로는 찾지 못했습니다. 아래 세 건은 연결 전에 고칠 만한 오류입니다. 모두 소스를 읽어서 판단했고, 제가 실행한 검사는 없습니다. 루트가 보고한 20/70/16 통과 결과는 루트 증거 그대로이며, 저는 재현하지 않았습니다.

**삭제 경로 검토 (`src/ipc.mjs`, `src/main.mjs`)**
- `unlinkSync(movedSocket)`은 이동한 디렉터리 안에서, `lstat` 결과가 소켓이고 dev/ino가 `socketId`와 같을 때만 실행됩니다. 이 호출이 `src/ipc.mjs`의 유일한 명시적 unlink입니다.
- `rmdirSync(moved)`는 `readdirSync`가 빈 목록일 때만 실행됩니다.
- Node 내부의 자동 unlink는 디렉터리를 먼저 옮겨 둔 덕분에 없는 경로만 만납니다.
- `src/main.mjs`는 `rename`으로 `connection.json`을 덮어쓰는 것 외에 삭제하지 않습니다.
- 남는 틈은 `lstat`로 신원을 확인한 뒤 `rename`하기 전의 아주 짧은 구간입니다. 같은 UID 공격자가 디렉터리를 바꿔치면, 빈 외부 디렉터리를 `rmdir`할 수 있습니다. 파일 내용은 지워지지 않고, 같은 UID는 어차피 신뢰 경계 안이라 수정은 필요 없습니다.

**수정할 오류**
1. **[기능] `list`가 커지면 영구 실패합니다.** `src/ipc.mjs:151`은 `service.list()` 전체를 한 프레임에 담습니다. `src/store.mjs:179`의 `list()`는 호스트의 모든 세션 행을 제한 없이 반환합니다. 세션이 쌓이거나 프롬프트·결과가 크면 응답이 1MiB를 넘어 `response_too_large`가 나고, 내부 화면의 목록이 복구되지 않습니다. 최소 수정은 `eventsPage`처럼 응답 크기에 맞춰 자르는 것입니다. 최신순으로 항목을 담다가 한도를 넘으면 멈추고 `has_more`를 붙이거나, `list`에는 요약 필드만 담으면 됩니다. 명세의 `list` 응답에 `has_more`를 추가하는 것도 필요합니다.
2. **[수명] 소켓 확인 실패 시 서버가 남습니다.** `src/ipc.mjs:369`에서 `listen`은 성공했는데 `lstatSync(socketPath)`가 던지면 `socketId`가 null입니다. 그러면 `catch`가 `shutdown()` 대신 `rmdirSync(dir)`만 호출하고, 이 호출은 소켓이 있어 실패합니다. 서버는 계속 열려 있고 소켓과 디렉터리가 남습니다. 최소 수정은 `listen` 성공 직후 `listening = true`를 두고, 이 값이 참이면 `socketId` 없이도 `server.close()`를 포함한 정리를 하는 것입니다.
3. **[수명·보안] 종료 후 `connection.json`이 남습니다.** `src/main.mjs`의 `close()`는 이 파일을 지우지 않습니다. 종료 뒤에는 존재하지 않는 소켓 경로와, 다른 프로세스가 차지할 수 있는 HTTP 포트가 파일에 남습니다. 이 파일을 읽는 HTTP 클라이언트가 해당 포트에 토큰을 보낼 수 있고, 네이티브 클라이언트는 의미 없는 오류를 받습니다. 최소 수정은 `ipc.close()`가 끝난 뒤 이 데몬이 쓴 `connection.json`만 삭제하는 것입니다. 쓸 때 내용이나 dev/ino를 기억해 두었다가, 같을 때만 지웁니다.

**C++ 쪽 (`browser/native/ipc_client_mac.cc`)**
- 프레임 규칙, peer UID, 권한 검사에서 새 오류는 찾지 못했습니다. 루트가 실제 소켓으로 확인한 범위와도 일치합니다.

**미실행 (루트도 미실행으로 보고한 항목)**
- 다른 UID의 peer 부정 검사
- 반복 호출 시 FD 누수 검사

Chromium·Mojo 연결은 이번 검토 범위 밖이며, 완료를 주장하지 않습니다.