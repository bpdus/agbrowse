[cli-relay · task · turn 02]

## Objective
루트가 실제 Unix 소켓 검사에서 찾은 문제를 수정한다.

## Scope
기존 src/ipc.mjs와 test/ipc.test.mjs만 수정한다. 나머지 읽기만 한다. 다른 CLI/에이전트/설치/배포를 하지 않는다.

## Context
루트가 MYBROWSE_IPC_TEST_DIR=/private/tmp로 실제 검사를 했다. 재전송 테스트 line224 queue 첫 호출이 false이다. fixture가 browser waiting_user라 queue 불가능한 조건이므로 유효한 running chat 상태에서 queue/dedup를 검사하도록 고친다. 루트 확인: macOS /tmp는symlink이고 기본realpath처리는이미옳다. 테스트설명예시는 /private/tmp로수정한다.
더 중요한 실제실험: Node net.Server.close는 소켓경로의 foreign 대체 일반파일도 자동unlink한다. removeOwn lstat만으로 foreign 보존을보장못한다. 시작때 directory identity/inode와 socket identity를저장한다. close전 소유private directory를 sibling 임시이름으로원자적으로 rename하여 자동unlink가 비어있는원래경로만향하도록한다. close뒤 이동한디렉터리의 같은inode socket만 unlink한다. 다른file/socket이면보존하고, 빈dir면rmdir한다. foreign내용이있으면원래dir가비어있는경우에만원래dir로rename복구한다. 원래dir가재생성됐으면덮어쓰지말고보존해야한다. rename/identity확인실패시foreign삭제없는실패경로를설계하고근거를보고한다. frameworkautounlink제한을감추지않는다. privateparent는 daemon만소유한resource이며rename은정리를위한동작이다. root가실제foreign대체file보존검사를한다. 간단하고명확하게구현한다.
reply encodeFrame가JSON직렬화throw하면 settled=true이후응답못보내는상태를고친다. encode실패는 internal_error의작은frame을보내고닫는다.
초과연결은현재활성집합에없어정리시기다리며수많은linger가생긴다. 초과연결은즉시destroy하여자원상한을확실히한다. 초과응답503보장대신 연결거부로명세변경가능하며테스트맞춘다.
클라이언트disconnect test는현재session존재만검사하여completion증거가아니다. async service.command fake가시작됨을확인한뒤 연결끊고 release하여 완료flag검사한다. serviceclose와상관없는transport동작을분리검사한다.

## Deliverable
정확한수정과실제테스트용case를추가한다. 루트가짧은tmp에서다시검사한다. 샌드박스bind실패는미실행으로보고한다.

## Acceptance
기존테스트실패수정, cyclic/BigInt 응답은internal_error후종료, foreign socket path replacement 보존, 정리동작은자신의dir/inode만대상, 초과연결즉시거부, disconnect후명령완료검증.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/turn-02/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/turn-02/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
