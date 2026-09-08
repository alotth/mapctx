# MapCtx Roadmap

MapCtx vNext evolves in the same monorepo through new modules and vertical
migration. Completed work remains historical evidence. Paused legacy workflow,
runner, thread, and broad sync work does not automatically carry into vNext.

## Product Direction

> MapCtx plans rich, resource-aware work and learns delivery forecasts;
> Traycer/Orca/Paperclip execute it; Git preserves approved intent and decisions.

## Stage 1 — Product Review (decided)

Build planning intelligence, not another agent cockpit or generic tracker.

Suggestion adopted: use external systems as adapters and preserve MapCtx's
defensible core — task-context compilation, resource-aware waves, forecast, and
planned × actual Gantt.

## Stage 2 — System Architecture (decided)

Use two storage planes:

- external SQLite/event store shared by all worktrees for live state;
- Git for configuration, approved specs, ADRs, and explicit promotions.

Traycer is first executor. Its tickets mirror MapCtx tasks for execution; they do
not replace rich planning fields. Neutral `DispatchEnvelope`, `RunEvent`, and
`RunReceipt` contracts prevent core coupling to one harness.

Structural recommendation adopted: same repository, new modules, no long-lived
vNext branch.

## Stage 3 — Program Design

### Phase A: protocol and store

- define `Project`, `Epic`, `Task`, `DependencyEdge`, `ResourceClaim`,
  `ArtifactRef`, `Dispatch`, `RunEvent`, `UsageEvent`, `CostEvent`, `PlanPeriod`,
  and `EstimateSnapshot`;
- create external project store on plain local SQLite, resolved by versioned
  project ID, with no account, key, or network in the default install;
- make events append-only, identified by `(nodeId, sequence)` so logs from two
  hosts can merge later, and projections rebuildable from the log alone;
- keep the database behind the CLI process; UI clients read via `--json`;
- distinguish `planningState` from executor `executionState`;
- add semantic validation for impossible dates, stale derived fields, invalid
  parent/dependency links, and unsafe resource collisions.

### Phase B: bounded context and scheduling

- add `mapctx task show/context --budget` queries;
- migrate `domains` and `touch` into typed `resourceClaims`;
- schedule waves from both DAG and read/write path collisions;
- produce deterministic `TASKS.md` compatibility snapshots.

### Phase C: Traycer adapter

- attach Traycer epic/artifact IDs to MapCtx entities;
- materialize rich MapCtx tasks as simple Traycer tickets;
- claim work atomically and create agents/worktrees through a Traycer skill;
- ingest events/receipts without storing transcripts;
- promote approved artifacts to Git explicitly.

### Phase D: forecasting and UI

- establish workload/domain/executor priors;
- compute immutable P50/P90 duration, token, and shadow-cost snapshots;
- record `cashCents`, `shadowMicros`, and `allocatedMicros` separately so flat
  plans still produce comparable per-task cost;
- derive `sessionWallClock`, `activeTime`, `taskDuration`, and `leadTime` from
  session timestamps; forecast on `activeTime`;
- show Kanban state plus planned, forecast, and actual Gantt layers;
- compare predicted versus actual resource claims and delivery variance.

### Phase E: adapters and migration

- unify CLI under `mapctx`; keep `mapcs` as one-cycle deprecated alias;
- consolidate skills and serve version-matched operational guidance from CLI;
- make GitHub source mode explicit and exclusive per project;
- add pagination, scope diagnostics, and measured `gh` versus MCP projections;
- freeze/remove MapCtx-owned thread, runner, and evaluator features superseded by
  harnesses — one written disposition per surface, not a blanket sweep: `thread.ts`
  removed, `workspace-server.ts` frozen because it hosts the view the Gantt needs,
  `opencode-plugin` deprecated. Owned by T-059, gated on `RunReceipt` existing.

Configuration succeeds in one ordered step, not by accumulation: `mapcs.config.json`
at repository root is the single pre-cutover config, `mapctx.toml` replaces it at
the T-049 cutover commit, and `mapctx import` is the only bridge between them. The
GitHub binding inherited from it is unverified until Phase 1 acquires the
`read:project` scope the current token lacks.

## Stage 4 — First Vertical Slice

Evidence before breadth: a walking skeleton proves store and dispatch survive a
real Traycer round trip before waves, forecast, and UI are built on top of that
assumption.

### Slice 4a — Walking skeleton

1. dispatch one real task by hand through `DispatchEnvelope`, no adapter skill;
2. create the Traycer ticket manually from that envelope;
3. `RunReceipt` returns and updates store status;
4. two separate worktrees resolve identical claim/status for that task.

No waves, no forecast, no UI in this slice.

### Slice 4b — Full vertical slice

Run one real MapCtx epic end to end once 4a lands:

1. use Traycer brief/spec as planning input;
2. create three rich tasks with dependencies and resource claims;
3. compute two waves with two parallel tasks;
4. materialize Traycer tickets and child agents;
5. ingest changed files, time, tokens, and cost receipts;
6. render planned × actual Gantt and first P50/P90 forecast;
7. promote one accepted decision to repository ADR.

Do not build additional adapters before this slice works.

## Gates

| Gate | Evidence required | Unlocks |
| --- | --- | --- |
| Core viability | worktrees share one atomic task/claim state | store-backed planning |
| Context efficiency | common dispatch context under 2k tokens | executor dispatch |
| Planning value | wave avoids known dependency/path collision | parallel waves |
| Integration value | Traycer ticket and MapCtx task cross-link reliably | adapter rollout |
| Intelligence value | forecast records provenance, coverage, and planned × actual variance | forecast surfaces |
| Internal dogfood | one real MapCtx epic runs end to end in this repository | planning Kanban and Gantt |
| External adoption | five external repos use CLI weekly | operational cockpit, agent/run views, multi-project, admin |

Dogfood and adoption are separate gates. Running MapCtx on MapCtx proves the
mechanism; it does not prove demand. Planning Kanban and Gantt are core product
and ship inside the slice; only cockpit-style operational surfaces wait for
external adoption.

## Legacy Treatment

- preserve completed tasks unchanged;
- keep obsolete or uncertain items paused, with vNext replacements linked in
  task details;
- do not revive Ralph/session runner, isolated evaluator, or broad workflow
  suite in core;
- retain existing UI as migration surface, not architectural authority;
- treat current sync implementation as adapter evidence, not vNext source model.

Operational transition tasks remain in `TASKS.md` until store-backed planning is
available. After migration, `TASKS.md` becomes generated output.
