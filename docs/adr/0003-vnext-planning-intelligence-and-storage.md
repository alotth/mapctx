# ADR 0003: Planning intelligence with external live state

- Status: accepted
- Date: 2026-08-15
- Supersedes: ADR 0002 (portable thread substrate)

## Context

MapCtx began as a repository-local Markdown task contract and expanded into
GitHub sync, workflow skills, portable threads, Kanban, roadmap, and early
run/cost views. Traycer and Orca now solve live multi-agent context and execution
coordination better. Paperclip demonstrates a stronger operational event and
cost model.

Current `TASKS.md` also contains manually maintained derived fields. Most tasks
lack schedule dates, all share a bulk `updated` date, and existing Gantt duration
uses fixed workload defaults. Multiple agent worktrees make mutable repository
task files diverge.

## Decision

MapCtx vNext is planning and delivery intelligence, not an agent runtime.

1. Rich task graph, resource claims, scheduling, context compilation, and
   forecasting remain MapCtx responsibilities.
2. Live mutable state moves to an external per-project SQLite/event store shared
   by worktrees.
3. Git stores project identity/configuration, approved specs, ADRs, and explicit
   promotions.
4. `TASKS.md` becomes a deterministic compatibility snapshot.
5. Traycer is first executor adapter. MapCtx tasks project to Traycer tickets;
   Traycer owns agents, sessions, collaboration, and worktrees.
6. Neutral dispatch/events/receipt contracts permit Orca, Paperclip, and future
   executors without core coupling.
7. Host workflow rules remain authoritative. MapCtx records workflow gates and
   evidence but never overrides or silently approves them.
8. CLI name is `mapctx`; `mapcs` remains a temporary deprecated alias.
9. Cost is recorded as three distinct measures — billed cash, list-price shadow
   cost, and period allocation — because fixed-price plans make billed cash
   useless for per-task comparison. See "Cost model".
10. The store is plain local SQLite with no service dependency. Multi-host
    sharing, when it arrives, ships events rather than replicating a database.
    See "State locality".
11. Duration is derived from session timestamps only, split into wall clock,
    active time, task duration, and lead time. See "Time model".
12. Executable contracts live in `@mapctx/protocol` (Zod-first, JSON Schema
    generated). Identity, state machines, and the persist/derive/drop map are
    code, not prose. See `packages/protocol/docs/identity.md`.

## Cost model

Paperclip's ledger prices a subscription run at zero
(`normalizeBilledCostCents` returns 0 for `subscription_included`) and reports
subscription runs on a separate axis. That is correct accounting and useless for
answering "what did this epic cost" on a flat monthly plan, where every task
would report zero.

MapCtx therefore records three measures per usage event, never one:

| Measure | Definition | Used for |
|---|---|---|
| `cashCents` | money actually billed. Subscription-included = 0; overage = real | finance, budgets, hard stops |
| `shadowMicros` | tokens priced at published list rates, always computed regardless of plan | task comparison, forecasting, calibration |
| `allocatedMicros` | fixed period fee spread across the period proportionally to `shadowMicros` | "how much of my plan did this epic consume" |

Consequences of the split:

- forecasting uses `shadowMicros`, never allocation. Allocation is unstable while
  a period is open and would make every past estimate move;
- `allocatedMicros` is provisional until the `PlanPeriod` closes and must be
  marked as such wherever it is displayed;
- `billingType` follows Paperclip's taxonomy (`metered_api`,
  `subscription_included`, `subscription_overage`, `credits`, `fixed`,
  `unknown`);
- `costStatus` extends it with `allocated` and `estimated` beyond `reported` and
  `unpriced`, so a rated number is never compared to an invoiced one;
- non-inference costs (compute, tooling, human time) enter the same event stream
  with their own `billingType`, keeping one aggregation path per task/epic.

