[cli-relay · task · turn 03]

## Objective
기존C++초안의GN잘못된label을고치고정확한Chromium등록/좌측뷰삽입patch JSON을작성한다.

## Scope
수정가능browser/patches/native-webui.json, browser/overlay/chrome/browser/ui/webui/mybrowse/BUILD.gn, browser/overlay/chrome/browser/ui/views/mybrowse/BUILD.gn, browser/overlay/chrome/browser/ui/webui/mybrowse/mybrowse_constants.h. 그외C++/TS/ref읽기만한다. 다른CLI/에이전트/실제빌드/설치금지.

## Context
최신reference에chrome/browser/ui/BUILD.gn, ui/browser_window/BUILD.gn, components/sessions/BUILD.gn, components/tabs/BUILD.gn, ui/views/controls/webview/BUILD.gn을추가했다. 정확한BWI target은 //chrome/browser/ui/browser_window 이며 /public:browser_window_interface target은없다. views/mybrowse:impl의deps에webui/mybrowse:impl을넣으면browser_public_dependencies->ui와cycle이생길수있으므로headers에만의존하고rootchrome/browser가두impl을link하게한다. iframe나외부Chrome대체는금지. UI리소스6개는이미존재하며표시surface는/?surface=sidebar이다. 상수kChromeUIMyBrowseSidebarURL을이주소로맞춘다. resources generatedexport이름은실제빌드에서root확인한다.

## Deliverable
schema_version1, chromium_commit cfaadc5a132d78e1828635aa8405a499f3e14864, edits [{path,anchor,replacement}]. edits는 reference의파일본문에서각anchor정확히1회매칭되어야한다. 기존참조파일은수정하지말고선택exactanchorstring로쓰기. Config include+RegisterChromeWebUIConfigs MyBrowseUIConfig등록, desktopInterfaceBinder includes+PageHandlerFactory typedbinder, rootBrowser/WebUI/View parentGN header+impldeps(Mac조건), Resources aggregator deps(Mac조건), tools/gritsettings/resource_ids.spec includes5170 예약30, vertical_tab_strip_region_view.h/cc include/member/MaybeCreateChild/initialcollapsedhide+statechangehide 적용목록. 모든Mac외플랫폼참조는is_mac/BUILDFLAG(IS_MAC)로둘러존재하지않는label참조안되게한다. NativeSidebar는높이280여백정해져있으며primaryactualTabs기존Views쓰게한다. collapsestatehandler는실제source에서state변수를확인하여 SetVisible(!collapsed) 적용한다. 원본refs32개와새GN5개에서정확한함수/targetscope를확인한다. 기존privateChrome프로필변경/branding/MCP/새framework/추가TS수정은하지않는다. 별도root가ShadowGN와실제compile을검증한다.

## Acceptance
script로각anchor가ref에서1회매칭됨을확인하고report작성. 추가Gitcommit/다운로드/실제Chromiumsource변경없음. GN labels 실재source기준, 미검증은명확히표시. 작업을작게마무리한다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-03/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-03/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
