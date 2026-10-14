[cli-relay · task · turn 05]

## Objective
실제 Chromium stylelint 오류와 좌측 화면 순서를 수정한다.

## Scope
browser/overlay/chrome/browser/resources/mybrowse/style.css와 browser/patches/native-webui.json만 수정한다. 나머지는 읽기만 한다. 다른 CLI, 설치, 실제 Chromium 소스 수정은 금지한다.

## Context
root가 Chromium stylelint --fix를 실행했으며, 현재 CSS에는 body, .sidebar, .home-view duplicate selector 세 오류가 남았다. 기존 프리뷰 CSS 뒤에 native override를 덧붙여 생긴 문제다. body와 sidebar의 최종 선언을 앞쪽 규칙으로 합치고 뒤 중복 규칙을 제거한다. .home-view max-width는 앞 규칙에 있으므로 뒤 중복을 제거한다. 사용되지 않는 프리뷰 .window-controls/.toolbar/frame CSS는 정리해도 된다. 가짜 주소창이나 컨트롤을 추가하지 않는다. 읽기 쉬운 CSS로 정리한다.

기존 Chromium vertical_tab_strip_region_view.cc의 OnTabStripViewChanged()는 ReorderChildView(tab_strip_view(), separator_index.value() + 1)로 실제 탭을 separator 바로 뒤로 옮긴다. 현재 patch는 separator 다음에 MyBrowse sidebar를 생성하므로, 실제 탭이 그 위로 올라간다. 북마크/대화 다음에 실제 탭이 나오는 명세에 맞게 이 ReorderChildView를 Mac에서 sidebar 뒤로 옮기는 exact anchor edit를 추가한다. sidebar가 없으면 기존 행동을 유지한다. GetIndexOf(sidebar) API는 기존 separator API와 같다. 다른 플랫폼은 기존 코드 그대로 유지한다.

## Acceptance
변경 두 파일과 report/result를 작성한다. stylelint/실제 빌드는 root가 재검사한다. 새 anchor는 reference에서 정확히 1회 일치해야 한다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-05/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-091943-claude-mybrowse-webui/work/_relay/turn-05/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
