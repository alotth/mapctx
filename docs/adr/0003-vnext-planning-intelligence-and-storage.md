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

### Usage ingestion from harness session stores (amended 2026-09-30)

The per-run usage data can be available on the harness host even when the
dispatch flows through Traycer: Claude Code writes per-message `usage` to
`~/.claude/projects/<slug>/<sessionId>.jsonl`, OpenCode writes per-message
`tokens` and a native `cost` to its session storage, and Codex writes
`token_count` events to `~/.codex/sessions/`. Traycer attaches to live
sessions and does not expose this data through its protocol, so MapCtx
ingests the harness session stores on that host. If the store is not
accessible, coverage remains partial or none.

Policy decisions:

- **Token-usage source hierarchy.** For the same dispatch and usage interval, prefer
  `harness-transcript` (the session store of the harness that executed the
  dispatch) over `provider-api`, then `manual` (labeled estimate); `absent`
  means no measured usage. Sources must not be added together for the same
  interval. The receipt filer supplies the session identity; the importer
  attributes records within the receipt time window and checks provider and
  model. A session shared by multiple dispatches is not counted in full for
  each. Records that cannot be attributed lower `coverage`; they never
  become fabricated usage. Repeated message records and cumulative counters
  are deduplicated or converted to deltas before aggregation.
- **Ingestion is append-only and repeatable.** A receipt is accepted only
  once, so later transcript discovery cannot rewrite its `usageEvents`.
  The importer appends a separate usage event for an existing dispatch
  attempt, before or after receipt acceptance. Its identity is stable for
  the harness session, attributed interval, model, and dispatch attempt;
  replay or retry does not add a second charge. Receipt-embedded v1 usage
  stays historical. Backfill skips attempts with usage already embedded
  unless an operator can prove the new source covers a disjoint interval.
- **Token classes are priced separately.** Provider rates differ for cache
  read, cache write, input, and output. `UsageEvent` v2 records
  `cacheReadTokens`, `cacheWriteTokens`, and `cacheUnknownTokens`. A v1
  `cacheTokens` value maps only to `cacheUnknownTokens`: v1 never recorded
  its class, so treating it as write would invent precision and overstate
  shadow cost. Existing v1 `CostEvent`s retain their recorded
  `shadowMicros`, `priceTableVersion`, and applied rate without repricing.
  If no historical cost exists and unknown cache tokens are nonzero, full
  shadow cost stays `unpriced` until the source can be classified. This
  rule also applies to new harness records with only aggregate cache usage.
- **Normalized classes do not overlap.** In v2, `inputTokens` means uncached
  input. Each token belongs to exactly one of uncached input, cache read,
  cache write, unknown cache, or output. Importers must account for harness
  fields that include cache in their input total and must leave a class
  unknown when it cannot be derived. Missing class data is not an observed
  zero.
- **Shadow pricing sums known classes.** For fully classified v2 events,
  `shadowMicros = Σ class_tokens × class_list_rate` from the price table.
  The v2 `priceTableVersion` identifies that class-rate contract;
  `appliedRateMicrosPerToken` remains the input-class rate for display.
  Historical v1 versions retain their original flat-rate meaning.
- **Billed cash requires billing evidence.** OpenCode `cost` and Claude
  headless `total_cost_usd` are harness-calculated run prices, not proof of
  an amount billed under a subscription or credits. Keep them as labeled
  estimates for comparison with shadow. Write `cashCents` with
  `costStatus: reported` only for a verifiable charge from the billing
  source; subscription-included runs have billed cash of zero. The two
  measures are never merged into one number.
- **Price table coverage.** The vendored table covers known executed
  provider/model IDs, including known `zai/glm-*` and Traycer-harness
  models. Rates are versioned by exact model and token class; a wildcard
  model name is not a price. A model outside the table yields `unpriced`
  shadow — labeled, never zero-silent.

### API charges and subscription plans

Task and epic views show billed or debited API spend, list-price shadow,
and allocated subscription fee as separate amounts. Each run identifies
the account and billing route that paid for it; model name alone cannot
distinguish an API key from a Codex or Claude Code subscription.

- **API and OpenRouter.** Token classes and a versioned model price yield
  shadow cost. When a matched OpenRouter generation has reported
  `total_cost`, use that value as the precise amount debited from OpenRouter
  credits; a provider billing record supplies any separate upstream BYOK
  charge. Do not count a credit top-up again as a task charge. Without a
  matched billing record, show only estimated shadow. An optional importer
  may fetch generation cost by ID and current model rates from OpenRouter;
  it snapshots the applied rates because the catalog can change. It must
  not infer a task from account-wide credit totals.
- **Codex and Claude Code plans.** Record the amount and dates on an
  `Account`/`PlanPeriod`, initially through the existing manual CLI. An
  optional billing import can fill the same fields when a reliable bill is
  available; it must not guess the user's paid amount from a public plan
  price. Included runs have zero per-run billed cash, measured token-based
  shadow, and a share of the period fee proportional to shadow across all
  projects bound to that account. The share is provisional until period
  close; runs without priced usage stay unattributed.
