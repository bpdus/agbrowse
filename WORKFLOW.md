# Mixed Workflow

This `WORKFLOW.md` is the operator guide for a generated mixed project.

Ownership split:

- `AGENTS.md` owns the canonical Branch-First operating contract
- `CLAUDE.md` mirrors `AGENTS.md` for Claude execution
- `RULES.md` owns project-local execution rules
- `WORKFLOW.md` owns the working procedure
- document-writing policy should not be duplicated here

## 1. Session Start

1. Enter this project from the workspace root after reading the workspace `START-HERE.md` when a workspace exists.
2. Read this project's `START-HERE.md`.
3. Read `AGENTS.md`, `CLAUDE.md`, `agent_board.md`, this file, and `RULES.md`.
4. Confirm the target ticket is in the Feature Queue.
5. For code, tests, or feature-document changes, create or enter the branch worktree with `/project-branch create-from-ticket --ticket <TICKET-ID>` before editing.

## 2. Working Loop

1. Confirm the active ticket and the smallest useful write scope.
2. Create or enter the branch worktree with `/project-branch create-from-ticket --ticket <TICKET-ID>` before editing.
3. For document work, use `documents/`; for code work, use `src/`, `tests/`, and `docs/`; run the relevant verification for the current slice.
4. When a document describes implementation, link the relevant files instead of restating them.
5. Invoke `/project-closeout`; it owns scoped commit and branch push, PR creation, the internal review PASS gate, merge, the post-merge bookkeeping commit and final main push, optional local installation, and cleanup.

## 3. Workspace Structure

```text
/Users/jjbyun/SynologyDrive/bpbrowser/
  START-HERE.md
  AGENTS.md
  CLAUDE.md
  WORKFLOW.md
  RULES.md
  agent_board.md
  change_log.md
  today.md
  handoffs/
    active/
    archive/
  documents/
    drafts/
    published/
    archive/
  src/
  tests/
  docs/
  scripts/
  resource/
```

Worktree directories and branch metadata are created by `/project-branch create-from-ticket`, not by project-create.

## 4. Verification

- Record document status when document outputs change.
- Record build and test status when code changes.
- Record document-to-code links when both change in the same slice.

## 5. Session End

1. Update the branch-local active handoff.
2. If the branch is not ready for merge, leave the next mixed-work step and verification state clearly.
3. If the branch is ready, invoke `/project-closeout`; use the same skill with `--post-merge` only when resuming an already merged workflow.


## Browser Commands

```sh
cd /Users/jjbyun/SynologyDrive/bpbrowser/app
npm test
node browser/build.mjs status --work-root /Users/jjbyun/SynologyDrive/bpbrowser/work --json
```

Chromium 작업 폴더를 지정하려면 `--work-root`를 사용합니다. 기반 앱을 다시 빌드해도 MyBrowse overlay가 자동으로 적용되지는 않습니다.
