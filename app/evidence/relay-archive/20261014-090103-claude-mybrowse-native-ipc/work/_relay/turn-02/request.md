[cli-relay · ask · turn 02]

질문: src/ipc.mjs, src/main.mjs, browser/native/ipc_client_mac.cc를 읽고, 내부 화면에 연결하기 전에 수정할 실제 오류를 최대 5개 보고하세요. 읽기 전용입니다. 다른 CLI/에이전트/설치/배포를 하지 마세요.
맥락: 루트는 Xcode clang -std=c++17 -Wall -Wextra -Werror 컴파일을 통과했습니다. 실제 Node Unix 소켓 검사20개, 기존 포함 Node70개, native C++16개 검사 통과했습니다. C++는 actualsocket으로 UID일치/권한/halfclose/조각응답/엄격EOF/timeout를 확인했습니다. 다른UID의peer 부정검사와 FDleak반복검사는미실행입니다. 아직Chromium/Mojo는연결하지않았습니다. 최신 Node소스는루트가closePromise 재사용/디렉터리권한명시/mainIPC및원자connection.json 저장을추가했습니다. WebUI계약최신본은 root webui-ipc.md입니다.
루트실험으로 Node서버close는foreign 대체socketpath파일도unlink함을 확인했고, 정상shutdown전 ownedprivate dir를 임시이름으로이동하여보존하도록수정했습니다. identity변경시close는정리를거부하며maxConnections=0/unref합니다. 루트의별도자식process.exit 실험에서foreign파일은보존됐습니다. 다른파일을자동삭제하는경로가있는지읽어보세요.
출력: PASS 또는 REVISE 한 줄. 기능/보안/수명오류와최소수정만 제시하세요. formatting확장권고/아직연결안된Chromium부분은부정확한완료주장검사외제외합니다. 테스트결과는루트증거와귀하실행을구분하세요.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-090103-claude-mybrowse-native-ipc/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-090103-claude-mybrowse-native-ipc/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 이번 요청은 질문이다. 파일을 만들거나 수정하지 않는다. 답변은 최종 메시지로만 한다.
