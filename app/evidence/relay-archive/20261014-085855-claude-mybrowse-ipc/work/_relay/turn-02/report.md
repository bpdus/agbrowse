# turn-02 보고

## 수정 내용 (src/ipc.mjs)
- **close의 foreign 보존**: 시작 때 디렉터리 dev/ino와 소켓 dev/ino를 저장한다. close는 먼저 디렉터리 identity를 확인한 뒤 sibling 이름(`.mybrowse-closing-<난수>`)으로 rename한다. 그 다음 `server.close()`를 호출한다. 이때 Node의 자동 unlink는 존재하지 않는 원래 경로만 가리킨다. 이동한 디렉터리 안에서는 같은 inode의 소켓만 unlink한다.
  - 디렉터리가 비면 rmdir한다.
  - foreign 내용이 있으면 원래 이름이 비어 있을 때만 rename으로 복구한다. 원래 이름이 다시 생겼으면 덮어쓰지 않고 sibling 이름에 보존한다.
  - 소켓 경로를 대체한 foreign 일반 파일이나 다른 소켓은 inode가 달라 unlink하지 않는다.
- **identity 확인이나 rename 실패 경로**: `server.close()`를 호출하지 않는다. `maxConnections=0`으로 새 연결을 거부하고 `unref()`한 뒤 "filesystem left untouched" 오류로 close를 reject한다. 이 경로에서는 foreign 삭제가 없다. 대신 리스너 핸들이 프로세스 종료까지 남는다.
- **프레임워크 제한**: `net.Server.close()`의 자동 unlink는 막을 수 없고, 디렉터리를 비켜서 우회할 뿐이다. 남는 틈은 두 가지다. (1) rename과 close 사이에 같은 사용자가 원래 이름으로 디렉터리를 다시 만들고 `daemon.sock`을 놓으면 그 파일이 지워질 수 있다. (2) 복구 rename 직전에 원래 이름이 빈 디렉터리로 다시 생기면 그 빈 디렉터리가 덮어써진다. 둘 다 같은 사용자의 경쟁 조건이다.
- **응답 encode 실패**: cyclic이나 BigInt처럼 직렬화가 throw하면 `internal_error` 작은 프레임을 보내고 닫는다. 크기 초과는 기존대로 `response_too_large`다.
- **초과 연결**: 즉시 destroy한다. 503 응답과 linger 타이머는 없앴다. 명세는 "응답 보장" 대신 "연결 거부"로 바뀐다.

## 테스트 변경 (test/ipc.test.mjs)
- 재전송 테스트는 running chat 세션에서 queue와 dedup를 검사한다. 재전송 뒤 queue 길이가 1인지도 확인한다.
- cyclic/BigInt 테스트를 추가했다.
- disconnect 테스트는 지연 fake `service.command`를 쓴다. 시작을 확인하고 연결을 끊은 뒤 release하여 완료 flag를 검사한다. 이후 서버가 계속 응답하는지도 확인한다.
- 초과 연결은 응답 없이 닫히는지와 슬롯이 반환되는지를 검사한다.
- `startIpcServer` 소켓 테스트 5개(foreign 파일 보존, 일반 파일 대체, 다른 소켓 대체, 디렉터리 교체 시 무수정 reject, 정리 후 `.mybrowse-closing-*` 잔여물 없음)를 추가했다.
- 주석 예시를 /private/tmp로 고쳤다.

## 확인
- 문법 검사만 통과했다. 이 샌드박스는 소켓 bind를 막는다(EPERM). 소켓을 쓰는 테스트는 미실행이고 통과로 표시하지 않는다.
- 루트 실행 명령: `MYBROWSE_IPC_TEST_DIR=/private/tmp node --test test/ipc.test.mjs`

## 남은 위험
- 새 close 경로와 테스트는 한 번도 실행되지 않았다. 특히 "다른 소켓 대체" 테스트와 "디렉터리 교체" 테스트의 기대값은 실제 실행에서 확인이 필요하다.
- 원래 이름이 다시 만들어진 경우의 보존은 코드 경로만 있고 테스트가 없다. 시점을 맞추기 어렵기 때문이다.
