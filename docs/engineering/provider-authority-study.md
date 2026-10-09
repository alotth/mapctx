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
| Task detail projection | 136 details | P/M | Provider: summary, role, impact, dependencies. MapCtx: effort provenance, affected files, wait reason. |
| Dependency projection | 207 rows / about 122 unique edges | P | Map once to provider blocked-by relations after removing 85 mirrored pairs. |
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

| Class | Approx. production lines | Store modules measured |
| --- | ---: | --- |
| P — replace behind provider adapter/cache | 1,500 (17%) | tasks (640), acceptance (433), about 450 task/dependency/acceptance projection lines |
| M — retain | 4,800 (54%) | claims, dispatch, history, budget, violations, context, events, journal, schema, config, derived validation |
| D — retire | 2,560 (29%) | cutover, attestation, import, repair, export, reconcile, identity, drift, maintenance, snapshot validation |

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

| Class | Approx. lines | Paths | Disposition |
| --- | ---: | --- | --- |
| D | 281 | packages/sync-engine/src/checkpoint.ts | Generates TASKS.md and task-detail mirrors; retire with checkpoints. |
| D | 1,080 | packages/sync-engine/src/sync.ts (927), packages/sync-engine/src/markdown.ts (1), packages/sync-engine/src/legacy-sync-guard.ts (55), about 100 relevant lines in config.ts/statuses.ts | Markdown/GitHub reconciliation and compatibility guard have no role after live provider reads. |
| D | 503 | packages/sync-engine/src/push-store.ts | Current store-to-GitHub projection starts from store authority; it is not the replacement adapter. |
| P | about 4,800 | packages/sync-engine/src/board-view.ts (152), packages/sync-engine/src/board-tools.ts (663), packages/sync-engine/src/workspace-ui/workspaceV2.js (3,347), workspaceV2.html (164), workspaceV2.css (3,565) | Rework card fields and moves to provider reads/writes. |
| M | about 4,100 | packages/sync-engine/src/workspace-server.ts (835), intelligence-overlay portions of packages/sync-engine/src/workspace-ui/, packages/sync-engine/src/gantt.ts (794), packages/sync-engine/src/budget-cli.ts (261) | Retain a MapCtx view only where it adds claim, forecast, variance, or cost intelligence. |
| M | 1,057 | packages/sync-engine/src/history-cli.ts | Keep measured/inferred session history. Provider timeline is an input, not replacement. |
| P/M/D | 1,785 | packages/sync-engine/src/mapctx-cli.ts | Provider task commands are P; plan/gantt/history/budget/claim/dispatch are M; import/export/sync are D. |

A MapCtx workspace may render provider-backed cards with forecast or claim
overlays. A plain Kanban is provider UI, not a second MapCtx task board.

### skills and rules

| Class | Approx. lines | Paths | Disposition |
| --- | ---: | --- | --- |
| P | about 528 | skills/mapctx-tasks/SKILL.md (123); references/bootstrap-and-templates.md (145), field-types-and-contract.md (157), custom-statuses.md (51), status-and-sync.md (52) | Rewrite around provider fields, relations, creation, and provider acceptance. |
| D | about 402 | skills/mapctx-tasks/references/cutover-to-store.md (70); skills/mapctx-sync-engine/SKILL.md (84) plus five references (248) | Remove store cutover, Markdown canonicalisation, push, and reconcile workflow. |
| M | about 570 | skills/mapctx-plan-engine/ (144), mapctx-traycer/SKILL.md (130), mapctx-correct-course/ (120), mapctx-enrich-task/ (118), skills/README.md (58) | Retain planning, execution evidence, and intelligence workflow; route P and M writes separately. |
| P/M | 42 | rules/AGENTS.md (21), rules/CLAUDE.md (21) | Replace snapshot-authority language; retain claim, receipt, privacy, and execution rules. |

### Documentation

