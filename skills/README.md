# MapCtx Skills

This directory contains reusable skill packs for AI-assisted workflows.

Methodology references:

- `docs/methodology.md`
- `docs/PROJECT.md`
- `docs/ROADMAP.md`
- `docs/adr/0001-methodology-and-source-of-truth.md`
- `docs/adr/0003-vnext-planning-intelligence-and-storage.md`

## Core Portfolio (vNext)

MapCtx owns exactly four skills. Everything else is harness-owned or retired.

| Skill | Status | Scope |
|---|---|---|
| `mapctx-tasks` | core | thin UX over `mapctx task/context` APIs |
| `mapctx-plan-engine` | core | validate, resource waves, next runnable work, forecast preflight |
| `mapctx-sync-engine` | core | GitHub source/projection operations with explicit `github.sourceMode` |
| `mapctx-traycer` | core | Traycer adapter: attach epics, materialize tickets, dispatch waves, ingest receipts |

## Retired and harness-owned surfaces

| Directory | Disposition |
|---|---|
| `mapctx-enrich-task/` | retired — consolidated into task breakdown/context compilation. Directory removal is follow-up work. |
| `mapctx-correct-course/` | retired — host planning skills govern requirement revision. Directory removal is follow-up work. |
| `mapctx-ralph-tasks/` | harness-owned execution loop, not a MapCtx core skill. Repo copy retired. |

MapCtx core does not own agent runners, evaluators, transcripts, or sessions.
ADR 0003 ("Superseded runtime surfaces") is the authority: `thread.ts` is
internalized, `workspace-server.ts` is frozen, and live execution coordination
belongs to executors such as Traycer. Status summaries, next-action selection,
sprint views, and context budgeting must be deterministic CLI/UI queries, not
separate skills. Agent execution loops, review, session continuation,
worktrees, and transcripts remain harness concerns.

Skills are small discovery stubs. Version-matched operational guidance comes
from the `mapctx` CLI (canonical; `mapcs` is a deprecated alias for one release
cycle) to prevent skill/runtime drift.

## Intended Use

- Traycer and other multi-agent harnesses through adapters
- Codex, Claude, OpenCode, and Cursor task workflows
- CI and human operators through one `mapctx` CLI

## Notes

- Skills are versioned with the monorepo until CLI-served guidance lands.
- When task format contracts change, update both skill docs and package docs in the same PR.
- Task ID convention is prefix-based: use `E-XXX` for `type: epic` and `T-XXX` for all other task types.
- Detail files should follow `./tasks/<ID>.md` (for example `./tasks/E-001.md`, `./tasks/T-014.md`).
- In task detail files, keep open questions in `Open Decisions for Execution`, final answers in `Decisions Taken`, and code/doc landing spots in `Implementation Notes`.
- Keep rule files lightweight (`rules/`) and enforce behavior through skills + tooling.
- Host workflow rules decide rigor and subagent use; MapCtx records gates/evidence and never overrides them.
