---
note_type: board
title: bpbrowser Project Board
status: active
summary: Branch-First Feature Queue and project state for this project.
source_date: 2026-10-14
project: bpbrowser
workspace_type: mixed   # documents / code / mixed
domain:
  - browser
  - autonomous-agent
active_ticket: none
author: HIPRA Team
---

# bpbrowser Project Board

> This file is the main-branch Feature Queue for the project.
> Code, tests, feature documents, active handoffs, and ticket bodies are changed only in branch worktrees.
> Use `/project-branch create-from-ticket --ticket <TICKET-ID>` to create the branch and worktree for ticket implementation.

## Active Focus

| Item | Details |
| --- | --- |
| Active Ticket | 없음. 다음 구현 티켓은 FEAT-01입니다. |
| Project Intent | Chromium 기반 Mac 브라우저에 좌측 탭과 자율 에이전트 대화를 통합한다. 두 Mac과 Pi 공유 설정을 지원한다. |
| Current Goal | Chromium 기반 Mac 브라우저에 좌측 탭과 자율 에이전트 대화를 통합한다. 두 Mac과 Pi 공유 설정을 지원한다. |
| Last Done | CHORE-01: 프로젝트 이전과 보드 등록 및 저장소 이름 변경을 검증했습니다. |
| Next Action | FEAT-01 작업환경에서 Chromium 제품 화면 통합을 이어갑니다. |

### Exit Check
- [ ] The Feature Queue reflects ticket status using `backlog`, `in-progress`, `pr-open`, or `done`
- [ ] Branch and Worktree columns are updated only after `/project-branch create-from-ticket`
- [ ] Main remains clean except for queue, registry, and post-merge records

---

## Branch-First Status Vocabulary

| Status | Meaning |
| --- | --- |
| `backlog` | Ticket is registered and waiting for a worktree |
| `in-progress` | Worktree and branch exist; implementation is underway |
| `pr-open` | Pull request is open and waiting for review or merge |
| `done` | Pull request has merged and post-merge records are complete |

---

## Board Scope

| Level | What Belongs Here |
| --- | --- |
| Project board | Feature Queue ticket rows, Branch/Worktree links after project-branch, project-level next checkpoint |
| Workspace board | Project, type, status, phase, next checkpoint only |
| Ticket body | Ticket-specific implementation notes in `tickets/<ID>.md` from the ticket worktree |
| Active handoff | Branch/worktree-local continuation notes under `handoffs/active/` |

---

## Workspace Folder Structure

> Generated workspace type: **mixed**

### Documents (`documents`)

```text
documents/
  drafts/        <- Working documents
  published/     <- Finalized and reviewed documents
  archive/       <- Archive of completed documents
```

### Code (`code`)

```text
src/             <- Source code
tests/           <- Test code
docs/            <- Code documentation (README, API docs, etc.)
scripts/         <- Build/deployment scripts
```

### Mixed (`mixed`)

```text
documents/       <- Documents (drafts/, published/, archive/)
src/             <- Source code
tests/           <- Tests
docs/            <- Code documentation
```

### Shared Directories (All Types)

```text
resource/        <- Specs, plans, policies, and reference materials
handoffs/        <- Handoffs (active/ , archive/)
  active/
  archive/
```

---

## Phase Overview

| Phase | Scope | Status | Done So Far | Next Step | Source Spec |
| --- | --- | --- | --- | --- | --- |
| Setup | Project scaffolding | backlog | - | Define the first backlog items | `resource/plans/setup.md` |

---

## Feature Queue

| ID | Type | Title | Status | Branch | Worktree | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| CHORE-01 | chore | 기존 브라우저 작업 이전 및 저장소 이름 변경 | done | main | - | 실제 이전과 보드 및 저장소 이름 변경을 검증했다. 커밋과 푸시는 하지 않았다. |
| FEAT-01 | feat | Chromium 좌측 탭과 대화 화면 통합 | backlog | - | - | 기반 arm64 Chromium 실행 검사는 완료했다. overlay 적용과 제품 검증이 남았다. |
| FEAT-02 | feat | Pi 공유 런타임 및 브라우저 MCP 연결 | backlog | - | - | Pi 실행기와 로컬 시험 제공자 왕복은 검증했다. 실제 제공자와 앱 등록 및 MCP 연결이 남았다. |
| FEAT-03 | feat | 두 Mac 지원과 Bitwarden 및 배포 검증 | backlog | - | - | x64 전체 앱, 스토어, Muse 왕복과 서명 및 공증을 검증한다. |
| CHORE-02 | test | IPC 검사에서 현재 폴더 길이 가정 제거 | backlog | - | - | 새 경로의 검사 하나가 긴 경로를 가정한다. 이전 경로는 삭제했다. 새 경로 검사 122개가 통과했다. 긴 경로를 가정하는 이 검사만 개선이 남았다. |
| CHORE-03 | chore | supplied-browser-icon | in-progress | chore/CHORE-03-supplied-browser-icon | /Users/jjbyun/SynologyDrive/worktree/bpbrowser--chore-CHORE-03-supplied-browser-icon | 현재 앱과 Chromium 원본의 아이콘을 교체했다. macOS 아이콘 표시와 백업을 검증했다. 작업 브랜치에 보존했으며 PR 병합은 하지 않았다. |

> Add tickets with `/bpdus-ticket add --type <type> "제목"` or `/bpdus-ticket report "버그 요약"`.
> Create implementation environments with `/project-branch create-from-ticket --ticket <TICKET-ID>`.
> Do not turn this file into a session diary; branch handoffs own detailed continuation notes.

---

## Recently Done

| Date | Ticket ID | What |
| --- | --- | --- |
| 2026-10-14 | SETUP-00 | Initialized project structure |

---

## Next Up

1. 사용자가 프로젝트 이전과 보드 등록 및 저장소 이름 변경을 요청했다.

---

## Blockers / Open Decisions

- (none)

## Reference Links

- Mapping file: `resource/references/links.md`


## Browser Migration Checkpoint

- 앱 구현은 `app/`에 있습니다. Chromium 소스와 빌드는 `work/`에 있습니다.
- 기존 Git 이력과 실제 파일을 보존했습니다.
- 기반 Chromium만 실행 검사를 통과했습니다. 제품 화면과 AI 기능 통합은 남았습니다.
- 다음 구현은 FEAT-01입니다. 세부 상태는 `app/implementation.json`에 있습니다.

2026-10-14 경로 정리: 이전 폴더와 연결 경로 6개를 삭제했습니다. 새 위치의 앱 실행과 빌드 상태를 확인했습니다.