| Class | Approx. lines | Paths | Disposition |
| --- | ---: | --- | --- |
| P | about 80 | README.md (69), docs/README.md (96), docs/ROADMAP.md Phase E (76-85), docs/PROJECT.md (76) | Rewrite authority and daily flow around selected provider and live reads. Phase E already requires explicit, exclusive GitHub source mode; generalise it to provider selection. |
| M | about 160 | docs/methodology.md (161), future provider-operation guide, this study | Keep methodology and document joins from provider task IDs to MapCtx delivery data. |
| M (historical) | 617 | docs/adr/0003-vnext-planning-intelligence-and-storage.md (573), docs/adr/0004-cutover-refuses-lossy-imports.md (44) | Keep accepted ADRs unchanged as history. ADR 0005 supersedes authority direction only if accepted. |
| D | 100+ | store-cutover, mirror-recovery, and reconciliation procedures in current operational docs | Remove procedures after migration. Immutable review evidence remains historical evidence, not live instruction. |

## TaskProvider contract sketch

The contract covers P fields and intentionally excludes claims, dispatches,
receipts, forecasts, and cost. Implementations map generic fields to native
fields, labels, relations, task lists, or comments, then declare unsupported
capabilities before a caller writes.

~~~ts
type ProviderKind = 'github' | 'linear' | 'jira' | 'local'
type ProviderItemId = string
type Revision = string

type ProviderOwnedField =
  | 'title' | 'body' | 'planningState' | 'type' | 'parent' | 'priority'
  | 'tags' | 'startDate' | 'dueDate' | 'completedOn' | 'iteration'
  | 'assignees' | 'milestone' | 'summary' | 'role' | 'impact' | 'acceptance'

interface ProviderItem {
  id: ProviderItemId
  key: string
  url: string
  revision: Revision
  fields: Partial<Record<ProviderOwnedField, unknown>>
}

interface ProviderDependency {
  from: ProviderItemId
  to: ProviderItemId
  kind: 'blocks' | 'blocked-by' | 'relates-to'
  revision?: Revision
}

interface Page<T> {
  items: T[]
  nextCursor?: string
}

interface ProviderTimelineEvent {
  id: string
  itemId: ProviderItemId
  occurredAt: string
  actor?: string
  kind: 'created' | 'field-changed' | 'comment' | 'relation-changed'
  revision?: Revision
  payload?: Record<string, unknown>
}

interface TaskProvider {
  readonly kind: ProviderKind
  readonly capabilities: ReadonlySet<ProviderOwnedField | 'dependencies' | 'comments' | 'timeline'>

  listItems(input: {
    project: string
    cursor?: string
    includeClosed?: boolean
    fields?: readonly ProviderOwnedField[]
  }): Promise<Page<ProviderItem>>

  getDependencies(input: { itemIds: readonly ProviderItemId[] }): Promise<ProviderDependency[]>

  setField(input: {
    itemId: ProviderItemId
    field: ProviderOwnedField
    value: unknown
    expectedRevision?: Revision
    idempotencyKey: string
  }): Promise<{ item: ProviderItem }>

  addComment(input: {
    itemId: ProviderItemId
    body: string
    expectedRevision?: Revision
    idempotencyKey: string
  }): Promise<{ commentId: string; revision?: Revision }>

  timeline(input: {
    itemId: ProviderItemId
    cursor?: string
    since?: string
  }): Promise<Page<ProviderTimelineEvent>>
}
~~~

The local provider is explicit, not an implicit fallback. If accepted, it
implements this same contract for solo/offline work and must not reintroduce
store-plus-provider synchronisation.

## Migration size and first slice

Measured scope: remove about 2,560 production lines plus related tests;
replace about 1,500 store-authority lines; rework sync-engine UI/CLI surfaces
whose current source totals roughly 10,000 lines including workspace assets;
and migrate 136 tasks, about 122 dependency edges, and 510 criteria once.

First vertical slice: a read-only GitHub TaskProvider for one project feeding
the existing plan/forecast view while all edits continue in GitHub. It tests
identity, pagination, capability mapping, rate-limit behaviour, and the join
from provider task ID to MapCtx intelligence before any authority code is
removed.

## Non-goals

- Do not add a writable local task cache.
- Do not retain GitHub/Markdown/store bidirectional synchronisation.
- Do not move claims, receipts, telemetry, forecasts, budgets, or cost into a
  task provider.
- Do not promise offline edits unless the local-provider question is accepted.
