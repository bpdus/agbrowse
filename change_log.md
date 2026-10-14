---
note_type: changelog
title: bpbrowser Change Log
status: active
summary: Append-only post-merge change history.
source_date: 2026-10-14
domain:
  - browser
  - autonomous-agent
related_notes:
  - /Users/jjbyun/SynologyDrive/bpbrowser/agent_board.md
author: HIPRA Team
---

# bpbrowser Change Log

## Rules

- Append only. Do not edit existing rows.
- Record one line per meaningful post-merge work package.
- Use the Feature Queue ticket ID.
- Put a person or agent name in `By`.

---

## Entries

### 2026-10

| Date | By | Ticket ID | Change Type | What Changed | Files / Folders | Related Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-14 | jjbyun | SETUP-00 | creation | Set up the Branch-First project work structure | AGENTS.md, CLAUDE.md, RULES.md, agent_board.md, change_log.md, handoffs/ | n/a |
| 2026-10-14 | jjbyun | CHORE-01 | setup | Added reference links | /Users/jjbyun/SynologyDrive/bpbrowser/ | — |


2026-10-14 CHORE-01: 기존 저장소와 앱 및 Chromium 작업을 bpbrowser로 이전했다. 프로젝트와 작업 공간 보드에 등록했다. 저장소 이름을 bpdus/bpbrowser로 변경했다. 기존 경로 연결을 보존했고 검사 123개와 새 위치의 Chromium 실행을 확인했다. IPC 검사 경로 가정은 CHORE-02로 기록했다. 커밋과 푸시는 하지 않았다.

2026-10-14: 사용자 요청으로 이전 폴더와 연결 경로 6개를 삭제했다. 새 위치만 사용하도록 스펙과 빌드 상태를 정리했다. 이전 경로 없이 Chromium 실행과 검사 122개를 확인했다. 기존 검사 하나의 경로 가정은 CHORE-02에 남았다.

2026-10-14 CHORE-03: 사용자 이미지로 현재 arm64 Chromium 앱과 소스의 app.icns 및 Assets.car를 교체했다. 원본 PNG, 생성 파일, 백업 해시와 macOS의 실제 아이콘 출력을 확인했다. 패키징 도구와 계획은 chore/CHORE-03-supplied-browser-icon 작업환경에 보존했다. Chromium 전체 빌드, 커밋과 푸시는 하지 않았다.
