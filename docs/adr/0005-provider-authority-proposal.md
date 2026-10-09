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

## Decision

Adopt, subject to this ADR being accepted, **Option B: provider authority plus
a local MapCtx intelligence database**.

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
   push, bidirectional sync, cutover/import/reconcile repair, and checkpoint
   export are retired once migration completes.
6. Provider writes require a provider revision/ETag where available and an
   idempotency key. Unsupported provider capabilities fail visibly; no
   adapter silently stores the planning field locally.

The contract in the linked study is intentionally narrow: listItems,
getDependencies, setField, addComment, and timeline. Claims and receipts are
not TaskProvider methods.

## Alternatives considered

### A. Local database authority plus N-way synchronisation

Keep the current store authoritative and add richer GitHub, Linear, and Jira
sync.

- **Advantages:** offline reads/writes and one internally uniform task model.
- **Costs:** every provider needs import, export, conflict resolution,
  capability-loss policy, repair, drift detection, and migration logic.
  Status, dependencies, acceptance, comments, and user edits still have two
  possible authorities.
- **Decision:** rejected. It scales the duplicate-authority causes identified
  in the friction study and preserves the 29% authority-maintenance code
  measured in the store study.

### B. Provider authority plus local intelligence database

Provider owns planning; MapCtx owns delivery intelligence.

- **Advantages:** live collaboration in the user's task system, no
  task-state conflict resolver, and MapCtx keeps its differentiated execution
  and forecasting data.
- **Costs:** provider adapters, capability mapping, rate-limit handling, and
  an explicit offline/local-provider decision are required.
- **Decision:** proposed.

### C. GitHub only

Make GitHub Projects and Issues the sole product surface and remove
provider abstraction.

- **Advantages:** smallest initial implementation for this repository;
  existing Phase E already names explicit, exclusive GitHub source mode.
- **Costs:** hard vendor lock-in, no Linear/Jira path, no deliberate
  offline/solo mode, and no stable boundary for the non-GitHub product cases
  that the task model already anticipates.
- **Decision:** rejected. GitHub is the first implementation, not the
  architecture boundary.

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

The store study estimates about 2,560 production lines to remove, 1,500 to
replace behind a provider adapter/cache, and 4,800 to retain as MapCtx
intelligence. Outside the store, sync-engine has roughly 10,000 affected
source lines including workspace assets. Data migration is one-time:

| Planning data | Volume | Target |
| --- | ---: | --- |
| Tasks | 136 | Provider items |
| Dependencies | about 122 unique edges | Provider relations |
| Acceptance criteria | 510 | Task lists or sub-issues |
| Audit approvals | 16 with evidence | Provider comments |

Migration should begin with a read-only GitHub provider feeding existing
MapCtx plan/forecast views. After capability and identity validation, import
the planning graph once, verify provider state, disable store planning writes,
and then remove snapshot/sync machinery. Do not run a permanent N-way sync or
accept a store fallback after the cutover.

## Risks and mitigations

| Risk | Mitigation / decision needed |
| --- | --- |
| Provider rate limits, pagination, and partial outages | Page explicitly, cache reads only with freshness metadata, batch field fetches, honour provider retry hints, and surface incomplete datasets to plan/board callers. |
| Offline operation | Do not queue invisible local planning edits. Either work read-only while offline or select an explicitly configured local provider. |
| Non-atomic external field changes | Use provider revision/ETag preconditions and idempotency keys. Return conflict context for a user/provider retry. |
| Atomic executor claim across machines | Do not overload task status as a lock. Investigate a protected remote Git-ref compare-and-swap record per project/task: read expected OID, write claim payload to a new object, then update/push only if the expected ref still matches. This is a candidate design, not an accepted concurrency guarantee; it needs a multi-host race test and expiry/recovery policy. |
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
Accepting this ADR must include a dated migration plan, provider capability
matrix, one-project read-only validation, and a durable decision for each OPEN
question above before store-authority code is removed.
