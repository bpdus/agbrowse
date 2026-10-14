status: PARTIAL

summary: `src/ipc.mjs`를 구현하고 `Store.events`와 `SessionService.events`에 선택 `limit`을 추가했으며 `test/ipc.test.mjs`를 작성했습니다. 이 샌드박스는 Unix 소켓 bind를 막아(EPERM) 소켓 테스트를 실행하지 못했고, 샌드박스 밖 재실행은 승인되지 않았습니다. 소켓 로직은 한 번도 실행되지 않았습니다. 루트가 `MYBROWSE_IPC_TEST_DIR=/tmp node --test test/ipc.test.mjs`로 검증해야 합니다.