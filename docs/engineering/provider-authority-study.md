# Provider-authority study

**Date:** 2026-10-09
**Status:** input to ADR 0005
**Scope:** Option B — task provider owns planning facts; MapCtx owns delivery intelligence.

## Recommendation

Option B removes duplicated planning authority without removing MapCtx's
product value. The selected provider owns task identity, task fields,
dependencies, acceptance representation, and task discussion. MapCtx reads
them live through an adapter and stores only coordination and derived delivery
facts.

This is explicitly not bidirectional synchronisation. Every planning field has
one authority: the provider. A local read cache may be disposable; it must not
accept writes as canonical task state.

## Evidence and baseline

Source: *Store map for Option B: provider authority, MapCtx intelligence*,
2026-10-09 (Traycer artifact store-provider-authority-map/index.md). It
examined commit ea6a52e and the real project database. Key figures are copied
below so this document remains useful without Traycer.

| Store area | Measured count | Class | Option B disposition |
| --- | ---: | --- | --- |
| Task projection | 136 tasks | P/M | Provider: title, state, type, parent, priority, dates, tags, iteration, assignees, milestone. MapCtx: workload, domains, spec mode, predictions. |
| Task detail projection | count not separately measured | P/M | Provider: summary, role, impact, dependencies. MapCtx: effort provenance, affected files, wait reason. |
| Dependency projection | 207 rows / about 122 inferred unique edges | P | Candidate mapping to provider blocked-by relations after removing 85 mirrored pairs; first slice must prove provider support. |
| Acceptance revisions and criteria | 510 criteria | P | Provider task list or sub-issues replace checklists. The 16 approvals with approver/evidence become provider comments. |
| Resource claims | 158 rows | M | Executor leases and collision avoidance. |
| Dispatches / receipts | 162 / 104 rows | M | MapCtx execution-attempt and measured-delivery facts. |
| Usage / cost / estimates | 7 / 0 / 0 rows | M | Telemetry and forecast inputs, not task authority. |
| Export checkpoints | 23 rows | D | Exist only to materialise TASKS.md and task mirrors. |

Observed events agree with this split: 319 task patches plus 136 upserts and
134 acceptance events move to the provider; 333 claim lifecycle events, 162
dispatch attempts, 104 receipt events, and 42 history events remain MapCtx.
Of 1,255 observed events, about 47% are planning authority, 51% coordination
or history, and 2% checkpointing.

The original store-map classification totals about 8,860 production lines
excluding tests. Its D figure treated identity, attestation, and maintenance as
store-authority machinery. That is too broad once an M event log remains.

| Class | Approx. production lines | Store modules measured |
| --- | ---: | --- |
| P — replace behind provider adapter/cache | 1,500 (17%) | tasks (640), acceptance (433), about 450 task/dependency/acceptance projection lines |
| M — retain | 5,074 to 5,512 (57–62%) | original M set (4,800), plus identity (159) and maintenance (115); retain attestation (438) when telemetry/history needs independently durable integrity evidence |
| D — retire | 1,848 to 2,286 (21–26%) | cutover, import, snapshot/mirror repair, export, reconcile, drift, snapshot validation; the high end retires attestation only if the telemetry-durability decision permits reconstruction. `repair.ts` (308) is counted as D here but is not purely mirror repair — see below |

This is a decision-sensitive range, not an estimate error. Node identity and
maintenance protect the retained local event log and are M in both cases.
Attestation is M if retained telemetry/history needs byte-level witness
integrity; otherwise it can be D. The OPEN telemetry-durability decision
therefore fixes the final removal figure.

`repair.ts` (308) is a split module, not a clean D. Its mirror/snapshot repair
is D, but `repair.ts:75–159` also validates the journal, watermarks, and
attestations and rebuilds the database by replaying every event, including the
retained M events (claims, receipts, history). The line split inside the module
was not measured. If the operator requires independent durability for M, the
event-log validation and replay part stays M, or a defined substitute (provider
comment reconstruction, or backup/restore) must replace it before the removal
figure becomes a commitment. Bounding cases: all 308 lines D gives the ranges
above; all 308 lines M gives D 1,540 to 1,978 and M 5,382 to 5,820 (P stays
1,500, totals still 8,860). Measuring the split is a first-slice task.

The associated agent-friction study found snapshot/version-control friction and
acceptance ceremony account for 12 of 22 reports. Both become provider
concerns. Lease, redaction, and planner conflicts remain MapCtx concerns.

## Classification

| Class | Meaning |
| --- | --- |
| **P** | Provider-owned planning data or UI. Replace current authority code with TaskProvider calls or direct provider views. |
| **M** | MapCtx coordination, telemetry, history attribution, forecasting, cost, or intelligence presentation. It may read provider data but never owns provider fields. |
| **D** | Store/Markdown-mirror authority or synchronisation machinery. Remove after migration. |

