---
note_type: rules
title: "bpbrowser Project Rules"
status: active
summary: Project-local rules, exceptions, and local runbooks for generated projects.
source_date: 2026-10-14
domain:
  - browser
  - autonomous-agent
author: HIPRA Team
---

# bpbrowser Project Rules

This file is for project-local rules, exceptions, and local runbooks only. global AGENTS.md owns shared operating principles. global RULES.md owns detailed branch, worktree, ticket, and closeout procedure.

> Writing standards: see `resource/references/writing-standards.md` if it exists in this project.

---

## 1. Local Document Conventions

- Treat newly generated or intentionally overwritten `AGENTS.md` and `CLAUDE.md` as one byte-identical project-local guide: `AGENTS.md` is the canonical project-local policy boundary and `CLAUDE.md` is its Claude mirror.
- If `overwriteClaude: false` preserves pre-existing `AGENTS.md` or `CLAUDE.md`, the files may intentionally diverge; reconcile preserved content deliberately before relying on byte identity.
- Treat `START-HERE.md` as a navigation signpost, not a policy source.
- Keep project-specific resource documents in `resource/` unless a project-local runbook below says otherwise.
- Follow `resource/references/writing-standards.md` if this project includes it.
- Use links instead of duplicating prose guidance that already lives in project or global references.
- When a project-local document is no longer active, change it to `status: archived` instead of deleting it.

---

## 2. Local Folder Conventions

```
/Users/jjbyun/SynologyDrive/bpbrowser/
  AGENTS.md                  <- Canonical project-local operating policy boundary
  CLAUDE.md                  <- Claude mirror when generated/overwritten; may be preserved as-is with overwriteClaude:false
  START-HERE.md              <- Navigation signpost
  RULES.md                   <- This file: project-local rules and exceptions
  WORKFLOW.md                <- Project-specific workflow notes, if any
  agent_board.md             <- Project ticket queue
  change_log.md              <- Project change history
  today.md                   <- Project daily log
  handoffs/
    active/                  <- Active project handoffs
    archive/                 <- Archived project handoffs
  resource/                  <- Project resource documents
```

- Keep only operating files in the project root.
- Store project references, specs, and plans under `resource/`.
- Do not use workspace documents as inherited parent policy for this project.

---

## 3. Local Handoff Conventions

Use handoffs only when they help preserve project-specific context between operators. This is a local convention for document shape, not the global closeout procedure.

### Filename Convention

Use a project-approved, human-readable name that clearly identifies the work item.

### Suggested Sections

- Session Goal
- Accomplished In This Session
- Current State
- Next Single Step
- Files To Open First
- Decisions Already Locked
- Open Questions / Risks
- Verification
- Close Condition

---

## 4. Local Change History Conventions

- Keep `change_log.md` append-only.
- Record meaningful project changes that future operators need to understand.
- Do not record typo-only fixes unless this project explicitly requires audit-level traceability.

---

## 5. Local Verification Conventions

- Do not claim project work is complete until relevant verification has been run.
- If verification cannot be run, record the exact blocker and the manual check needed.
- For spec-driven work, keep the verification evidence close to the affected project handoff or change record.

## Branch Workflow: Shared Document Isolation

- 공통 문서는 `agent_board.md`, `change_log.md`, `today.md`와 `handoffs/`의 운영 기록입니다.
- 기능과 수정 브랜치에서는 공통 문서를 수정하지 않습니다. PR에는 코드, 검사, 스펙과 티켓 문서만 포함합니다.
- PR 병합 후 main에서 보드와 기록을 갱신합니다. 커밋과 푸시는 사용자 승인 범위에 따릅니다.
- 프로젝트 이전과 초기 보드 등록은 운영 작업입니다. 실제 이전 검증 후 완료로 표시할 수 있습니다.

## Existing Browser Migration

- 기존 저장소 이력과 루트 파일은 보존합니다. 새 브라우저 구현은 `app/`에 있습니다.
- Chromium 소스, 빌드 결과와 도구는 `work/`에 있습니다. `work/`를 Git에 올리지 않습니다.
- 기존 `mybrowse` CLI 이름은 호환성을 위해 유지합니다. 프로젝트와 저장소 이름은 `bpbrowser`입니다.
- 프로젝트는 `/Users/jjbyun/SynologyDrive/bpbrowser`만 사용합니다. 이전 위치의 연결 경로를 만들지 않습니다.
- 현재 브라우저 실행 검사는 기반 Chromium만 검증했습니다. AI 기능과 제품 화면 통합은 별도 검증합니다.
