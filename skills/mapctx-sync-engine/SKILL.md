---
name: mapctx-sync-engine
description: Safely operate MapCtx sync via `mapcs` and `@mapctx/sync-engine`; trigger when users need `mapcs init`, TASKS.md <-> GitHub pull/push/bootstrap/reconcile, sync config setup, or divergence/conflict diagnosis.
---

# MapCtx Sync Engine

Use this skill for GitHub synchronization and sync configuration around the MapCtx task contract.

The sync CLI is `mapcs`. The `mapctx` binary is for workspace/project UI operations.

Load operational details only when needed:

- `./references/daily-flow.md`
- `./references/bootstrap-modes.md`
- `./references/reconcile-conflicts.md`
- `./references/github-project-setup.md`
- `./references/policy-merge-precedence.md`

## Trigger Situations

- User asks to create or repair `mapcs.config.json`.
- User asks to update local `TASKS.md` from GitHub.
- User asks to publish local task changes to GitHub.
- User asks to bootstrap local tasks from GitHub or create GitHub issues from local tasks.
- User asks to diagnose divergence, conflicts, or sync state.

## Workflow

1. Run preflight for tool availability.
   - Check `command -v mapcs`.
   - If unavailable, use `npx --yes --package @mapctx/sync-engine mapcs <command>`.
   - Suggest global install (`npm install -g @mapctx/sync-engine`) only when the user wants local installation.

2. Ensure config exists before sync commands.
   - Prefer `./mapcs.config.json`.
   - If missing and the user wants setup, run `mapcs init`.
   - Use `mapcs init --tasks-file <path>` for non-default `TASKS.md`.
   - Use `mapcs init --force` only when the user explicitly approves overwriting config.

3. Check current sync state first.
   - Run `mapcs status`.
   - Use `--json` when machine-readable diagnosis is needed.

4. Refresh local base before any publish operation.
   - If remote differs or staleness is unknown, run `mapcs pull` first.

5. Preview impact for bootstrap or broad updates.
   - Run the same command with `--dry-run` before executing writes.

6. Publish changes only after a successful pull in the active session.
   - Run `mapcs push`.
   - Re-run `mapcs status` to confirm convergence.

7. Handle conflicts explicitly.
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
