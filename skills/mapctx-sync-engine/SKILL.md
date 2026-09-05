---
name: mapctx-sync-engine
description: Safely operate MapCtx sync via `mapctx` and `@mapctx/sync-engine`; trigger when users need sync config setup, TASKS.md <-> GitHub pull/push/bootstrap/reconcile, source-mode questions, or divergence/conflict diagnosis.
---

# MapCtx Sync Engine

Use this skill for GitHub synchronization and sync configuration around the MapCtx task contract.

The canonical CLI is `mapctx`. `mapcs` is a deprecated alias that still works for one release cycle but prints a deprecation notice; use `mapctx` everywhere. See `docs/migration-mapcs-to-mapctx.md`.

GitHub is a projection of local state by default (`github.sourceMode: "projection"` in the sync config): push exports, and pull/bootstrap-from-GitHub are explicit one-off imports. `canonical` mode is defined but not implemented and fails closed.

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
- User asks whether GitHub or the local board is the source of truth.

## Workflow

1. Run preflight for tool availability.
   - Check `command -v mapctx`.
   - If unavailable, use `npx --yes --package @mapctx/sync-engine mapctx <command>`.
   - Suggest global install (`npm install -g @mapctx/sync-engine`) only when the user wants local installation.

2. Ensure config exists before sync commands.
   - Prefer `./mapcs.config.json` (file name kept for compatibility).
   - If missing and the user wants setup, run `mapcs init` (the init subcommand lives on the deprecated alias until it is removed).
   - Use `mapcs init --tasks-file <path>` for non-default `TASKS.md`.
   - `mapcs init` can create a local-only board/project config; GitHub owner/repo/project fields are optional until actual GitHub sync.
   - Use `mapcs init --force` only when the user explicitly approves overwriting config.
   - New configs write `github.sourceMode: "projection"` explicitly; leave it unless the user asks about authority modes.

3. Check current sync state first.
   - Run `mapcs status` (or the alias-free equivalent once it lands on `mapctx`).
   - Use `--json` when machine-readable diagnosis is needed.

4. Refresh local base before any publish operation.
   - If remote differs or staleness is unknown, run `mapcs pull` first.
   - Pull is an explicit import in projection mode; the CLI announces this.

5. Preview impact for bootstrap or broad updates.
   - Run the same command with `--dry-run` before executing writes.
   - `push --dry-run --json` returns a machine-readable summary (`created`/`updated`/`conflicts`) without touching GitHub.

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
- Never set `github.sourceMode: "canonical"`; it is not implemented and every sync command fails closed with an error.
- On sync errors mentioning missing scopes, diagnose by name: Projects v2 needs `read:project` (`gh auth refresh -h github.com -s read:project`); private repos need `repo`.

## Response Format

Return short operational updates with:

- Current sync state.
- Commands executed.
- High-level fields changed.
- Conflicts found and resolution policy used.
- Recommended next action.
