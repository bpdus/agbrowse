# turn-02 보고

## 한 일
- `resources/mybrowse/` 6개 파일만 작성했다. 단일 `mybrowse.html`이 query로 화면을 고른다.
  - `?surface=sidebar`: 북마크(OpenTab)와 대화 목록(OpenSession), 새 대화(OpenHome), 새 탭(OpenTab).
  - 기본(home): Search/Ask 전환 버튼 두 개, Enter=제출(Shift+Enter 줄바꿈), 최근 작업 카드. 중복 aside/주소창/탭 목록 없음.
  - `?session=<uuid>`: 대화 화면. UUID 정규식 검사 후 선택.
- `bridge.ts`: `AgentOp` enum + JSON으로 `PageHandler.request` 호출. 읽기(health/list/get/events)만 최대 2회 짧게 재시도하고 create/command는 재전송하지 않는다. timeout이면 `outcomeUnknown`으로 표시한다. proxy 오류는 한국어 문구로 표시한다. token/socket 경로는 다루지 않는다.
- `selection.ts`: `SelectionGuard`와 `activeSessionSelectionGuard`. 늦은 get/events/command 응답을 버린다.
- `app.ts`: list는 요약 finite page(최대 5쪽), 이벤트는 `after_seq` 커서와 seq 보존, 한 번 폴링당 최대 20쪽. 출력은 textContent만 사용한다. 브라우저 capability가 true가 아니면 "도구 미연결" 표시. opencodex 옵션은 항상 disabled.
- `style.css`: 기존 `ui/style.css`를 옮기고 고정 사이드바/main 오프셋을 제거했다.

## 확인
- mojom, 요청 검증 규칙, ui.cc를 읽고 이름·필드를 맞췄다.
- innerHTML/eval/iframe/CDN을 grep으로 확인했고 사용이 없다.

## 미검증과 위험
- tsc 타입 검사는 명령 검사기에 막혀 실행하지 못했다. Chromium 컴파일과 GUI도 미검증이다.
- `kChromeUIMyBrowseSidebarURL`은 `sidebar.html`이지만 이번 범위는 `mybrowse.html` 하나다. 상수를 `chrome://mybrowse/?surface=sidebar`로 바꾸거나 `sidebar.html`을 추가해야 한다.
- `health.capabilities.browser` 키와 생성 TS의 `getRemote`/camelCase 필드명은 가정이다. 빌드 시 확인이 필요하다.
- `mybrowse.html`의 `app.js`는 build_webui가 `app.ts`에서 만드는 출력 이름을 전제로 한다.
- 검색 엔진은 Google 고정이다. 필요하면 바꾼다.
