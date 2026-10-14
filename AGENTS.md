<project_operating_guide>

# Project AI Operating Guide

<scope>
This file defines the project-local operating boundary for bpbrowser.

`AGENTS.md` is the canonical project-local operating policy. `CLAUDE.md` is the Claude execution mirror, not a second policy source.

Project policy ownership:
1. Direct user or task instructions win.
2. `AGENTS.md` owns only project-specific rules, exceptions, and local runbooks.
3. global AGENTS.md owns shared operating principles.
4. global RULES.md owns detailed branch, worktree, ticket, and closeout procedure.
5. `CLAUDE.md` mirrors `AGENTS.md` for Claude execution.

Workspace operating documents are not inherited parent policy for project sessions. Use workspace documents for workspace discovery and portfolio context, not for project execution rules.
</scope>

## Project-local Policy Boundary

Keep this project's operating documents local and brief: project-specific rules, exceptions, and local runbooks belong here; common branch, worktree, ticket, board, and closeout procedure belongs in global `AGENTS.md` and global `RULES.md`.

This guide intentionally does not restate status vocabulary, branch naming, worktree creation, ticket flow, or closeout steps. If a common workflow rule changes, update the global operating documents instead of copying that procedure into this project.

<shared_rules>

<pipeline>
For medium and large tasks, the expected pipeline is:

1. clarification runs first
2. planning runs second
3. execution runs third
4. review/QA runs before closeout
5. **The result is logged**

Do not start medium or large execution work until clarification and planning are complete.
</pipeline>

<command_routing>
Keep the systems separate. Their names and commands are not interchangeable.

- Keep command namespaces isolated when multiple tool families coexist.
- Do not assume the same nickname means the same thing across different tools.
- Keep planning/review commands distinct from execution/delegation commands.
</command_routing>

<cross_system_rules>

### 1. Namespace Isolation

- Do not mix command syntaxes between different tool families
- Do not assume a command with the same nickname means the same thing across systems

### 2. Long-Running Task Protocol

- Start long-running builds, tests, or evals in the background when appropriate
- Poll until completion instead of assuming timeout means failure or success
- Do not abandon a background verification loop unless the user tells you to stop or the task is clearly blocked

### 3. Explicit Persistence Beats Hidden Memory

- Project-relevant rules should be written to tracked files
- Do not rely on temporary tool memory as the only source of truth for workspace behavior

</cross_system_rules>

<strong_rules>

### Browser Tools

- Do not use `mcp__claude-in-chrome__*`
- Use `/browse` or `$B <command>` instead

### Generated Skill Docs

If the target repo has `SKILL.md.tmpl` or a `gen:skill-docs` workflow:

- Treat `SKILL.md` as generated output
- Edit the `.tmpl` source instead
- Regenerate the docs after template changes
- Do not resolve merge conflicts by accepting one side of generated `SKILL.md`

### Commit Shape

- Keep commits bisectable
- One logical change per commit
- Use extra trailers only when the change carries decision context worth preserving


</strong_rules>

</shared_rules>


<project_info>
- **Project:** bpbrowser
- **Domain:** browser, autonomous-agent
- **Date:** 2026-10-14
- **Author:** HIPRA Team
</project_info>

</project_operating_guide>