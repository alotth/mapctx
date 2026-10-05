# Contributing to MapCtx

Thanks for contributing.

This repo is workflow-first: keep task data deterministic, keep edits low-conflict, and route automation through skills and the `mapctx` CLI.

Methodology references:

- `docs/methodology.md`
- `docs/PROJECT.md`
- `docs/ROADMAP.md`
- `docs/adr/0001-methodology-and-source-of-truth.md`

## Development setup

```bash
npm ci
npm run build:sync-engine
```

Run tests before opening a PR:

```bash
npm test
```

## Task model expectations

This repository is post-cutover (`plansAuthority: store`): `TASKS.md` and the
structured field blocks of `tasks/<ID>.md` are generated, read-only output.

- Edit tasks through the `mapctx` CLI (`task create/move/reopen/update`,
  `dispatch create/receipt`); never hand-edit `TASKS.md` or the structured blocks of `tasks/*.md`.
- `mapctx validate --snapshots` reports drift from manual edits as an error; resolve it with `mapctx reconcile <task-id>` (accept or discard per field), never a silent merge.
- Default flow: `backlog -> ready-for-do -> doing -> review -> done`, with `paused` for temporary stops and `archived` for work that will not proceed. Archived is terminal and is not completion.
- The `description:` prose block in `tasks/<ID>.md` stays Git-authored: keep unresolved questions under `Open Decisions for Execution`, final dated answers under `Decisions Taken`, and concrete landing spots under `Implementation Notes`.
- Keep project-wide context in `docs/PROJECT.md`, sequencing in `docs/ROADMAP.md`, and durable decisions in `docs/adr/`.

## Skills-first workflow

Preferred operational sequence:

1. `mapctx-plan-engine` (board QA and execution waves)
2. `mapctx-sync-engine` (pull/push/bootstrap/reconcile)
3. `mapctx-ralph-tasks` (execution loop)

Subagent policy:

- default to single-agent execution for `lite` and most `standard` work
- escalate to planner/reviewer/evaluator flows only for `strict`, `Hard`, `Extreme`, or clearly cross-domain work
- avoid adding extra workflow ceremony when `TASKS.md` + a task detail file already provide enough context

Store-backed operations run through `mapctx` (`mapcs` remains a deprecated GitHub-sync alias):

```bash
mapctx validate
mapctx plan
mapcs pull
mapcs status
mapcs push
```

## Commit and PR guidance

- Keep commits focused and reviewable.
- Explain intent in commit messages (why, not only what).
- Update docs/skills/rules in the same PR when changing task contract behavior.
- Update `docs/methodology.md` or `docs/adr/` when changing repo-level workflow assumptions.
- Avoid unrelated formatting churn.

## Release

CLI/web is the active distribution. Use `sync-vX.Y.Z`; see [engine runbook](docs/releases/engine.md). Node 22.13+ required; Node 24 recommended. `npm test` covers protocol, store, planner, forecast, Traycer adapter, sync and browser roadmap tests.

VS Code/OpenCode adapter packages and their exclusive tools are preserved in `legacy/integrations-pre-0.3.0` (c6c3efa), not maintained on main. Keep historical migration/event compatibility and authored intent; do not classify them as disposable legacy code.
