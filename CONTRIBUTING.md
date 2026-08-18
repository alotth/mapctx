# Contributing to MapCtx

Thanks for contributing.

This repo is workflow-first: keep task data deterministic, keep edits low-conflict, and route automation through skills and `mapcs` commands.

Methodology references:

- `docs/methodology.md`
- `docs/PROJECT.md`
- `docs/ROADMAP.md`
- `docs/adr/0001-methodology-and-source-of-truth.md`

## Development setup

```bash
npm ci
npm run compile
npm run build:sync-engine
```

Run tests before opening a PR:

```bash
npm test
npm run test:sync-engine
```

## Task model expectations

- Use a single `## Tasks` list in `TASKS.md`.
- Do not create status columns (`## Backlog`, `## Doing`, etc.).
- Keep canonical key order in each task block.
- Use `tasks/<ID>.md` for long-form details.
- Default flow: `backlog -> ready-for-do -> doing -> review -> done` (+ `paused`).
- In detail files, keep unresolved questions under `Open Decisions for Execution`, final dated answers under `Decisions Taken`, and concrete landing spots under `Implementation Notes`.
- Keep project-wide context in `docs/PROJECT.md`, sequencing in `docs/ROADMAP.md`, and durable decisions in `docs/adr/`.

If a task file exists, use the `mapctx-tasks` skill when editing `TASKS.md` or detail files.

## Skills-first workflow

Preferred operational sequence:

1. `mapctx-plan-engine` (board QA and execution waves)
2. `mapctx-sync-engine` (pull/push/bootstrap/reconcile)
3. `mapctx-ralph-tasks` (execution loop)

Subagent policy:

- default to single-agent execution for `lite` and most `standard` work
- escalate to planner/reviewer/evaluator flows only for `strict`, `Hard`, `Extreme`, or clearly cross-domain work
- avoid adding extra workflow ceremony when `TASKS.md` + a task detail file already provide enough context

`mapcs` command flow for safe sync:

```bash
mapcs validate
mapcs plan
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

## Release tags

- `ext-vX.Y.Z` -> VS Code extension
- `sync-vX.Y.Z` -> `@mapctx/sync-engine`
- `plugin-vX.Y.Z` -> OpenCode plugin

Runbooks:

- `docs/releases/tag-strategy.md`
- `docs/releases/extension.md`
- `docs/releases/engine.md`
- `docs/releases/opencode-plugin.md`
