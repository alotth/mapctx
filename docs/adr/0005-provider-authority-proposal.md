# ADR 0005: Provider authority with a local intelligence database

- Status: Proposed
- Date: 2026-10-09
- Related: [provider-authority study](../engineering/provider-authority-study.md)

## Context

ADR 0003 chose a local store as canonical planning authority and generated
TASKS.md/detail snapshots for Git compatibility. ADR 0004 made the one-time
Markdown-to-store transfer fail closed. That design avoids stale worktrees, but
it now duplicates the planning system users already operate in GitHub, Linear,
or Jira.

The measured store map has 136 task projections, about 122 unique dependency
edges, and 510 acceptance criteria. About 47% of its observed events are task
or acceptance authority; 51% are MapCtx coordination and history; 2% are
checkpointing. The agent-friction analysis attributes 12 of 22 reported
problems to snapshots/version control and acceptance ceremony, both symptoms
of duplicate task authority.

MapCtx still has a distinct role: resource claims, dispatch attempts,
run receipts, session attribution, privacy/redaction, scheduling, forecast,
budget, and cost. These data are not interchangeable with an issue tracker.

## Proposal

This ADR remains an operator decision while its status is Proposed. It presents
**Option B: provider authority plus a local MapCtx intelligence database** as a
candidate, alongside the lower-cost A0 alternative below. B is preferred only
if provider-native planning and collaboration are worth its adapter, binding,
and availability costs; this ADR does not settle that trade-off in advance.

If the operator selects B, the resulting decision is:

1. A selected TaskProvider is the single canonical source for task-planning
   fields: task identity, title/body/summary, status, type, parent,
   priority, labels/tags, dates, iteration, assignees, milestone, role,
   impact, acceptance representation, dependencies, and discussion.
2. MapCtx reads those fields live through a provider adapter. It may keep a
   disposable read cache, but never a second writable/canonical task copy.
3. MapCtx retains a local database for coordination and intelligence:
   resource claims, dispatches, run receipts, history evidence/corrections,
   privacy events, resource-conflict feedback, derived schedules/forecasts,
   usage, cost, estimates, budgets, and provider-ID bindings.
4. MapCtx uses provider-native task lists, sub-issues, or comments for
   acceptance. Explicit approval evidence and receipt summaries may be posted
   as provider comments while the receipt itself remains a MapCtx record.
5. TASKS.md generation, task-detail structured snapshots, store-to-provider
   push, bidirectional sync, cutover/import/reconcile and mirror repair, and checkpoint
   export are retired once migration completes.
6. Provider writes require a provider revision/ETag where available and a
   caller correlation ID. Unsupported provider capabilities, freshness, and
   partial data fail or surface visibly; no adapter silently stores a planning
   field locally.

The linked contract covers live reads, item creation, typed field writes,
dependency add/remove, criterion state, close/reopen, comments, and timeline.
Claims and receipts are intentionally not TaskProvider methods.

## Alternatives considered

### A0. Store authority, snapshots retired