- **Precision.** API generations can cost less than one cent. Cost contract
  v2 must store reported spend in integer USD micros (or the equivalent
  `Money` minor-unit representation) before task aggregation. Legacy
  `cashCents` converts exactly to micros; rounding each generation to cents
  would silently erase small charges. Account payments and per-generation
  credit debits occupy different ledger levels so rollups do not add both.

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
activeTime       = union of agent-owned gaps < threshold default 10 min
humanTime        = union of review + human-owned waits
parkedTime       = union of parked waits                  separate from humanTime
taskDuration     = union of session intervals           not max - min
leadTime         = readyAt -> doneAt                    calendar, includes waiting
```

Gantt displays wall clock and lead time. P50/P90 forecasting uses `activeTime`.
The idle threshold is configuration and is recorded in every estimate's
provenance.

### Interval ownership (T-100, 2026-10-01)

Claude Code JSONL rows provide `timestamp`, `sessionId`, `type`, and `uuid`.
Only a real user text message starts an agent turn; `user` rows containing
`tool_result` alone stay inside that turn. Assistant `end_turn` returns
ownership to the human. Agent gaps at or above the configured idle threshold
are excluded from active time. End of assistant turn to next real prompt is
human-owned: up to 15 minutes is inferred `review`, 15 minutes to 2 hours is
`human`, and over 2 hours or crossing a day in the configured time zone is
`parked`. These are time classes, not proof of productive human work. The
optional task `waitReason` (`review|decision|parked|blocked-external`) records
human context without overriding observed timestamps.
When timestamp-only activity from another session overlaps a parked wait,
its classification confidence becomes `corroborated`; otherwise it stays
`inferred`. This does not assert that the human worked on the current task.

`RunReceipt.timeEvidence` version 1 holds only start/end timestamps, owner,
kind, session ID, and policy thresholds/time zone. Transcript text and tool
content never enter receipts or the store. Old receipts remain valid and show
`substituted` coverage; empty, malformed, or out-of-bounds evidence cannot
claim measured coverage. Overlapping sessions are unioned once: agent wins
cross-owner collisions; within human intervals parked wins over human and
review. Raw session correlation and project-wide backfill belong to T-101.
Traycer child-agent session messages are excluded here: orchestrator and child
messages do not reliably identify genuine human prompts, so treating them as
human wait boundaries would misattribute ownership.

### Planned effort convention (T-099, 2026-09-30)

`estimatedEffort` is a declared **agent active-time** plan for every new value:
`1d = 8` agent-active hours and `1w = 5d = 40` agent-active hours. It uses the
same `activeTime` unit as P50/P90 forecasting; it excludes human answer waits,
review queues, parked sessions, and other lead/wall time. Those remain separate
`leadTime` and wall-clock measures.

The parser accepts decimal `m`, `h`, `d`, and `w` values (for example `0.5d`,
`1d`, `1w`). An invalid value is no plan, never a guessed duration. Existing
values are not reinterpreted: absence of `estimatedEffortSource: agent-active`
marks an estimate `legacy-human` when shown beside actuals. A newly created or
edited estimate emits that source marker. This preserves the historical human
working-day meaning while keeping future forecast comparisons unit-consistent.

When a completed task has neither valid effort nor dates but has a receipt,
Gantt may display a retrospective planned value with
`plannedSource: aligned-from-actual`. Its planned-vs-actual ratio is excluded
from accuracy/calibration because it would be trivially one. A completed task
without a receipt is `no measurement`, not zero duration, and contributes no
duration-pool sample. Receipt-only active time remains `substituted`; it must
never be displayed as measured active time.

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
- Snapshot inspection recomputes canonical Markdown from current store state
  and compares it with on-disk files. This is explicit via
  `mapctx validate --snapshots`; operational `mapctx validate` does not read
  snapshots. A good-faith manual edit can be accepted/discarded with
  `mapctx reconcile <task-id>`, which records accepted fields with
  `source: manual-reconcile` provenance. Silent merge is never an option.
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

**Checkpoint timing.** `mapctx export` is explicit. `mapctx task finish <id>`
publishes a final task or epic checkpoint after the canonical done gate.
`wave-end` is a reason label only; automatic wave-end export requires a wave
controller and remains unimplemented. No routine claim/start/update/receipt/move
operation rewrites mirrors.

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

### T-120 implementation amendment (2026-10-05)

For `plansAuthority = "store"`, operational `mapctx validate` reads identity
configuration and canonical store projections through a read-only handle. It
does not read local `TASKS.md` or task detail mirrors. Schema/journal maintenance
is returned explicitly. `mapctx validate --snapshots` separately checks local
mirror structure and drift. Markdown-authority validation remains unchanged.

Acceptance criteria and approval state are event-backed store data. Explicit
`mapctx acceptance import` maps observed `[x]` items to `import-observed` and
unchecked items to pending, records source-byte SHA-256, and is dry-run unless
`--commit` is passed. `mapctx task acceptance revise|approve|unapprove` edits
store state; a new revision resets all criteria to pending. Planning `done` is
never used to infer approval.

Routine task, budget, and receipt mutations no longer regenerate local mirrors.
`mapctx export` remains explicit; `mapctx task finish <id>` uses the canonical
completion gate and then publishes the task or epic checkpoint. File publication
uses per-file temporary writes and renames, so a multi-file checkpoint is not
globally atomic. Partial publication returns failure and records no checkpoint;
retry after accepted completion does not add another completion event. `wave-end`
is an explicit reason label only; there is no automatic wave controller.

A checkpoint records exported file hashes, event cursor, and captured Acceptance
revisions from one consistent store read. It is not a complete backup of event
journals, receipts, evidence, corrections, or attestations. Git-authored task
description prose also remains outside store recovery. See
`docs/reviews/t120-store-validation-checkpoints-2026-10-05.md` for implementation
and verification details.
