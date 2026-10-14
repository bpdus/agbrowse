**PASS**

세 항목 모두 `src/ipc.mjs`, `src/main.mjs`, `src/store.mjs`, `src/service.mjs`를 읽어 확인했습니다. 코드를 실행하지는 않았습니다. 75개와 main 실제 프로세스 4개, 실제 C++17 검사, iMac x64 16개 통과는 루트 증거로만 받아들입니다.

1. **list 페이지네이션:** 해결됐습니다.
   - `listSummaries`는 호스트별로 `rowid < ?`와 `LIMIT limit+1`로 읽고, `title`은 `substr(task,1,240)`입니다.
   - `src/ipc.mjs`의 `list`는 기본 100개, 최대 200개로 제한합니다. 최악의 경우에도 200개 × 약 1.8KB 정도라 1MiB 안에 들어옵니다. 이는 제가 어림한 값입니다.
   - `before_rowid`와 `limit`은 `ipc.mjs`와 서비스에서 이중으로 검증합니다.
   - HTTP `list`는 바꾸지 않았다는 말에 맞게 `store.list()`가 그대로입니다.
2. **listen 후 실패 정리:** 해결됐습니다. `listening`이 true가 되는 시점부터 소켓 확인이 실패해도 `shutdown()`을 호출해 리스너를 닫습니다. `socketId`가 없으면 파일을 삭제하지 않고 디렉터리만 보존합니다.
3. **`connection.json` 정리:**
   - 해결됐습니다. 정상 종료 때 dev/ino/크기/내용이 모두 같을 때만 `unlink`합니다. 외부에서 바꾼 파일은 보존하고, `ENOENT`가 아닌 오류는 실패(exit 1)로 처리합니다.
   - HTTP bind가 실패하면 `startupFailed`로 `close()`가 IPC도 닫고 exit 1로 끝납니다. 이때는 기록이 없으므로 `connection.json`을 건드리지 않습니다.

남은 실제 오류는 없습니다. 아래 두 가지는 수정이 필요한 수준이 아닌 관찰입니다.
- SIGTERM이 HTTP listen 콜백보다 먼저 오면 `connection.json`을 쓰는 순서가 겹칠 수 있습니다. 극히 짧은 구간이고, 다음 시작 때 덮어씁니다.
- 소켓 확인 실패 후 `shutdown()`을 부르면 소켓 파일이 `.mybrowse-closing-*`나 복원된 디렉터리에 남을 수 있습니다. 파일을 지우지 않는 쪽의 안전한 선택입니다.

이 검토는 Chromium·Mojo 앱 완료를 뜻하지 않으며, 완료를 주장하지 않습니다. 다른 UID의 peer 부정 검사와 반복 호출 시 FD 누수 검사는 이전 턴과 마찬가지로 미실행으로 남아 있습니다.