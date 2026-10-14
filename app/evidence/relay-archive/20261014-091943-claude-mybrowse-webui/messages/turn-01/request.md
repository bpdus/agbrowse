[cli-relay · task · turn 01]

## Objective
specs/native-webui.md의 최초 Chromium WebUI와 네이티브 좌측 목록을 overlay로 구현한다.

## Scope
수정가능: browser/overlay/**, browser/patches/native-webui.json. reference/**, specs/**, ui/**, native/**는읽기만한다. 원본Chromium빌드/실행/설치/네트워크/다른CLI/하위에이전트금지.

## Context
reference는 Chromium cfaadc5a132d78e1828635aa8405a499f3e14864 실제소스복사본이다. 루트는원본chrome를별도로컴파일중이다. overlay는아직실제Chromium에적용하지않는다. Node IPC contract는 specs/webui-ipc.md. C++purePOSIX native/ipc_client_mac.h/.cc는루트에서컴파일+17actualUnix검사, x64crosscompile+iMac16검사를통과했다. 필요하면overlay/chrome/browser/ui/webui/mybrowse/ipc_client_mac.*로복사하고include경로만조정한다. 복사원본은수정금지. 기존UI레이아웃을TypeScript로옮길수있다. pi-gui code복사안함, 외부패키지/CDN/iframe금지.

## Deliverable
새파일은overlay하위Chromium상대경로로작성한다. MyBrowseUIConfig/MyBrowseUI/PageHandler Mojo/ThreadPool nativeIPC/SessionTabHelper ID기반동일창tab목록과탐색/GN source_set(header/impl분리)/resources/mybrowse build_webui/TypeScript와CSS+HTML. sidebarWebView도새component파일로작성한다. explicitWindowContext는WebContentsUserData로owner설정, browserclosed때비우고 다른windowfallback금지. guest/incognito거부. renderer에는auth/socket/path전달금지. token/config는UIThread밖 ThreadPool에서 O_NOFOLLOW/fstat/owner0600과디렉터리700검사후읽음. --mybrowse-agent-dir 개발옵션, 기본home/Library/Application Support/MyBrowse/Agent. JSON은reference의현재base::JSONReader/Writer/Value API를확인해사용. native함수는blocking이라UIThread직접호출금지. request_op enum/64KiB payload/UUID/resID+version검사/고정오류명반환. 임의shell/evaluate명령불가.
홈은실제대화실행, Source/AskSearch는실제OpenTab HTTPS탭. 좌측sidebar surface는bookmarks/chats만, 하단실제세로tabs는existingViews사용. sidebar의session선택은현재창chrome://mybrowse/?session=validatedid로실제탭선택/생성. 홈페이지fake주소창/중복aside제거. frontend는plain text rendering, SelectionGuard동등한late-result거부, finite list/eventpages와disconnection retry는읽기요청만재전송. 변경요청응답불명확시자동재전송금지. browser capabilityfalse면현재UI에정확히표시. opencodex지원완료주장금지.
기존source변경은reference를수정하지말고browser/patches/native-webui.json에 {schema_version:1, chromium_commit:SHA, edits:[{path,anchor,replacement}]}로정확한1회anchor치환으로정리한다. 필요한GN deps/Config등록/Desktopbinder/GRITresource_ids/verticalregion child삽입과collapse숨김을포함한다. GRIT고정source includes5170..5199 빈범위를확인했으므로mybrowse reservation30개사용가능하다. 모든anchor는reference에서정확히1회만매칭돼야한다. 기존privateGoogleChrome설정/기존profile변경은포함하지않는다. branding과MCP는별도단계이므로이번patch에무관파일변경금지.

## Acceptance
실제sourceAPI를쓴완결된코드와검증가능한patch목록. compile/notrun을명확히보고한다. 실제Chromium/Store/GUI는미검증이다. 개발중원본build를간섭하지않는다. 과도한새framework나stubdemo를대신쓰지않는다. 이분기에모든UI완료를주장하지말고sidepanel동시웹/대화는후속gate로남김.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-01/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-01/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
