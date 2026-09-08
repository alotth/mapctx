# MapCtx Project Context

## Product

MapCtx is planning and delivery intelligence for work executed by coding agents
across multiple harnesses.

It turns approved intent into a rich task graph, compiles bounded execution
context, schedules dependency/resource-safe waves, ingests run receipts, and
improves delivery forecasts from actual time, token, cost, and changed-file data.

## Ownership Boundaries

| MapCtx owns | Harnesses own | Git owns |
| --- | --- | --- |
| task graph, domains/paths, dependencies, waves | agents, sessions, chat, worktrees | approved specs, ADRs, durable decisions |
| context queries and semantic validation | collaboration and execution lifecycle | optional promoted snapshots |
| normalized run/usage events and forecasts | provider-specific telemetry | code history |
| Kanban and planned/forecast/actual Gantt | runtime retries and supervision | reviewable project policy |

Traycer is first execution adapter. Orca, Paperclip, and GitHub remain external
systems connected through explicit protocols and source/projection modes.

## Source of Truth

- external project store: live operational task state, claims, events, actuals,
  costs, and forecasts;
- external harness artifacts: collaborative context in progress;
- repository: `mapctx.toml`, approved specs, ADRs, and explicit promotions;
- `TASKS.md`: compatibility export/snapshot, not future hand-edited database;
- GitHub Issues/Projects: optional projection or exclusive external source mode.

## Product Principles

1. Rich MapCtx tasks remain planning authority.
2. Executor tickets are linked projections, not a second planning backlog.
3. Mutable and derived data do not live in Markdown.
4. Context is queried under budget; full-board injection is never default.
5. MapCtx does not own transcripts, worktrees, A2A, or provider sessions.
6. Forecasts separate planned, predicted, and actual values with provenance.
7. Adapters fail independently; local planning remains available offline.

## Workflow Guardrails

MapCtx complements host/repository rules and never overrides them.

Large work can record four gates at epic level:

1. Product Review;
2. System Architecture;
3. Program Design;
4. Vertical Slices.

Each gate references evidence in Traycer or Git. Local low-risk changes may skip
the full workflow with a recorded reason. MapCtx never infers approval silently.

## Current Focus

- define vNext protocol and external store;
- preserve resource-aware planning (`domains`, paths, dependency waves);
- validate neutral dispatch and receipts with Traycer;
- convert current UI into planning/forecast views over store queries;
- unify CLI under `mapctx` and deprecate `mapcs`;
- consolidate skills around deterministic core capabilities.

## Out of Scope

- general-purpose PM suite;
- custom agent runtime or Traycer fork;
- collaborative document engine;
- transcript/session portability owned by MapCtx;
- implicit bidirectional merge between multiple authorities;
- ML forecasting before baseline statistics and real actuals exist.

See `docs/ROADMAP.md` and ADR `0003` for delivery sequence and rationale.