Token and cost capture depends on the harness, not on the executor. Traycer's
protocol exposes only per-profile rate-limit gauges, so per-run usage arrives
from harness transcripts and hooks with uneven coverage. Duration is therefore
the mandatory forecasting signal and cost is best-effort per harness.

## State locality

v1 is single-host and single-user. A second machine or a second developer on the
same repository resolves a different local store, and neither CI nor code review
observes live state. Shared operation is a later capability, not an emergent one.

The default install has no account, no key, no network, and no service
dependency. A solo developer on one machine is the primary case and must stay
free and offline. The store is plain local SQLite.

Sharing across hosts is therefore modelled as a transport, not as storage.
Because live state is an append-only event log identified by
`(nodeId, sequence)`, syncing two hosts means shipping the events each side is
missing and reprojecting. No database replication and no CRDT engine is required,
and any backend — self-hosted endpoint, managed SQLite service, Postgres — can
serve it behind the same interface.

Two constraints bind now, and both are engine-independent:

- the event log is append-only and identified by `(nodeId, sequence)`; global
  autoincrement is never an identity or ordering authority;
- projections are rebuildable from the log alone.

Database-replication approaches were considered and dropped. Embedded read
replicas forward writes to a primary, which requires network on every write and
is strictly worse than local SQLite for parallel agents in separate worktrees.

Only the CLI process opens the database. Extensions, plugins, and any UI read
through `mapctx ... --json`. This keeps one writer path, keeps native-module ABI
problems out of the VS Code and Electron hosts, and matches the decision that UI
is a client rather than an authority.

## Time model

Duration comes from session timestamps that every harness already produces. Raw
first-to-last is kept but is not the forecasting input, because idle sessions and
multi-session tasks both inflate it.

```text
sessionWallClock = last(ts) - first(ts)                 per session/dispatch
activeTime       = sum of inter-event gaps < threshold  default 10 min
taskDuration     = union of session intervals           not max - min
leadTime         = readyAt -> doneAt                    calendar, includes waiting
```

Gantt displays wall clock and lead time. P50/P90 forecasting uses `activeTime`.
The idle threshold is configuration and is recorded in every estimate's
provenance.

## Validation gates

Internal dogfood and external adoption are separate gates and are not
substitutes. Running MapCtx on the MapCtx repository proves the mechanism works;
it does not prove demand.

| Gate | Evidence | Unlocks |
|---|---|---|
| Internal dogfood | one real MapCtx epic with planned x actual | planning Gantt and Kanban inside the slice |
| External adoption | five external repositories using the CLI weekly | operational cockpit, agent/run views, multi-project, admin |

## Authority and cutover

`TASKS.md`/`tasks/*.md` and the store are never simultaneously writable. Authority
is binary and tracked in git, not inferred from wall-clock time or from whether a
local database happens to exist.

- `mapctx.toml` carries `plansAuthority: markdown | store`, defaulting to
  `markdown`. The only writer of this field is `mapctx import`, run once as the
  final step of T-049's import transaction: it writes the store, generates the
  first deterministic `TASKS.md`, and flips `plansAuthority` to `store` in the
  same commit. The flip is the cutover — an event visible in `git log`, not a
  date recorded anywhere else.
- Before cutover, Markdown stays authoritative exactly as it is today: humans,
  agents, and `mapctx-tasks` edit `TASKS.md`/`tasks/*.md` directly, and no drift
  check runs.
- After cutover, `TASKS.md` and the structured field block of every
  `tasks/<ID>.md` (the fields with a store-modeled equivalent) become a
  generated, read-only snapshot. The `description:` prose block stays
  git-authored regardless of regime — it is durable intent under Decision item
  3, not live board state, and T-048's field-by-field migration mapping decides
  case by case which structured fields, if any, keep a Markdown-only existence.
- Drift detection recomputes canonical Markdown from current store state and
  compares it, byte-for-byte after LF-normalization and trailing-whitespace
  trimming, against the on-disk file. No mtime and no separately stored hash:
  mtime does not survive `git checkout`/merge, and a stored hash needs its own
  invalidation rule that regenerate-and-compare avoids entirely. A mismatch is
  enumerated per task by diffing regenerated against on-disk blocks.
