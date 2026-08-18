# MapCtx Skills

This directory contains reusable skill packs for AI-assisted workflows.

Methodology references:

- `docs/methodology.md`
- `docs/PROJECT.md`
- `docs/ROADMAP.md`
- `docs/adr/0001-methodology-and-source-of-truth.md`
- `docs/adr/0003-vnext-planning-intelligence-and-storage.md`

## Current Skills

- `mapctx-tasks`: current Markdown task operations; migrate to store-backed CLI.
- `mapctx-plan-engine`: keep and extend with semantic/resource-aware planning.
- `mapctx-sync-engine`: keep as explicit GitHub adapter, not universal authority.
- `mapctx-enrich-task`: consolidate into task breakdown/context compilation.
- `mapctx-correct-course`: consolidate; host planning skills govern requirement revision.

README previously listed Ralph and session-continuation skills that are not part
of the checked-in current skill set. vNext does not restore them.

## vNext Portfolio

1. `mapctx-tasks`: thin UX over `mapctx task/context` APIs.
2. `mapctx-plan-engine`: validate, resource waves, next runnable work, forecast preflight.
3. `mapctx-sync-engine`: GitHub source/projection operations with explicit mode.
4. `mapctx-traycer`: attach epics, materialize tickets, dispatch waves, ingest receipts, promote artifacts.

Status summaries, next-action selection, sprint views, and context budgeting must
be deterministic CLI/UI queries, not separate skills. Agent execution loops,
review, session continuation, worktrees, and transcripts remain harness concerns.

Skills should become small discovery stubs. Version-matched operational guidance
comes from the `mapctx` CLI to prevent skill/runtime drift.

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
