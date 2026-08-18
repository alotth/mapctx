# MapCtx - Multi-Agent Project Context

MapCtx is planning and delivery intelligence for work executed by coding agents
across multiple harnesses.

Current release combines:

- a deterministic task board in `TASKS.md`
- per-task detail files in `tasks/<ID>.md`
- visual workflows (VS Code extension + OpenCode plugin)
- GitHub Issues/Projects sync via `@mapctx/sync-engine`

vNext keeps rich task planning, resource-aware waves, Kanban, and Gantt, but
moves live mutable state to an external project store. Traycer is first execution
adapter; Git stores approved specs/ADRs rather than runtime state. See
`docs/PROJECT.md`, `docs/ROADMAP.md`, and ADR 0003.

Install extension: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=alotth.mapctx)

## Monorepo structure

- `packages/vscode-extension/`: VS Code/Cursor extension (`mapctx`)
- `packages/opencode-plugin/`: OpenCode plugin assets and installer scripts
- `packages/sync-engine/`: current `@mapctx/sync-engine`; vNext canonical CLI is
  `mapctx`, with `mapcs` retained temporarily as deprecated compatibility alias
- `packages/core/`: shared parsing/model utilities
- `docs/`: project context, methodology, roadmap, ADRs, and release runbooks
- `skills/`: reusable AI skill packs
- `rules/`: shared lightweight rule presets for agents

Contributor guide: `CONTRIBUTING.md`

## Methodology and project docs

MapCtx is task-first and contract-first. Current Markdown contracts remain
supported during vNext migration.

- current operational source: `TASKS.md` and `tasks/<ID>.md`
- vNext live source: external project event store; `TASKS.md` becomes snapshot
- living repo context: `docs/PROJECT.md`
- delivery sequencing: `docs/ROADMAP.md`
- workflow and adoption policy: `docs/methodology.md`
- durable decisions: `docs/adr/`

Host rules remain authoritative. MapCtx records Product Review, System
Architecture, Program Design, and Vertical Slice gates when required, but never
overrides harness workflow policy or owns agent execution.

## Current task model

- Single-list board under `## Tasks` (no status-column sections)
- Canonical fields: `id`, `status`, `type`, `parent`, `subIssueProgress`, `priority`, `workload`, `tags`, `domains`, `dependsOn`, `start`, `due`, `completed`, `externalId`, `updated`, `detail`
- Optional extensions include `iteration`, `assignees`, `externalLinks`, `milestone`, `specMode`
- Default status flow: `backlog -> ready-for-do -> doing -> review -> done` (+ `paused`)
- Detail files keep decision history explicit: `Open Decisions for Execution` for questions, `Decisions Taken` for dated answers, `Implementation Notes` for concrete file/doc references

Authoring and enforcement live in skills + sync tooling, not duplicated in long global rules.

## Quick start

1) Install dependencies

```bash
npm ci
```

2) Build key packages

```bash
npm run compile
npm run build:sync-engine
npm run build:opencode-plugin
```

3) Run tests

```bash
npm test
npm run test:sync-engine
```

## Sync engine (`@mapctx/sync-engine`)

Run with npx:

```bash
npx --yes --package @mapctx/sync-engine mapcs status
```

Core operational commands:

- `mapcs status`
- `mapcs pull`
- `mapcs push`
- `mapcs bootstrap --from <local|github>`
- `mapcs reconcile <task-id>`
- `mapcs validate`
- `mapcs plan [--mermaid]`

Recommended safe flow:

```bash
mapcs validate
mapcs plan
mapcs pull
mapcs status
mapcs push
```

Main local state files:

- `mapcs.config.json`
- `.mapcs/state.json`
- `.mapcs/conflicts/<task-id>.reconcile.md`

Detailed docs:

- `packages/sync-engine/README.md`
- `packages/sync-engine/DOCUMENTATION.md`
- `packages/sync-engine/CHEATSHEET.md`

## AI workflow (skills-first)

Available skills are listed in `skills/README.md`.

Methodology reference:

- `docs/methodology.md`
- `docs/PROJECT.md`
- `docs/ROADMAP.md`
- `docs/adr/0001-methodology-and-source-of-truth.md`

Key skills:

- `mapctx-tasks`: create/update canonical `TASKS.md` entries
- `mapctx-plan-engine`: run `mapcs validate/plan` for board QA and wave planning
- `mapctx-sync-engine`: operate pull/push/bootstrap/reconcile safely
- `mapctx-ralph-tasks`: execute task loops via slash trigger
- `mapctx-enrich-task`: enrich sparse task detail files before execution
- `mapctx-correct-course`: capture and apply mid-stream scope changes safely

The rule files in `rules/` are intentionally lightweight and are meant to route agents into the correct skills.

Execution stance:

- default to a single agent for `lite` and most `standard` work
- use `mapcs validate` and `mapcs plan` before larger or dependency-heavy execution
- reserve planner/reviewer/evaluator subagents for `strict`, `Hard`, or `Extreme` work when the extra isolation meaningfully improves confidence

## OpenCode plugin

Build and install from repo root:

```bash
npm run build:opencode-plugin
npm run install:opencode-plugin
```

Installed paths:

- `~/.config/opencode/plugins/kanban-roadmap/`
- `~/.config/opencode/plugins/kanban-roadmap.js`

## Releases

Release tags by package:

- `ext-vX.Y.Z` -> VS Code extension
- `sync-vX.Y.Z` -> `@mapctx/sync-engine`
- `plugin-vX.Y.Z` -> OpenCode plugin

Release runbooks:

- `docs/releases/tag-strategy.md`
- `docs/releases/extension.md`
- `docs/releases/engine.md`
- `docs/releases/opencode-plugin.md`