### packages/sync-engine

Counts exclude tests unless named. Split rows identify a source slice rather
than pretending mixed entry points have one owner.

| Class | Work estimate / source lines | Paths | Disposition |
| --- | ---: | --- | --- |
| D | 281 | packages/sync-engine/src/checkpoint.ts | Generates TASKS.md and task-detail mirrors; retire with checkpoints. |
| D | 1,080 | packages/sync-engine/src/sync.ts (927), packages/sync-engine/src/markdown.ts (1), packages/sync-engine/src/legacy-sync-guard.ts (55), about 100 relevant lines in config.ts/statuses.ts | Markdown/GitHub reconciliation and compatibility guard have no role after live provider reads. |
| D | 503 | packages/sync-engine/src/push-store.ts | Current store-to-GitHub projection starts from store authority; it is not the replacement adapter. |
| P | about 4,800 rework / 7,891 source | packages/sync-engine/src/board-view.ts (152), packages/sync-engine/src/board-tools.ts (663), packages/sync-engine/src/workspace-ui/workspaceV2.js (3,347), packages/sync-engine/src/workspace-ui/workspaceV2.html (164), packages/sync-engine/src/workspace-ui/workspaceV2.css (3,565) | Rework task-card reads and moves to provider calls. Full UI assets are shared source; this is not a claim that all 7,891 lines move unchanged. |
| M | about 4,100 rework / 1,890 dedicated + about 2,210 shared UI source | packages/sync-engine/src/workspace-server.ts (835), packages/sync-engine/src/gantt.ts (794), packages/sync-engine/src/budget-cli.ts (261), intelligence-overlay slices of packages/sync-engine/src/workspace-ui/ | Retain only claim, forecast, variance, and cost intelligence. About 880 shared/UI-shell lines stay neutral or are deleted after product design. |
| M | 1,057 | packages/sync-engine/src/history-cli.ts | Keep measured/inferred session history. Provider timeline is an input, not replacement. |
| P/M/D | 1,785 | packages/sync-engine/src/mapctx-cli.ts | Provider task commands are P; plan/gantt/history/budget/claim/dispatch are M; import/export/sync are D. |
| P | 459 | packages/sync-engine/src/github.ts | Reuse as first GitHub adapter transport: issue/project-item identity, field writes, pagination, and scope diagnostics. It is a starting transport, not evidence that dependency relations are already implemented. |
| P/M | 409 | packages/sync-engine/src/cli.ts (149), packages/sync-engine/src/types.ts (150), packages/sync-engine/src/utils.ts (52), packages/sync-engine/src/budget-cli-support.ts (58) | Split command/config/type wiring: provider task surfaces are P; generic CLI and budget support remain M. |

A MapCtx workspace may render provider-backed cards with forecast or claim
overlays. A plain Kanban is provider UI, not a second MapCtx task board.

### packages/core Markdown boundary

| Class | Work estimate / source lines | Paths | Disposition |
| --- | ---: | --- | --- |
| D | 365 | packages/core/src/markdown.ts | Parser, serializer, board writer, and detail-file creation serve the retired Markdown mirror. |
| P/D | 786 | packages/core/src/task-detail.ts | Structured task fields retire with the mirror. Its authored-description boundary must either move to the provider (P) or remain plain Git prose with no structured block under A0; it is not silently retained as a second task record. |

### skills and rules

| Class | Work estimate / source lines | Paths | Disposition |
| --- | ---: | --- | --- |
| P | about 528 | skills/mapctx-tasks/SKILL.md (123); references/bootstrap-and-templates.md (145), field-types-and-contract.md (157), custom-statuses.md (51), status-and-sync.md (52) | Rewrite around provider fields, relations, creation, and provider acceptance. |
| D | about 402 | skills/mapctx-tasks/references/cutover-to-store.md (70); skills/mapctx-sync-engine/SKILL.md (84) plus five references (248) | Remove store cutover, Markdown canonicalisation, push, and reconcile workflow. |
| M | about 570 | skills/mapctx-plan-engine/ (144), mapctx-traycer/SKILL.md (130), mapctx-correct-course/ (120), mapctx-enrich-task/ (118), skills/README.md (58) | Retain planning, execution evidence, and intelligence workflow; route P and M writes separately. |
| P/M | 42 | rules/AGENTS.md (21), rules/CLAUDE.md (21) | Replace snapshot-authority language; retain claim, receipt, privacy, and execution rules. |

### Documentation

