# turn-06 보고

## 한 일
- `ipc_client_mac.cc`만 수정했다.
  - Connect: `base::span(addr.sun_path).copy_prefix_from(base::span(path))`. 경로 길이 103 이하 사전 조건은 그대로다.
  - WriteAll: `std::string_view(data).substr(off)`의 `data()`/`size()`를 `write`에 전달한다.
  - ReadFrame: 포인터 대신 `in[i]`를 unsigned char로 변환하는 람다로 4바이트 길이를 계산한다. `in.size() >= 4` 검사는 유지했다.
  - `<string_view>`와 `base/containers/span.h`를 include했다.
- timeout, framing, UID 확인, 억제/플러그인 해제는 건드리지 않았다.

## 확인
- 코드 재독과 grep으로 위험 지점이 사라진 것만 확인했다.

## 위험 (미검증)
- 실제 clang 컴파일과 플러그인 통과는 확인하지 못했다.
- `copy_prefix_from`은 `path`가 104바이트를 넘으면 CHECK로 종료한다. 호출 전 길이 검사가 유지되는지는 root가 확인해야 한다.
- 소켓 전송 검사도 실행하지 않았다.
