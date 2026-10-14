# turn-01 보고

## 한 일
- `browser/native/ipc_client_mac.h/.cc`: 명세의 공개 API(`IpcError`, `IpcReply`, `ExchangeAgentFrame`)를 선언·구현했다.
- `browser/native/ipc_client_test.cc`: `<socket> <body> [timeout_ms]`를 받는 하니스. 성공 시 body를 stdout에, 실패 시 enum 정수만 stderr에 쓰고 exit 1. 요청 본문과 토큰은 출력하지 않는다.

## 구현 요점
- timeout 1~60000ms 밖, 요청 0 또는 1MiB 초과, 경로 오류(상대 경로, NUL, 103바이트 초과, `.`/`..`, `//`, 끝 `/`)는 kInvalidInput.
- 부모는 lstat로 디렉터리·현재 euid 소유·정확히 0700, 소켓은 lstat로 소켓·소유자·정확히 0600을 확인한다. symlink는 lstat 때문에 거부된다. 실패는 kUnsafeFilesystem.
- nonblocking, CLOEXEC, SO_NOSIGPIPE를 설정한다. connect부터 EOF까지 steady_clock 단일 deadline을 쓰고, poll 전마다 남은 시간을 다시 계산한다(EINTR 포함).
- connect 후 getpeereid가 euid와 다르면 요청 전송 없이 kPeerMismatch.
- 요청은 uint32BE 길이+본문을 짧은 쓰기까지 처리해 보낸 뒤 shutdown(SHUT_WR)한다.
- 응답은 길이 0이면 kProtocol, 1MiB 초과면 kResponseTooLarge(본문을 읽기 전), 부족·추가 바이트는 kProtocol이다. 본문 후 정상 EOF를 확인한다. 실패 시 body는 비어 있다.
- FD는 RAII로 닫고 close가 errno를 바꾸지 않게 저장·복원한다. 전송 후 오류에도 재시도하지 않는다.

## 확인
- `clang++ -std=c++17 -Wall -Wextra -Werror` 컴파일·링크 통과(출력은 /dev/null). Apple clang 21.0.0. 샌드박스 때문에 xcrun 캐시 오류 메시지가 나오지만 종료 코드는 0이다.
- system/popen/exec 문자열 없음.

## 미검증·위험
- 실제 소켓 동작(조각난 응답, half-close, EOF, timeout, 권한 오류, 긴 경로, 잘못된 길이)은 실행하지 않았다. 루트가 Node fixture로 확인해야 한다.
- 검사와 connect 사이의 경쟁은 peer UID 검사로만 보완된다. 부모의 상위 경로 조상은 검사하지 않는다(명세는 부모만 요구).
- connect가 EAGAIN(백로그 가득)을 반환하면 kSocketFailure로 처리한다.
- Chromium/Mojo 연결은 하지 않았고 완료를 주장하지 않는다.
