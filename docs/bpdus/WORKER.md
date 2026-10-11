---
note_type: guide
content_mode: how_to
title: bpdus agbrowse 전용 에이전트 워커
status: draft
summary: 전용 Chrome 프로필과 디버깅 파이프를 쓰는 포그라운드 워커의 실행, 종료, 한계, 되돌리기를 적는다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./README.md
  - ./BASELINE.md
  - ./PROTOCOL.md
---

# bpdus agbrowse 전용 에이전트 워커

이 문서는 로컬에서 직접 켜는 포그라운드 워커의 실행 방법을 적는다. 워커는 설치된 Google Chrome 하나를 전용 프로필로 띄우는 실행 기반이다. 조회, 장바구니, 승인, MCP 게이트웨이는 아직 없다.

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

Chrome 창이 열리면 사용자가 그 창에서 직접 로그인한다. 이 워커는 페이지 이동, 클릭, 입력, 업로드를 하지 않는다. 로그인 상태는 전용 프로필에 남고, 일상 Chrome 프로필로 복사하지 않는다.

## 파이프 전송

Chrome과는 디버깅 파이프로만 통신한다. 원격 디버깅 TCP 포트를 열지 않으므로 다른 기기에서 CDP로 접속할 수 없다. 기존 CLI의 포트 접속 경로는 바꾸지 않는다.

## 종료와 재시작

`SIGINT` 또는 `SIGTERM`을 받으면 새 작업을 받지 않고 Chrome을 닫은 다음 프로필 잠금을 푼다. 같은 신호를 여러 번 보내도 정리는 한 번만 한다. 프로세스를 다시 실행하면 새 세션 ID를 만들며 이전 세션 작업을 재개하지 않는다. 브라우저 연결이 끊기면 워커는 종료되고, 자동으로 다시 띄우지 않는다.

## 한계

워커는 포그라운드 프로세스다. 소켓, HTTP 서버, 표준입력 명령, Node IPC, MCP 등록, 페어링, 승인 저장소, LaunchAgent를 만들지 않는다. 세션 목록은 프로세스 메모리에만 있고, 탭을 자동으로 등록하지 않는다.

## 되돌리기

워커를 멈춘 뒤 PR 1 변경을 revert한다. `~/.agbrowse-bpdus` 프로필은 따로 지우라고 하기 전까지 남긴다. 일상 Chrome과 그 프로필은 멈추거나 삭제하지 않는다.
