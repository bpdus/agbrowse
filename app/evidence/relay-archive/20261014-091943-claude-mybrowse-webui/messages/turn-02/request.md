[cli-relay · task · turn 02]

## Objective
이전호출의C++초안을읽고누락된ChromiumWebUI화면리소스만작성한다.

## Scope
수정가능: browser/overlay/chrome/browser/resources/mybrowse/BUILD.gn, mybrowse.html, style.css, app.ts, bridge.ts, selection.ts. 나머지 C++/reference/specs/ui/native파일읽기만한다. 다른CLI/에이전트/실제빌드/설치금지.

## Context
이전호출은600초TIMEOUT이지만실제C++파일25개가존재한다. 최종보고가없어완료로인정하지않는다. browser/overlay/chrome/browser/ui/webui/mybrowse/mybrowse.mojom과page_handler를읽고현재인터페이스에맞춰frontend작성한다. 기존ui의vanilla레이아웃은전용홈/좌측surface에맞게옮긴다. specs/native-webui.md와specs/webui-ipc.md가계약이다. root가후속등록패치와C++코드검토/실제컴파일을한다.

## Deliverable
build_webui TypeScript/HTML/CSS를완성한다. generatedmybrowse.mojom-webui.js에서PageHandlerFactory또는현재mojom의실제getRemote를확인하여사용한다. surface=sidebar는bookmarks/chats, surface=home는중복aside/주소창없이Search/Ask/최근작업, querysession은대화뷰선택. 생성/명령/읽기/이벤트는MojoRequest enum+JSON사용하고proxyerror는명확히표시한다. provider데이터/token/socketpath는renderer노출안함. session목록은 IPCsummary finitepages, 원문get별도. 이벤트는finitepages/seq를보존, activeSessionSelectionGuard가late응답버림. 변경명령은timeout시재전송금지. Read요청만짧은retry가능. 외부 URL은OpenTabtypedNativeAPI, 북마크+새탭은실제앱Tab. session선택sidebar는OpenSession nativeAPI. 실제nativeTabs를홈에복제목록으로붙이지않음. 도구미연결browsercapfalse정확히표시, opencodex프로필설정전disabled. Enter Ask, Search전환모드버튼둘다제공. textContent만모델출력사용, iframe/innerHTML/eval/CSPdisable없음. 외부CDN없음. TS 타입선언으로 SessionSummary/Event/Session/Response를명확히하고DOMnullable처리한다.

## Acceptance
지정6개리소스만변경, 현재mojom심볼과맞는import. 문법과파일참조확인. 실제Chromium컴파일/GUI는미검증으로보고. 파일과최종보고를240초내완성하고과도한새리소스나framework추가금지.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-02/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-02/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
