---
name: kanban-sync-engine
description: Safely operate mapcs for TASKS.md <-> GitHub synchronization; trigger when sessions start with mapcs config, when users request pull/push/bootstrap/reconcile, or when divergence/conflicts must be diagnosed.
---

# Kanban Sync Engine

Use this skill to run sync operations with low risk, low token usage, and clear user feedback.

Keep this file focused on workflow and guardrails. Load operational details from references:

- `./references/daily-flow.md`
- `./references/bootstrap-modes.md`
- `./references/reconcile-conflicts.md`
- `./references/github-project-setup.md`
- `./references/policy-merge-precedence.md`

## Trigger Situations

- Session starts and repository has `mapcs.config.json`.
- User asks to update local roadmap/tasks from GitHub.
- User asks to publish local task changes to GitHub.
- User asks to diagnose divergence or resolve sync conflicts.

## Workflow

1. Run preflight for tool availability.
   - Check `command -v mapcs`.
   - If unavailable, prefer non-invasive execution with `npx --yes --package @mapctx/sync-engine mapcs <command>`.
   - Suggest global install (`npm install -g @mapctx/sync-engine`) only with explicit user confirmation.

2. Check current sync state first.
   - Run `mapcs status` (or npx fallback).

3. Refresh local base before any publish operation.
   - If remote differs or staleness is unknown, run `mapcs pull` first.

4. Preview impact for bootstrap or broad updates.
   - Run the same command with `--dry-run` before executing writes.

5. Publish changes only after a successful pull in the active session.
   - Run `mapcs push`.
   - Re-run `mapcs status` to confirm convergence.

6. Handle conflicts explicitly.
   - Use reconcile flow from `./references/reconcile-conflicts.md`.
   - If matching is ambiguous, pause and request one mapping decision.

## Guardrails

- Never run `push` before a successful `pull` in the active session.
- Never overwrite local-only fields from remote.
- Never delete tasks automatically unless the user explicitly requests destructive sync mode.
- Never use `--force` unless user explicitly asks for force behavior.
- Never install tooling globally without explicit user confirmation.

## Response Format

Return short operational updates with:

- Current sync state.
- Commands executed.
- High-level fields changed.
- Conflicts found and resolution policy used.
- Recommended next action.
