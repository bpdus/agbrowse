# turn-05 보고

## 한 일
- `style.css`: 프리뷰 CSS에 override를 덧붙인 구조를 없애고, 현재 HTML과 app.ts가 쓰는 클래스만 한 번씩 정의하도록 처음부터 다시 썼다. body, .sidebar, .home-view는 규칙이 각각 1개다. 미사용 .window-controls, .toolbar, .address, 설정 화면 CSS는 제거했고, 가짜 주소창이나 컨트롤은 추가하지 않았다.
- `native-webui.json`: `OnTabStripViewChanged` 안의 `ReorderChildView(tab_strip_view(), separator_index.value() + 1)`를 대체하는 edit를 추가했다. Mac에서 `mybrowse_sidebar_`가 있으면 `GetIndexOf(mybrowse_sidebar_) + 1` 위치에 두고, 없으면 기존 행동을 유지한다. 다른 플랫폼 코드는 그대로다. 결과적으로 북마크/대화 다음에 실제 탭이 나온다.

## 확인
- 전체 16개 anchor가 reference에서 정확히 1회 일치했다.
- CSS 중복 selector는 grep으로 확인했다.

## 위험
- stylelint는 실행하지 않았다. 속성 순서, 색상 표기, 따옴표 규칙은 root의 재검사로 확인해야 한다.
- 사이드바가 탭 목록보다 먼저 자식에 추가되므로 `GetIndexOf(sidebar)`가 탭 목록 이동 전에도 유효하다. 실제 배치는 실행으로 확인해야 한다.
