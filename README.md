# MapCtx - Multi-Agent Project Context

MapCtx is planning and delivery intelligence for work executed by coding agents
across multiple harnesses.

Current release combines:

- an external project store as the live authority (`plansAuthority: store` in
  `mapctx.toml`), shared across worktrees through the `mapctx` CLI
- generated, read-only board snapshots: `TASKS.md` and the structured field
  blocks of `tasks/<ID>.md`
- visual workflows (VS Code extension; OpenCode plugin frozen)
- GitHub Issues/Projects sync via `@mapctx/sync-engine`

vNext keeps rich task planning, resource-aware waves, Kanban, and Gantt, but
moves live mutable state to an external project store. Traycer is first execution
adapter; Git stores approved specs/ADRs rather than runtime state. See
`docs/PROJECT.md`, `docs/ROADMAP.md`, ADR 0003, and ADR 0004.

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

MapCtx is task-first and contract-first. Authority is binary and tracked in
`mapctx.toml` (`plansAuthority: markdown | store`); Markdown and the store are
never simultaneously writable. This repository is post-cutover
(`plansAuthority: store`).

- live operational source: the external project store, written only through the
  `mapctx` CLI
- `TASKS.md` and the structured field blocks of `tasks/<ID>.md`: generated,
  read-only snapshots; hand edits surface as `mapctx validate` drift errors
- `description:` prose blocks in `tasks/<ID>.md`: Git-authored regardless of
  regime (durable intent, not live board state)
- living repo context: `docs/PROJECT.md`
- delivery sequencing: `docs/ROADMAP.md`
- workflow and adoption policy: `docs/methodology.md`
- durable decisions: `docs/adr/`

Host rules remain authoritative. MapCtx records Product Review, System
Architecture, Program Design, and Vertical Slice gates when required, but never
overrides harness workflow policy or owns agent execution.

## Task model and authority

The board schema is unchanged: single `## Tasks` list (no status-column
sections), canonical field order, and status flow
`backlog -> ready-for-do -> doing -> review -> done` (+ `paused`). What changed
after cutover is who writes it:

- editable surfaces: the `mapctx` CLI (`task create/move/update`,
  `dispatch create/receipt`), the cutover flow (`mapctx import
  --dry-run/--commit`), and recovery (`mapctx store init/repair`)
- `TASKS.md` and the structured blocks of `tasks/<ID>.md` are regenerated
  output; never hand-edit them
- a good-faith manual edit is resolved with `mapctx reconcile <task-id>`
  (accept or discard per field); silent merge is never an option
- detail files keep Git-authored prose: `Open Decisions for Execution` for
  questions, `Decisions Taken` for dated answers, `Implementation Notes` for
  concrete file/doc references

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

## CLI (`mapctx`)

The canonical CLI is `mapctx`; `mapcs` remains a temporary deprecated alias for
GitHub sync.

Store-backed task operations:

```bash
mapctx task claim <task-id>              # lease a task (returns claimId + leaseToken)
mapctx task move <task-id> --status doing
mapctx task update <task-id> --set priority=high
mapctx task create --title "..." --summary "..."
mapctx task context <task-id> --budget 2000
mapctx dispatch create <task-id>         # feed dispatchId/attempt into dispatch receipt
mapctx dispatch receipt <dispatch-id> --receipt path
```

Board hygiene and planning:

```bash
mapctx validate   # drift check runs when plansAuthority: store
mapctx plan
```

Cutover and recovery:

```bash
mapctx import --dry-run    # preview; refuses lossy imports (ADR 0004)
mapctx import --commit     # writes store, regenerates TASKS.md, flips plansAuthority in one commit
mapctx store init          # rehydrate from the last git-committed checkpoint
mapctx store repair        # reproject mapctx.db from the append-only journal
```

GitHub sync still uses the `mapcs` command surface:

```bash
mapcs status
mapcs pull
mapcs push
mapcs bootstrap --from <local|github>
mapcs reconcile <task-id>
```

Local state: `mapctx.toml` at the repository root (project identity,
`plansAuthority`, GitHub binding) and `~/.mapctx/projects/<id>/` (SQLite store
plus event journal). Back up the store directory on your own cadence and commit
generated checkpoints to git.

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

- `mapctx-tasks`: pre-cutover Markdown board editing; post-cutover, use the `mapctx` CLI instead
- `mapctx-plan-engine`: run `mapctx validate/plan` for board QA and wave planning
- `mapctx-sync-engine`: operate pull/push/bootstrap/reconcile safely
- `mapctx-ralph-tasks`: execute task loops via slash trigger
- `mapctx-enrich-task`: enrich sparse task detail files before execution
- `mapctx-correct-course`: capture and apply mid-stream scope changes safely

The rule files in `rules/` are intentionally lightweight and are meant to route agents into the correct skills.

Execution stance:

- default to a single agent for `lite` and most `standard` work
- use `mapctx validate` and `mapctx plan` before larger or dependency-heavy execution
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
