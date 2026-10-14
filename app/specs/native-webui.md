---
title: MyBrowse Chromium 내부 화면 통합
summary: 자체 Chromium의 홈페이지, 좌측 대화 목록과 실제 탭의 연결을 정합니다.
created: 2026-10-14
updated: 2026-10-14
note_type: spec
status: draft
language: ko
render_target: github
---
# MyBrowse Chromium 내부 화면 통합

이 명세는 작업 5와 작업 6의 네이티브 화면 구현을 정합니다.
원본 Chromium 컴파일 중에는 overlay 파일만 작성합니다.
원본 앱 실행과 Bitwarden 검사 뒤에 overlay를 적용합니다.

## 화면 구성

홈페이지는 `chrome://mybrowse/`입니다.
홈페이지는 Search/Ask 입력과 최근 작업을 표시합니다.
Ask는 실제 SessionService에 대화를 생성합니다.
Search는 같은 창의 실제 WebContents에서 검색 결과를 엽니다.

좌측에는 Chromium의 실제 세로 탭 목록을 사용합니다.
세로 탭 목록 위에 북마크와 대화 목록을 넣습니다.
해당 목록은 Views의 WebView가 표시하는 trusted WebUI입니다.
홈페이지 안에는 좌측 목록이나 가짜 주소창을 중복 표시하지 않습니다.
좌측 영역을 접으면 북마크와 대화 목록도 숨깁니다.
사용자가 펼치면 같은 창의 목록을 다시 표시합니다.

대화는 최초 구현에서 같은 창의 MyBrowse 탭으로 엽니다.
웹페이지 탭은 유지합니다.
대화 패널의 추가 표시는 이후 Views side panel 통합으로 구현합니다.
대화와 웹페이지를 동시에 표시하는 최종 수락 기준은 그대로 유지합니다.

## Mojo 인터페이스

MyBrowseUIConfig는 일반 프로필에서만 활성화합니다.
게스트 프로필과 시크릿 프로필은 초기 구현에서 거부합니다.
`chrome://mybrowse`에만 PageHandler를 바인딩합니다.
CSP는 외부 프레임, 외부 스크립트와 임의 네트워크 요청을 허용하지 않습니다.
Trusted Types 보호를 비활성화하지 않습니다.
UI는 출력 텍스트를 textContent로 표시합니다.

PageHandler의 Request는 아래 enum과 JSON 객체 본문을 받습니다.
`Health`, `List`, `Get`, `Create`, `Command`, `Events`만 허용합니다.
본문 상한은 64KiB이며 Node의 IPC 상한보다 작게 유지합니다.
브라우저 프로세스가 request id, token과 op 이름을 구성합니다.
renderer는 인증 값, 파일 경로와 소켓 경로를 전달하지 않습니다.
브라우저 프로세스는 응답 id와 version을 검사한 뒤 결과를 반환합니다.
성공과 실패는 기존 IPC 응답 구조를 유지합니다.
전송 오류는 일반 오류 이름만 UI에 제공합니다.

탭 기능은 별도 메서드로 제공합니다.
`GetTabs`, `OpenTab`, `ActivateTab`, `CloseTab`, `OpenSession`을 사용합니다.
탭 식별자는 SessionTabHelper가 제공하는 실제 tab ID입니다.
목록은 id, title, url, active를 포함합니다.
탭 조작은 호출 직전에 해당 창에서 ID를 다시 찾습니다.
잘못된 ID는 오류로 반환하며 인덱스로 대체하지 않습니다.
OpenTab은 정상적인 http/https URL만 받습니다.
주소창의 일반 Chromium 탐색 정책은 변경하지 않습니다.
OpenSession은 검증된 session ID로 내부 MyBrowse URL만 구성합니다.

## 창과 수명

일반 MyBrowse 탭은 TabInterface에서 현재 창을 확인합니다.
좌측 WebView는 탭이 아니므로 명시적인 WebContentsUserData로 창을 지정합니다.
다른 프로필이나 마지막 활성 창으로 대체하지 않습니다.
지정한 창이 닫히면 해당 연결 정보를 비웁니다.
시크릿 창이나 다른 프로필의 탭은 조작하지 않습니다.

브라우저 프로세스는 ThreadPool에서 파일과 소켓 IO를 처리합니다.
UI 스레드에서는 IO를 기다리지 않습니다.
WebUI가 사라지면 WeakPtr로 늦은 callback을 버립니다.
대화 실행은 데몬이 소유하므로 WebUI 종료와 함께 중단하지 않습니다.

## 연결 파일과 리소스

기본 Agent 폴더는 `~/Library/Application Support/MyBrowse/Agent/`입니다.
개발 실행에서는 `--mybrowse-agent-dir`로 명시한 폴더를 사용합니다.
브라우저 프로세스는 디렉터리 소유자와 0700 권한을 확인합니다.
connection.json과 token은 O_NOFOLLOW로 열고 fstat를 확인합니다.
파일은 현재 UID가 소유한 0600 일반 파일이어야 합니다.
connection.json은 64KiB 이하이고 token은 64자리 소문자 hex입니다.
파일 내용을 로그나 모델 입력에 넣지 않습니다.

리소스는 Chromium build_webui와 GRIT로 패키징합니다.
Vanilla TypeScript와 CSS를 사용하고 외부 CDN을 사용하지 않습니다.
기존 MyBrowse 프리뷰의 레이아웃과 선택 응답 검사를 옮깁니다.
pi-gui는 조건부 참고 자료이며, Pi OAuth 저장소를 CLI 인증으로 대체하지 않습니다.
새 GN 대상은 헤더와 구현을 나눠 Chromium의 의존 순환을 피합니다.
GRIT ID는 고정 소스에서 비어 있는 범위를 확인하고 예약합니다.

## 적용과 수락 기준

overlay에는 새 파일과 적용할 기존 파일의 정확한 변경 목록을 저장합니다.
적용기는 고정 HEAD와 각 파일의 원본 해시를 확인합니다.
사용자가 수정한 소스는 덮어쓰지 않습니다.
앱 브랜딩과 Browser 프로필 경로는 일반 Chrome과 분리합니다.

실제 arm64 앱에서 대화 왕복과 현재 창의 탭 생성·선택·닫기를 확인합니다.
다른 창의 탭을 실수로 닫지 않는지 검사합니다.
왼쪽 대화 목록과 실제 탭을 함께 표시하는지 확인합니다.
Bitwarden과 Codex 확장 게이트를 다시 검사합니다.
x64 앱은 실제 iMac에서 같은 화면과 동작을 확인합니다.

단독 C++ 소켓 검사와 Node 검사는 이 UI 수락 기준을 대신하지 않습니다.
전체 앱 빌드와 실행 전에는 네이티브 UI를 완료로 표시하지 않습니다.
