---
note_type: guide
content_mode: how_to
title: bpdus agbrowse 전용 에이전트 워커
status: draft
summary: 전용 Chrome 프로필과 디버깅 파이프를 쓰는 포그라운드 워커의 조회·cart 경계, 종료, 한계와 되돌리기를 적는다.
created: 2026-10-11
updated: 2026-10-12
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./README.md
  - ./BASELINE.md
  - ./PROTOCOL.md
---

# bpdus agbrowse 전용 에이전트 워커

이 문서는 로컬에서 직접 켜는 포그라운드 워커의 실행 방법과 안전 경계를 적는다. 워커는 설치된 Google Chrome 하나를 전용 프로필로 띄운다. 읽기 전용 브라우저 MCP와 네이버 cart 도구 네 개를 제공하지만, 실제 Naver cart layout과 mutation endpoint가 검증되지 않아 live cart 작업은 `SITE_UNSUPPORTED`로 닫힌다. 승인과 결제 기능은 없다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

## 호출

저장소 루트에서 다음 명령으로만 켠다.

```bash
node skills/browser/agent-worker.mjs
```

인자는 `--help`만 받는다. 프로필, 엔드포인트, 포트, 추가 Chrome 플래그는 거부하며 그 경우에는 Chrome을 띄우지 않는다. `BROWSER_AGENT_HOME`, `CDP_PORT`, `AGBROWSE_CHROME_FLAGS`는 읽지 않는다.

## 고정 프로필

사용자 데이터 디렉터리는 `~/.agbrowse-bpdus/agent-profile`로 고정한다. 잠금은 그 상위인 `~/.agbrowse-bpdus`에 둔다. 기존 `~/.browser-agent/browser-profile`과는 디렉터리를 공유하지 않는다. 경로가 심볼릭 링크이거나 쓸 수 없으면 시작을 거부하고 다른 프로필로 바꾸지 않는다.

## 수동 로그인

Chrome 창이 열리면 사용자가 그 창에서 직접 로그인한다. 장바구니 도구는 로그인 화면을 감지하면 `LOGIN_REQUIRED`를 반환한다. 자격 증명을 읽거나 입력하지 않고, 로그인 주소를 따라가거나 재시도하지 않는다. CAPTCHA나 차단 화면에서는 `HUMAN_REQUIRED`를 반환한다. 로그인 상태는 전용 프로필에 남고, 일상 Chrome 프로필로 복사하지 않는다.

Naver 로그인이 필요하면 [LaunchAgents 운영 안내](./LAUNCHAGENTS.md)의 `bin/bpdus/login-naver.sh --stop-worker` 절차를 따른다. 이 스크립트는 worker LaunchAgent를 잠시 unload하고 macOS Launch Services로 Chrome을 연다. Chrome 프로세스가 종료되고 프로필 잠금이 사라진 뒤에만 이전에 로드된 worker를 복구한다. LaunchAgent가 처음부터 unload 상태였다면 그 상태를 유지하고 복구 명령을 안내한다. SSH에서도 GUI 로그인 세션이 활성화되어 있어야 한다.

이 프로필에서는 Naver만 방문한다. Google에 로그인하거나 Chrome Sync를 켜지 않는다. 전용 프로필만으로 URL 차단 정책을 보장할 수는 없다. `URLBlocklist`와 `URLAllowlist`는 관리형 설정이 필요하므로 이 변경에서는 Chrome 관리 정책을 바꾸지 않는다. [Chrome 정책 문서](https://support.google.com/chrome/a/answer/7532419?hl=en)를 참고한다.

로그인 스크립트는 `~/.agbrowse-bpdus/profile.lock`, `profile.lock.reclaiming`, 프로필의 `SingletonLock`, `SingletonSocket`, `SingletonCookie`가 있으면 실행을 거부한다. 잠금을 자동으로 지우지 않는다. Chrome의 마지막 창만 닫아도 프로세스가 남을 수 있다. 로그인 스크립트가 Chrome 프로세스 종료와 프로필 lock 해제를 기다리므로, 실행이 끝나기 전에 LaunchAgent를 직접 다시 시작하지 않는다.

## 파이프 전송

Chrome과는 디버깅 파이프로만 통신한다. 원격 디버깅 TCP 포트를 열지 않으므로 다른 기기에서 CDP로 접속할 수 없다. owner-only Unix socket은 고정된 read 도구와 cart 도구 네 개만 받는다. 임의 브라우저 평가나 요청 인자는 허용하지 않는다. 기존 CLI의 포트 접속 경로는 바꾸지 않는다.

## Cart 상태와 지원 범위

준비 intent와 idempotency 기록은 `~/.agbrowse-bpdus/cart-state`에 둔다. 디렉터리는 `0700`, 상태 파일과 잠금 파일은 `0600`을 요구한다. 쓰기는 잠금, 임시 파일, flush, 원자적 rename 순서로 저장한다. 안전하지 않은 경로나 쓰기 실패가 있으면 요청을 실패로 닫는다.

작업을 보내기 전에 `DISPATCHING` 상태를 저장한다. 워커가 재시작했을 때 이 상태가 남아 있으면 `OUTCOME_UNKNOWN`으로 바꾸고 같은 account의 새 쓰기를 막는다. 결과가 불분명한 작업은 자동 재전송하지 않는다. 조회와 dry-run은 현재 DOM만 읽으며 페이지 이동, 옵션 선택, 입력, 클릭, 제출을 하지 않는다. 이 checkout에는 검증된 production cart layout이나 endpoint가 없으므로 어떤 live cart write도 실행되지 않는다.

## 종료와 재시작

`SIGINT` 또는 `SIGTERM`을 받으면 새 작업을 받지 않고 Chrome을 닫은 다음 프로필 잠금을 푼다. 같은 신호를 여러 번 보내도 정리는 한 번만 한다. 프로세스를 다시 실행하면 새 세션 ID를 만들며 이전 브라우저 세션을 재개하지 않는다. 저장된 cart intent는 binding과 만료 시각을 다시 검사한다. 브라우저 연결이 끊기면 워커는 종료되고, 자동으로 다시 띄우지 않는다.

## 한계

워커는 HTTP 서버, 표준입력 명령, Node IPC, MCP 게이트웨이 등록, 페어링, 승인 저장소를 만들지 않는다. macOS 배포에서는 별도의 LaunchAgent가 프로세스 생명주기를 관리한다. owner-only Unix socket과 cart intent/idempotency 저장소만 사용한다. 세션 목록은 프로세스 메모리에만 있고, 탭을 자동으로 등록하지 않는다.

## 되돌리기

`cart:write`를 회수하려면 기기를 폐기한 뒤 `browser:read`만 승인해 다시 페어링한다. 코드 변경을 되돌릴 때에는 워커를 멈춘 뒤 이 PR을 revert한다. `~/.agbrowse-bpdus` 프로필과 cart 상태는 별도 요청이 있기 전까지 남긴다. 일상 Chrome과 그 프로필은 멈추거나 삭제하지 않는다.
