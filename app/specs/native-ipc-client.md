---
title: MyBrowse 네이티브 IPC 클라이언트
summary: macOS 브라우저 프로세스에서만 사용하는 Unix 소켓 클라이언트의 계약을 정합니다.
created: 2026-10-14
updated: 2026-10-14
note_type: spec
status: draft
language: ko
render_target: github
---
# MyBrowse 네이티브 IPC 클라이언트

이 명세는 `webui-ipc.md`의 C++ 전송 계층을 정합니다.
Chromium UI 스레드는 이 함수를 직접 호출하지 않습니다.
WebUI 통합 후 ThreadPool이 동기 함수를 실행합니다.
renderer는 소켓 경로나 인증 값을 직접 전달하지 않습니다.

## 공개 인터페이스

`browser/native/ipc_client_mac.h`와 `.cc`는 POSIX와 C++17 표준 라이브러리만 사용합니다.
외부 의존성을 추가하지 않습니다.
JSON 생성과 응답 해석은 Chromium의 호출자가 담당합니다.
전송 계층은 JSON 본문을 로그에 출력하지 않습니다.

```cpp
namespace mybrowse {
enum class IpcError {
  kNone, kInvalidInput, kUnsafeFilesystem, kSocketFailure,
  kPeerMismatch, kTimeout, kProtocol, kResponseTooLarge
};
struct IpcReply {
  IpcError error;
  std::string body;
};
IpcReply ExchangeAgentFrame(const std::string& socket_path,
                           const std::string& request_json,
                           int timeout_ms = 35000);
}
```

호출자는 비공개 connection.json과 token 파일을 먼저 검사합니다.
전송 계층은 socket_path의 부모와 소켓을 별도로 검사합니다.

## 경로와 권한

경로는 절대 경로이며 UTF-8 기준 103바이트 이하입니다.
NUL, 점 경로 요소와 불필요한 경로 구분자는 거부합니다.
부모 디렉터리는 현재 사용자가 소유한 0700 디렉터리여야 합니다.
소켓은 현재 사용자가 소유한 0600 Unix 소켓이어야 합니다.
부모 디렉터리와 소켓이 심볼릭 링크이면 거부합니다.
연결 후 `getpeereid`가 현재 UID와 다르면 요청을 보내지 않습니다.
루트의 다른 사용자 소켓이나 공개 소켓으로 대체하지 않습니다.
검사와 연결 사이의 경쟁은 peer UID 검사로 보완합니다.
파일 소유자 검사만으로 프로세스 신원을 완전히 보장한다고 주장하지 않습니다.

## 전송과 시간 제한

요청 길이는 1~1MiB로 제한합니다.
소켓은 nonblocking이며 CLOEXEC를 설정합니다.
macOS에서는 SO_NOSIGPIPE를 설정합니다.
poll과 단조 시간을 사용하여 연결부터 EOF까지 전체 시간 제한을 적용합니다.
EINTR 뒤에는 남은 시간을 다시 계산합니다.
짧은 읽기와 짧은 쓰기는 남은 바이트를 처리합니다.

요청 프레임을 모두 보낸 뒤 shutdown(SHUT_WR)을 호출합니다.
응답 길이는 4바이트 big-endian 값입니다.
길이 0이면 protocol 오류입니다.
1MiB를 넘으면 response_too_large 오류입니다.
응답의 길이가 부족하거나 추가 바이트가 있으면 protocol 오류입니다.
응답 본문을 다 받은 뒤 정상 EOF까지 확인합니다.
모든 종료 경로에서 소유한 FD만 닫습니다.
변경 요청의 전송 이후 오류가 발생해도 요청을 자동 재실행하지 않습니다.

## 검증

Xcode clang으로 독립 실행 파일을 컴파일합니다.
실제 Unix 소켓의 조각난 응답, half-close, EOF와 시간 제한을 검사합니다.
권한이 잘못된 소켓, symlink와 긴 경로를 거부하는지 검사합니다.
잘못된 길이, 짧은 본문과 추가 응답도 거부해야 합니다.

이 검사는 전송 계층의 검증입니다.
Chromium·Mojo 통합과 실제 웹페이지 작업의 검증은 남아 있습니다.
