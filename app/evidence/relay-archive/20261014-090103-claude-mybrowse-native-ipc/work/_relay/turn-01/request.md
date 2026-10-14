[cli-relay · task · turn 01]

## Objective
specs/native-ipc-client.md의 C++17 macOS Unix 소켓 전송 계층을 구현한다.

## Scope
수정 가능: browser/native/ipc_client_mac.h, browser/native/ipc_client_mac.cc, browser/native/ipc_client_test.cc. 나머지는 읽기만 한다. 다른 CLI/하위 에이전트/Node 설치/Chromium 소스 변경/배포를 금지한다.

## Context
루트는 원본 Chromium을 별도로 컴파일하고 있다. 이 코드는 아직 Chromium에 연결하지 않는다. C++17/POSIX만 사용하여 Xcode clang으로 독립 컴파일 가능해야 한다. Node 데몬은 uint32BE 길이+JSON, 한연결 한요청, 클라이언트 halfclose후dispatch, 한응답후EOF이다. 실제 credentials를 읽지 않는다. 루트가 실제 socket검사를 한다.

## Deliverable
명세의 공개 API와 전체 deadline/peer UID/파일권한/FD정리/짧은read-write/EINTR/half-close/strictEOF를 구현한다. timeout_ms는 1~60000 범위, 경로NUL/길이/..요소/부모symlink/lstat UID mode/current user소켓 확인. SO_NOSIGPIPE로 프로세스강제종료를 방지한다. deadline은 connect부터EOF까지 단조시간으로 계산하며 필요하면poll하기전에남은시간검사한다. request/response max1MiB. JSON내용은변경하지않고전달한다. 응답실패body는빈값. 기본close시 errno오염에주의한다.
테스트 실행파일은 첫 argv socket path, 둘째 argv request body, 셋째 argv optional timeout을 받는다. 성공이면 body를stdout, 실패면 enum 정수만stderr, exit1. 토큰이나 요청본문은절대 출력하지 않는다. 테스트하네스에 활용하므로 가짜 자체success를 출력하지 않는다. 루트가 실제Nodefixture와연결한다. 필요하면clang 컴파일만할수있으나 파일은work범위내에만생성한다. tests actualexecution未確認은보고한다.

## Acceptance
선언/정의일치, 무의존 C++17 clang컴파일, no shell/eval/system(), 모두ownedFD정리, peerUID불일치면절대request전송없음, deadline과framingstrict. Chromium/Mojo연결이완료되었다고주장하지않는다. 최종보고는파일/컴파일증거/미검증항목이다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-090103-claude-mybrowse-native-ipc/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-090103-claude-mybrowse-native-ipc/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-090103-claude-mybrowse-native-ipc/work/_relay/turn-01/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-090103-claude-mybrowse-native-ipc/work/_relay/turn-01/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