| Class | Work estimate / source lines | Paths | Disposition |
| --- | ---: | --- | --- |
| P | about 80 rewrite / 241 source | README.md (69), docs/README.md (96), docs/ROADMAP.md Phase E (76-92), docs/PROJECT.md (76) | Rewrite authority and daily flow around selected provider and live reads. Phase E already requires explicit, exclusive GitHub source mode; generalise it to provider selection. |
| M | about 160 work / 161 source | docs/methodology.md (161), future provider-operation guide, this study | Keep methodology and document joins from provider task IDs to MapCtx delivery data. |
| M (historical) | 617 | docs/adr/0003-vnext-planning-intelligence-and-storage.md (573), docs/adr/0004-cutover-refuses-lossy-imports.md (44) | Keep accepted ADRs unchanged as history. ADR 0005 supersedes authority direction only if accepted. |
| D | 100+ | store-cutover, mirror-recovery, and reconciliation procedures in current operational docs | Remove procedures after migration. Immutable review evidence remains historical evidence, not live instruction. |

## TaskProvider contract sketch

The contract covers P fields and intentionally excludes claims, dispatches,
receipts, forecasts, and cost. Implementations map generic fields to native
fields, labels, relations, task lists, or comments. They expose both static
capabilities and capabilities discovered from a failed provider write.

~~~ts
type ProviderKind = 'github' | 'linear' | 'jira' | 'local'
type Revision = string
type ProviderRelationKind = 'blocks' | 'blocked-by' | 'relates-to'

type ProviderOwnedField =
  | 'title' | 'body' | 'planningState' | 'type' | 'parent' | 'priority'
  | 'tags' | 'startDate' | 'dueDate' | 'completedOn' | 'iteration'
  | 'assignees' | 'milestone' | 'summary' | 'role' | 'impact'

interface ProviderItemRef {
  provider: ProviderKind
  // GitHub issue/Linear issue/Jira issue identity: title and body live here.
  workItem: { id: string; key: string; url: string }
  // Optional because a provider item can exist outside a project. In GitHub
  // this is distinct from workItem.id and identifies a Project V2 item.
  projectItem?: { projectId: string; itemId: string }
}

type FieldRef =
  | {
      semantic: ProviderOwnedField
      surface: 'work-item'
      providerFieldId?: string
    }
  | {
      semantic: ProviderOwnedField
      surface: 'project-item'
      // GitHub Project write: project id + item id + field id; option or
      // iteration id is resolved for the provider-specific field value.
      projectId: string
      projectItemId: string
      providerFieldId: string
      optionId?: string
    }

interface ProviderItem {
  ref: ProviderItemRef
  revision: Revision
  fields: Partial<Record<ProviderOwnedField, unknown>>
}

interface ProviderDependency {
  from: ProviderItemRef
  to: ProviderItemRef
  kind: ProviderRelationKind
  revision?: Revision
}

interface ProviderCriterion {
  id: string
  item: ProviderItemRef
  text: string
  state: 'pending' | 'complete'
  revision?: Revision
}

type ProviderError =
  | { kind: 'rate-limited'; message: string; retryAfter?: string }
  | { kind: 'auth'; message: string }
  | { kind: 'not-found'; message: string }
  | { kind: 'unsupported'; message: string; capability?: string }
  | { kind: 'conflict'; message: string; currentRevision?: Revision }
  | { kind: 'transient'; message: string; retryAfter?: string }

type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderError }

interface Page<T> {
  items: T[]
  nextCursor?: string
  freshness: {
    fetchedAt: string
    source: 'live' | 'cache'
    stale: boolean
    partial: boolean
    omitted?: string[]
  }
}

interface ProviderCapabilities {
  fields: Partial<Record<ProviderOwnedField, {
    read: boolean
    write: boolean
    discoveredAtWrite?: boolean
  }>>
  relations: Partial<Record<ProviderRelationKind, { read: boolean; write: boolean }>>
  comments: { read: boolean; write: boolean }
  criteria: { read: boolean; write: boolean }
  timeline: { read: boolean }
}

interface ProviderTimelineEvent {
  id: string
  item: ProviderItemRef
  occurredAt: string
  actor?: string
  kind: 'created' | 'field-changed' | 'comment' | 'relation-changed'
  revision?: Revision
  payload?: Record<string, unknown>
}

interface TaskProvider {
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilities

  listItems(input: {
    project: string
    cursor?: string
    updatedAfter?: string
    includeClosed?: boolean
    fields?: readonly ProviderOwnedField[]
  }): Promise<ProviderResult<Page<ProviderItem>>>