- `mapctx validate` runs the drift check only when `plansAuthority: store`. A
  mismatch is reported as an `error`, the same severity tier as any other
  contract violation, non-zero exit. It is never auto-merged. The exit path for
  a good-faith manual edit is `mapctx reconcile <task-id>`, which diffs the
  drifted block against store state and asks, per field, to either discard the
  edit (regenerate from store) or accept it (write it into the store as a new
  event with `source: manual-reconcile` provenance). Silent merge is never an
  option.
- `plansAuthority` is a property of the project, not of the checkout. A
  worktree or clone that has `plansAuthority: store` but no local
  `~/.mapctx/projects/<id>/mapctx.db` is not pre-cutover — it is a store regime
  whose local copy has not materialized yet. Tooling fails closed in that case
  (refuses to treat Markdown as authoritative) and directs the user to
  rehydrate (`mapctx store init`) rather than silently falling back to the old
  regime. This keeps the single-host limitation in "State locality" from being
  misread as a second authority regime.

## Durability and rollback

The store is the only copy of live status, claims, runs, and cost once
`plansAuthority: store`. It lives outside Git and outside repo backups by design
(see "State locality"), so exit and disaster recovery need their own explicit
answer, not an assumption that Git already covers it.

**Exit hatch.** The only way to abandon vNext is a lossless round-trip: store →
generated `TASKS.md`/`tasks/*.md` → store. "Lossless" is scoped to exactly the
field set T-048's migration mapping marks `persist` or `derive` — the durable
intent and structured fields that already have a Markdown representation today.
It does not cover the event log, `UsageEvent`/`CostEvent`, `Dispatch`/`RunReceipt`
detail, or `EstimateSnapshot` history: none of these existed in Markdown before
vNext, so downgrading does not attempt to invent a Markdown shape for them. They
stay in the store directory, which downgrade never deletes — it only flips
`plansAuthority` back to `markdown` and stops treating the store as authoritative.
Proof is both a property-based test (generated store states → export → reimport
→ fixed point on the lossless field set) and golden fixtures pinning known-tricky
real cases (multi-line descriptions, unicode, epics with subtasks, empty optional
fields); the property test covers the general case, fixtures catch regressions a
generator is unlikely to hit.

**Checkpoint timing.** Export runs automatically at end-of-wave and end-of-epic,
not only on manual invocation. Deterministic generation is already a T-049
requirement; checkpointing is additional trigger points on that same path, not
new mechanism. A manual `mapctx export` stays available for on-demand snapshots.
Manual-only was rejected: the exit hatch is only as good as its most recent
snapshot, and relying on a human to run it before disaster strikes reproduces the
stale-derived-field problem this ADR already rejects for `TASKS.md`.

**Corruption chain.** Two tiers, closed to the point of surviving total directory
loss:

1. `mapctx.db` fails an integrity check but the directory is intact (e.g. an
   unclean shutdown mid-write): `mapctx store repair` reprojects `mapctx.db` from
   an append-only journal stored independently of the SQLite file
   (`events/<nodeId>/<sequence>.json`, fsynced before the SQLite index commits).
   A SQLite-only event table would die with the same file it is supposed to
   repair. A gap at a specific `(nodeId, sequence)` is reported by name, never
   silently skipped.
2. The event log itself is damaged past a given sequence: recovery stops there;
   MapCtx reports the boundary rather than guessing past it.
3. The whole `~/.mapctx/projects/<id>/` directory is gone: recovery falls back to
   the last git-committed checkpoint via `mapctx import`. This starts a new store
   incarnation with a fresh event epoch — history strictly older than that
   checkpoint is permanently gone, and the tooling says so.