Keep the current local store as planning authority, but stop regenerating
TASKS.md and structured tasks/*.md blocks. Description prose either moves into
the store or remains plain Git prose with no structured task block. This is not
N-way synchronisation: provider systems are optional projections or links, not
co-authorities.

- **Advantages:** removes R1 snapshot/version-control friction (5 of 22
  reports), avoids a provider adapter and the one-time migration of 136 items,
  and removes most mirror/sync machinery: checkpoint.ts (281), store export
  (232), drift (130), reconcile (211), sync.ts (927), and push-store.ts
  (503), about 2,284 currently counted lines before shared/core slices.
- **Costs:** R3 acceptance ceremony remains (7 reports), planning still happens
  through MapCtx's store/CLI rather than the team's live provider, and a local
  canonical store still needs task-authority schema, migration, and
  collaboration operations.
- **Decision:** credible low-cost alternative, not a foil. Choose it when
  eliminating generated-file churn is the goal and provider-native planning is
  not. B remains preferable only when removing both R1 and R3, and using the
  provider as the shared planning surface, justifies its added cost.

### A. Local database authority plus N-way synchronisation

Keep the current store authoritative and add richer GitHub, Linear, and Jira
sync.

- **Advantages:** offline reads/writes and one internally uniform task model.
- **Costs:** every provider needs import, export, conflict resolution,
  capability-loss policy, repair, drift detection, and migration logic.
  Status, dependencies, acceptance, comments, and user edits still have two
  possible authorities.
- **Decision:** not recommended unless simultaneous multi-provider writes are
  an explicit product requirement. It scales duplicate-authority conflicts and
  is materially more complex than A0.

### B. Provider authority plus local intelligence database

Provider owns planning; MapCtx owns delivery intelligence.

- **Advantages:** live collaboration in the user's task system, no
  task-state conflict resolver, and MapCtx keeps its differentiated execution
  and forecasting data.
- **Costs:** provider adapters, capability mapping, rate-limit handling, and
  an explicit offline/local-provider decision are required.
- **Decision:** candidate; operator decision remains open against A0.

### C. GitHub only

Make GitHub Projects and Issues the sole product surface and remove
provider abstraction.

- **Advantages:** smallest initial implementation for this repository;
  existing Phase E already names explicit, exclusive GitHub source mode.
- **Costs:** hard vendor lock-in, no Linear/Jira path, no deliberate
  offline/solo mode, and no stable boundary for the non-GitHub product cases
  that the task model already anticipates.
- **Decision:** not selected as the architecture baseline. GitHub is the first
  implementation, not the permanent boundary.

## Consequences

### Positive

- One task field has one owner, so provider edits appear immediately and no
  mirror-reconciliation ceremony is needed.
- TASKS.md and structured task files cease to be mutable planning surfaces,
  removing branch churn and generated-file conflicts.
- Acceptance uses the provider's visible native affordance.
- MapCtx can focus investment on claims, execution evidence, redaction,
  scheduling, forecast, cost, and history attribution.
- A provider-neutral contract keeps GitHub first without making it permanent.

### Negative

- MapCtx task views require provider connectivity and must expose stale,
  paginated, rate-limited, or unavailable data honestly.
- Provider schemas differ. Some fields need project configuration or an
  explicit unsupported-capability error rather than a hidden local fallback.
- Migration has a clear cutover point; there is no dual-write comfort phase.
- Claims need a durable cross-machine coordination strategy independent of
  the selected provider.

### Migration size

The original store map counted 2,560 lines as removable, 1,500 as adapter/cache
replacement, and 4,800 as retained MapCtx intelligence. That removal headline
needs a durability correction: identity (159) and maintenance (115) protect the
retained M event log; attestation (438) remains M if telemetry/history requires
durable integrity evidence. The D range is therefore 1,848 to 2,286 store lines,
with M correspondingly 5,074 to 5,512 lines. That range still counts
`repair.ts` (308) as D, although part of it replays the retained M events; if
it all stays M the ranges become D 1,540 to 1,978 and M 5,382 to 5,820 (split
unmeasured, see the study). Core Markdown parsing (365) and
task-detail handling (786) require separate retirement/redesign. Shared
sync-engine UI source is apportioned between provider task surfaces and MapCtx
overlays in the study; its full file sizes are not additive migration estimates.

Data migration is one-time:

| Planning data | Volume | Target |
| --- | ---: | --- |
| Tasks | 136 | Provider items |
| Dependencies | about 122 unique edges | Provider relations |
| Acceptance criteria | 510 | Task lists or sub-issues |
| Audit approvals | 16 with evidence | Provider comments |
| Retained M references | 136 bindings; 158 claims, 162 attempts, 104 receipts, 42 history records | Provider-ID binding and re-key/join migration before store planning writes stop |

Migration should begin with a read-only GitHub provider feeding existing
MapCtx plan/forecast views. After capability and identity validation, import
the planning graph once, verify provider state, disable store planning writes,
and then remove snapshot/sync machinery. Do not run a permanent N-way sync or
accept a store fallback after the cutover.

The first slice must also prove the dependency mapping. No current MapCtx or
Orca GitHub code reads GitHub issue dependencies, so the inferred 122-edge
mapping is not yet a reference implementation. It must verify relation reads
and add/remove semantics before a one-to-one blocked-by claim is accepted.

## Risks and mitigations

| Risk | Mitigation / decision needed |
| --- | --- |
| Provider rate limits, pagination, and partial outages | Page explicitly, cache reads only with freshness metadata, batch field fetches, honour provider retry hints, and surface incomplete datasets to plan/board callers. |
| Offline operation | Do not queue invisible local planning edits. Either work read-only while offline or select an explicitly configured local provider. |
| Non-atomic external field changes | Use provider revision/ETag preconditions, caller correlation, and read-after-write verification. GitHub clientMutationId is only correlation, not durable de-duplication; return conflict context for a user/provider retry. |
| Atomic executor claim across machines | Do not overload task status as a lock. Candidate: a protected remote Git-ref compare-and-swap record per project/task—read expected OID, write claim payload to a new object, update/push only if the expected ref still matches. This is not an accepted concurrency guarantee; it needs multi-host race, expiry, and recovery tests. The decision remains OPEN and must align with T-124 section 8.2; whichever ADR is accepted first fixes the other proposal. |
| Provider lacks a field or relation | Make capability mapping explicit in project configuration. Block or degrade the affected feature visibly; never encode an untracked local substitute. |
| Local intelligence DB loss | Define which M events require durable backup/journaling and which can be reconstructed from provider timeline plus receipts. |
| Historical ADR confusion | Preserve ADR 0003 and 0004 unchanged as history. If this proposal is accepted, add their supersession note rather than rewriting their recorded decisions. |

## Open questions

- **OPEN — telemetry durability:** Must receipts, history evidence, usage, cost,
  and forecast inputs be independently durable, or can some be reconstructed
  from provider comments/timeline and harness history?
- **OPEN — workload and domains:** Are workload, domains, estimated effort,
  and affected files provider-visible custom fields, MapCtx-only intelligence
  fields, or a documented split by field?
- **OPEN — local provider:** Do we retain a first-class local provider for
  solo/offline work? If yes, what persistence, backup, and collaboration
  guarantees does it make without recreating N-way sync?
- **OPEN — claim CAS:** Is protected Git-ref compare-and-swap acceptable for
  cross-machine claims, or is a small shared coordination service required?
- **OPEN — provider baseline:** Is GitHub the only implementation required
  for the first release, with Linear/Jira compiled against the contract but
  deferred, or must their capability maps ship in the same release?

## Status transition

While Proposed, ADR 0003 and ADR 0004 remain the active authority decision.
The operator must choose A0 or B explicitly. Accepting B must include a dated
migration plan, provider capability matrix, one-project read-only validation,
and a durable decision for each OPEN question above before store-authority code
is removed. Selecting A0 must instead specify the no-snapshot boundary and the
remaining store-authority/acceptance improvements.
