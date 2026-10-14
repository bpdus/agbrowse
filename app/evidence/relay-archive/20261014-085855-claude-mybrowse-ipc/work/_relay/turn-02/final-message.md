status: PARTIAL

summary: 루트가 지적한 5가지를 `src/ipc.mjs`와 `test/ipc.test.mjs`에 반영했습니다. 샌드박스가 소켓 bind를 막아(EPERM) 소켓 테스트는 실행하지 못했고, 문법 검사만 통과했습니다. 루트가 `MYBROWSE_IPC_TEST_DIR=/private/tmp node --test test/ipc.test.mjs`로 다시 검사해야 합니다.

- **재전송 테스트:** running chat 세션에서 queue와 dedup를 검사하도록 고쳤습니다.
- **foreign 파일 보존:** close가 소유 디렉터리를 sibling 이름으로 먼저 rename한 뒤 `server.close()`를 호출합니다. 이동한 디렉터리에서는 같은 inode의 소켓만 지웁니다. Node의 자동 unlink는 막지 못하고 우회만 하며, 같은 사용자의 경쟁 조건 틈이 남습니다. 자세한 내용은 `_relay/turn-02/report.md`에 있습니다.
- **응답 encode 실패:** cyclic이나 BigInt처럼 직렬화가 throw하면 `internal_error` 작은 프레임을 보내고 닫습니다.
- **초과 연결:** 즉시 destroy합니다. 503 응답은 없어졌습니다.
- **disconnect 테스트:** 지연 fake `service.command`가 시작된 뒤 연결을 끊고 release하여 완료 flag를 검사합니다.