**Backup.** MapCtx's responsibility ends at guaranteeing checkpoints exist and
are written to the working tree, and at providing `mapctx store repair`/
`mapctx import` as recovery tools. Everything past checkpoint granularity is the
user's: backing up `~/.mapctx/projects/<id>/mapctx.db` (Time Machine, disk
snapshots, manual copy) and committing the generated checkpoint to git on their
normal cadence. MapCtx adds no cloud backup or replication service in v1 —
consistent with the no-service-dependency stance in "State locality."

## Resource claims are advisory

`ResourceClaim` is a prediction made before the code it describes exists, so it
is wrong in both directions before real usage calibrates it. It is a scheduling
hint, not a correctness guarantee: the real backstop against a bad prediction is
the worktree merge, not the planner. This changes what the planner promises —
"reduces the likelihood of conflicting writes and explains its reasoning," not
"prevents conflicts."

Both failure directions are detected the same way: after a wave's dispatches all
return a terminal `RunReceipt`, the planner diffs `changedFiles` across every
pair of tasks scheduled in that wave and emits a `ClaimViolation` derived event —
never in real time, only post-hoc, because the ground truth (`changedFiles`) does
not exist until the run completes.

```ts
interface ClaimViolation {
  id: string;
  waveId: string;
  kind: "collision" | "overbroad";
  taskAId: string;
  taskBId: string;
  path: string;
  detectedAt: string;
  source: "derived-from-receipts";
}
```

- `collision`: two same-wave tasks' actual `changedFiles` intersect on a path
  neither declared claim covered (or covered too narrowly) — the wave should
  have been serialized and wasn't. This is the dangerous direction: a real
  conflict shipped to two parallel worktrees undetected until merge.
- `overbroad`: a claim collision serialized two tasks into different waves at
  planning time, but their actual `changedFiles` never intersected on the path
  that caused the split — parallelism was lost for a reason that didn't
  materialize. Detection cross-references the planning-time explanation (already
  required of the planner) against the post-hoc receipts.

No ML and no automatic recalibration in v1. `ResourceClaim.confidence` stays a
static value set by whatever emits the claim (glob heuristic, authored
`filesAffected`, etc.). `ClaimViolation` accumulates as a queryable event stream
— shaped by `(task, path, domain pattern, kind, timestamp)` — so a human can
retune the claim-inference heuristic by hand today, and so automated calibration
has the right shape to consume later without a schema migration.

## Configuration succession

Before this ADR the repository carried three configuration truths: a root
`sync.config.json` that no code path read (stale `projectId`, status map without
`ready-for-do`), a `packages/sync-engine/mapcs.config.json` matching the schema
the CLI actually resolves but living outside the directory it resolves from, and
`TASKS_SYNC_CONTEXT.md`, a pre-rename brief declaring "GitHub Issues + Projects
are the source of truth after sync" — the opposite of the authority rule above.

Exactly one configuration file is live at a time, and the succession is ordered:

| Phase | File | Reads |
|---|---|---|
| pre-cutover (today) | `mapcs.config.json` at repository root | `mapcs` sync/validate/plan |
| post-cutover (T-049) | `mapctx.toml` at repository root | `mapctx` everything, including `plansAuthority` |

`mapctx import` reads `mapcs.config.json` exactly once, carries its GitHub
binding into `mapctx.toml`, and the old file is deleted in the same cutover
commit. No merge, no fallback chain, no "if A missing try B". A repository
holding both after cutover is an error, not a preference.

Two facts recorded rather than assumed: the surviving `projectId`
(`PVT_kwHOAcgr-s4BQF05`) has **never been verified against GitHub** — the local
token lacks the `read:project` scope, no `.mapcs/state.json` exists at root, and
all 68 tasks carry `externalId: null`. The GitHub binding is therefore an
untested claim until the Phase-1 dogfood runs, and acquiring `read:project` is a
precondition of that phase, not a detail inside it.

## Superseded runtime surfaces

Three surfaces predate the boundary this ADR draws. Each gets an explicit
disposition rather than a blanket removal, because their consumers differ:

| Surface | Disposition | Reason |
|---|---|---|
| `packages/core/src/thread.ts` (+ ADR 0002, `.mapctx/threads/`) | **Internalize** | Transcript and session ownership is exactly the harness territory this ADR cedes; `RunReceipt` is the replacement for any new consumer. Removed from `@mapctx/core`'s public surface (no longer re-exported, no longer usable outside this repo) and from the VS Code thread panel that consumed it. Kept as a file because the frozen `workspace-server.ts` still imports it directly — deleting it would force an unplanned change to a surface this ADR explicitly freezes. Fully deletable once `workspace-server.ts` is removed at the external-adoption gate. |
| `packages/sync-engine/src/workspace-server.ts` | **Freeze** | Contradicts the "no cockpit" thesis, but is the only host serving the workspaceV2 view — the surface the planned-versus-actual Gantt needs. No new features; revisit at the external-adoption gate. |
| `packages/opencode-plugin` | **Freeze, then remove** | Second harness bet made before Traycer was chosen as first executor. Removed at E-012 unless a user appears. |

Freeze means: no new features, no bug fixes beyond keeping the build green, and
no expansion of surface area. It is a stated position, not neglect. T-059 owns
the execution.

## Consequences

Positive:

- one live state across worktrees;
- no manually stale derived fields;
- task planning stays richer than executor ticket schemas;
- runtime providers can evolve independently;
- real actuals can calibrate Gantt time/token/cost forecasts;
- durable intent still receives Git diff and review;
- flat-rate plans still yield comparable per-task and per-epic cost;
- `@mapctx/protocol` is the executable contract: schemas, fixtures, machines, migration map.

Costs:

- DB migration and backup/export policy become necessary;
- MapCtx needs adapter and identity/link contracts;
- offline Git checkout alone no longer contains current operational status;
- projection lag and executor failures require visible diagnostics;
- v1 is single-host/single-user; a second machine or teammate diverges silently
  until a remote replica exists;
- three cost measures must be labelled everywhere, or a rated number gets
  compared to an invoiced one;
- allocation changes while a billing period is open, so any cost view must show
  whether the period is closed;
- token/cost coverage varies per harness, so cost forecasts carry lower
  confidence than duration forecasts.

## Rejected alternatives

### Keep Markdown authoritative

Rejected for live state: poor concurrency across worktrees, inefficient whole-board
queries, stale derived fields, and weak event/cost analytics.

### Make GitHub authoritative everywhere

Rejected as default: auth/scopes, network, pagination, GraphQL complexity, and
weak harness-local execution context. Supported later as explicit project mode.

### Extend or fork Traycer tickets

Rejected: current artifact schema is closed and canonical metadata lives in
Traycer's collaboration protocol. Forking creates permanent protocol/UI burden.

### Record billed cash only

Rejected: under a flat monthly plan every task reports zero, so cost per task,
cost per epic, and cost forecasting all collapse. Shadow pricing keeps the signal
without misreporting money.

### Amortize the plan fee into each run as it happens

Rejected: allocation depends on total period consumption, so per-run allocation
would rewrite itself on every new run and corrupt immutable estimate snapshots.
Allocation is computed over a `PlanPeriod` and is provisional until it closes.

### Start local-only and design sync later

Rejected: merge across hosts constrains event identity. Retrofitting it means
rewriting the store, so the `(nodeId, sequence)` rule applies now even though
sharing ships later. Engine choice, unlike event identity, is not constrained.

### Adopt a sync-capable database engine now

Rejected: it buys a service dependency for a product whose primary user is solo
on one machine, and embedded read replicas require network on every write, which
is worse than local SQLite for parallel agents. Event shipping over an
append-only log delivers the same outcome with no vendor and no default cost.

### Build complete MapCtx control plane

Rejected: duplicates Traycer, Orca, and Paperclip in agents, worktrees, sessions,
messages, and lifecycle. MapCtx will dispatch through adapters and ingest receipts.