  getItem(input: { ref: ProviderItemRef }): Promise<ProviderResult<ProviderItem>>
  getProject(input: { project: string }): Promise<ProviderResult<{
    id: string
    title?: string
    notes?: string
    revision?: Revision
  }>>
  setProjectField(input: {
    project: string
    field: 'title' | 'notes'
    value: string
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<{ id: string; revision?: Revision }>>

  createItem(input: {
    project: string
    initialFields: Partial<Record<ProviderOwnedField, unknown>>
    clientOperationId: string
  }): Promise<ProviderResult<ProviderItem>>

  getDependencies(input: {
    items: readonly ProviderItemRef[]
  }): Promise<ProviderResult<ProviderDependency[]>>

  addDependency(input: {
    from: ProviderItemRef
    to: ProviderItemRef
    kind: ProviderRelationKind
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<ProviderDependency>>

  removeDependency(input: {
    from: ProviderItemRef
    to: ProviderItemRef
    kind: ProviderRelationKind
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<void>>

  setField(input: {
    item: ProviderItemRef
    field: FieldRef
    value: unknown
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<ProviderItem>>

  listCriteria(input: {
    item: ProviderItemRef
    cursor?: string
  }): Promise<ProviderResult<Page<ProviderCriterion>>>

  setCriterionState(input: {
    criterion: ProviderCriterion
    state: ProviderCriterion['state']
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<ProviderCriterion>>

  closeOrReopen(input: {
    item: ProviderItemRef
    state: 'open' | 'closed'
    reason?: 'completed' | 'not-planned' | 'cancelled' | 'archived'
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<ProviderItem>>

  addComment(input: {
    item: ProviderItemRef
    body: string
    expectedRevision?: Revision
    clientOperationId: string
  }): Promise<ProviderResult<{ commentId: string; revision?: Revision }>>

  timeline(input: {
    item: ProviderItemRef
    cursor?: string
    since?: string
  }): Promise<ProviderResult<Page<ProviderTimelineEvent>>>
}
~~~

FieldRef makes GitHub's distinct issue, Project V2 item, field, and option
identities explicit. The adapter resolves and refreshes those references per
project; an invalidated mapping returns a visible conflict or unsupported
result rather than writing a local substitute.

Acceptance text and current criterion state are P through listCriteria and
setCriterionState. Per-criterion approval evidence for the 16 audited
approvals remains M when the provider cannot represent it; MapCtx records that
evidence against the provider criterion ID and posts a provider comment.

closeOrReopen is the lifecycle operation. The contract intentionally has no
hard-delete operation: migration mistakes are closed/archived with an audit
trail and provider user content is not silently destroyed.

clientOperationId is caller correlation, not a promise of provider
idempotency. GitHub clientMutationId is only an echoed correlation value, not
a durable de-duplication guarantee. Retry safety therefore requires
read-after-write verification of the expected field/relation/criterion change
and revision comparison before retrying an ambiguous failure.

The local provider is explicit, not an implicit fallback. If accepted, it
implements this same contract for solo/offline work and must not reintroduce
store-plus-provider synchronisation.

## Migration size and first slice

| Work | Measured scope | Required migration outcome |
| --- | --- | --- |
| Retire authority/mirror code | 1,848 to 2,286 store lines, depending on telemetry durability; plus 365 core Markdown lines and the 786-line task-detail redesign | Remove snapshots and sync without deleting retained event-log integrity. |
| Replace planning authority | about 1,500 store lines | Provider adapter/cache replaces store-owned planning reads and writes. |
| Rework views/CLI | shared source slices are shown in the tables above, not a false additive total | Provider-backed task cards join MapCtx-only intelligence. |
| M identity binding | 136 task bindings; 158 claims, 162 dispatch attempts, 104 receipts, and 42 history evidence/correction records currently use task_id | Create immutable provider bindings and re-key or join every retained M record before planning-store writes stop. Rebuild active-claim and history indexes on that binding. |
| Planning data | 136 tasks, about 122 inferred unique edges, 510 criteria, 16 audit approvals | Import once to provider items, relations, criteria, and audit comments. |

The dependency count is not proof of a GitHub mapping. No MapCtx or Orca
GitHub implementation currently reads GitHub issue dependencies; getDependencies
has no reference implementation. The first slice must discover the supported
GitHub relation API, prove read and add/remove behaviour, and record any
non-isomorphic mapping before claiming that blocked-by is one-to-one.

First vertical slice: a read-only GitHub TaskProvider for one project feeding
the existing plan/forecast view while all edits continue in GitHub. It tests
ProviderItemRef/FieldRef resolution, pagination/freshness, capability and
rate-limit behaviour, provider-ID bindings, and the relation-read gap before
any authority code is removed.

### Claim coordination remains open

The candidate for cross-machine claims is a protected remote Git-ref
compare-and-swap record per project/task: read expected OID, write a claim
payload to a new object, then update/push only if the expected ref still
matches. It needs multi-host race, expiry, and recovery tests. This is not an
accepted concurrency guarantee. The claim-CAS decision remains OPEN and must
align with T-124 section 8.2; whichever ADR is accepted first fixes the other
proposal's answer.

## Non-goals

- Do not add a writable local task cache.
- Do not retain GitHub/Markdown/store bidirectional synchronisation.
- Do not move claims, receipts, telemetry, forecasts, budgets, or cost into a
  task provider.
- Do not promise offline edits unless the local-provider question is accepted.
