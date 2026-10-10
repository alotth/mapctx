# GitHub Projects spike

**Date:** 2026-10-10
**Status:** first validation result for ADR 0005 (option B with the local provider kept)
**Task:** T-135 (epic E-018)
**Harness:** [`scripts/spikes/github-projects/`](../../scripts/spikes/github-projects/) — raw captures in `measurements/*.json`
**Contract under test:** `TaskProvider` in [provider-authority-study.md](provider-authority-study.md)

## What was proved

MapCtx computed waves, P50/P90 forecasts and cost from its own packages and
wrote all six derived fields into a private GitHub Project v2, 72 writes with
zero failures, verified by read-back. The store was never opened by spike code.
The dependency read path was implemented against the real API and returns real
edges — but every issue in every repository reachable for this spike has zero
dependency edges, so the read is proved in shape and cost, not against a
non-empty graph.

The three results that change the adapter design are: GitHub has **no
dependency write API**, **no write precondition of any kind**, and a **hard
ceiling of 50 fields per project**.

## Environment

| | |
| --- | --- |
| Account | `alotth` (the only one with the `project` scope); token per call via `gh auth token -u alotth`, active `gh` account never switched |
| Test project | **#3 "MapCtx provider spike (test)"**, private, owner `alotth`, bound to `alotth/mapctx` — `PVT_kwHOAcgr-s4BmfEN`, <https://github.com/users/alotth/projects/3> |
| Views created | #2 `Forecast roadmap (T-135)` (roadmap), #3 `Derived fields (T-135)` (table, 7 visible fields) |
| Items | 12 draft issues, one per corpus task |
| Corpus | T-116..T-120, T-126..T-129, T-131, T-133, T-134 — chosen for a real depth-4 store dependency chain |
| Store access | prebuilt CLI from `main` only (`mapctx task show`, `plan --json`, `gantt --json`) |
| Measured calls | 221 (GraphQL queries, GraphQL mutations, REST) |

### Data available, and what that cost the experiment

`alotth/mapctx` has **zero issues**. `GET /repos/alotth/mapctx/issues?state=all`
returns one row, but it is a pull request — the REST `issues` endpoint includes
PRs. GraphQL is unambiguous: `repository.issues.totalCount = 0`,
`pullRequests.totalCount = 1`.

Two sibling repositories do have real issues: `alotth/kanban-sync-engine` (7)
and `alotth/markdown-kanban-roadmap` (9). Both are public, both were read only.
**All 16 issues have `issueDependenciesSummary` all-zero, zero sub-issues and no
parent.** The dependency feature has never been used in this project's history.

So the Project items are draft issues. That was a deliberate decision, not a
shortcut: seeding issues in a public repository was out of scope, and a draft
issue is the only item kind the spike was authorised to create.

## Measured numbers

### Cost in GraphQL points

Every operation measured below costs **1 point**, with one exception. The
primary GraphQL budget is 5,000 points/hour; REST has its own separate
5,000/hour budget.

| Operation | Points | Note |
| --- | ---: | --- |
| `getProject` + `fields(first: 100)` | 1 | field page size is irrelevant to cost |
| `listItems(project, first: 100)` with 30 field values per item | 1 | |
| `listRepoItems+deps(first: 50)` with four nested 50-connections | **3** | `blockedBy`, `blocking`, `relatesTo`, `subIssues` each requested at 50 |
| any single mutation (`setField`, `createProjectV2Field`, `addProjectV2DraftIssue`, …) | 1 | mutations cannot select `rateLimit`; read from the `x-ratelimit-used` delta |
| **one mutation document with 50 aliased `setField` calls** | **1** | 50 field writes for the price of one |
| REST `GET /issues/{n}/dependencies/{blocked_by,blocking}` | — | REST budget, 1 request each |

The alias result is the single most important cost fact: batching collapses N
field writes into one point.

### Latency (ms, measured over 221 calls)

| Operation | n | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `setField` NUMBER | 55 | 306 | 449 | 626 | 959 |
| `setField` SINGLE_SELECT | 14 | 322 | 381 | 444 | 504 |
| `setField` DATE | 13 | 305 | 391 | 578 | 597 |
| `clearProjectV2ItemFieldValue` | 11 | 296 | 327 | 435 | 721 |
| `createProjectV2Field` TEXT | 31 | 320 | 392 | 607 | 773 |
| `deleteProjectV2Field` | 30 | 509 | 655 | 901 | 1181 |
| `addProjectV2DraftIssue` | 12 | 329 | 413 | 661 | 1023 |
| `getProject(fields: 100)` | 8 | 413 | 597 | 754 | 792 |
| `listItems(first: 100)` | 5 | 439 | 766 | 1039 | 1039 |
| `listRepoItems+deps(first: 50)` | 3 | 353 | 484 | 501 | 501 |
| REST dependency read | 4 | 252 | 267 | 284 | 284 |

Alias batching, two runs of the same probe (`04-limits.json`), one point each:

| Aliases in one mutation document | 1 | 5 | 10 | 25 | 50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| run A (ms) | 407 | 568 | 1946 | 1681 | 2871 |
| run B (ms) | 375 | 693 | 783 | 1804 | 4178 |

A 50-alias batch takes 2.9–4.2 s — under 10× a single write for 50× the work,
and one point instead of fifty. REST dependency reads are the fastest calls
measured (median 267 ms).

### Limits

| Limit | Measured value | Evidence |
| --- | --- | --- |
| Fields per project | **50, including the 13 default fields** | creating the 50th: `"Projects cannot have more than 50 fields, including default and custom fields"`. 13 default + 6 derived + 30 probe = 49 reached. |
| Connection page size | **100** | `first: 101` → `"Requesting 101 records on the connection exceeds the first limit of 100 records."` |
| Field pagination | never needed | with a 50-field ceiling, `fields(first: 100)` cannot have a next page |
| Item pagination | works | 12 items walked in 6 pages at `first: 2`, 1 point per page |
| Concurrency | 10 parallel writes to the same field/item: 10/10 succeeded in 648 ms | no secondary limit, no conflict, last write wins |
| Introspection | `__Type.inputFields` max 2 per query | `INTROSPECTION_LIMIT_EXCEEDED` |

**The field ceiling is the hard planning constraint.** 50 total minus 13 default
fields leaves **37 custom fields** for everything MapCtx wants on a provider:
six derived fields today, plus workload, domains, spec mode, effort provenance,
wait reason, per-criterion state, and whatever comes later. There is no second
project to spill into without splitting task identity.

### Write semantics

| Question | Answer | Evidence |
| --- | --- | --- |
| Is a repeated identical write a no-op? | **NUMBER: no. SINGLE_SELECT: yes.** | isolated probe, nothing else writing: re-sending the same number moved `updatedAt` 17:00:40 → 17:01:10; re-sending the same option id left it at 17:01:10 |
| Does `clientMutationId` deduplicate? | **No.** | same `clientMutationId`, two different values (11.13 then 12.13); read-back returned 12.13 |
| Is there a write precondition? | **No.** | `UpdateProjectV2ItemFieldValueInput` is `{clientMutationId, projectId, itemId, fieldId, value}` — no expected revision, no ETag |
| What revision signal exists? | `ProjectV2Item.updatedAt`, second granularity | and it moves for reasons unrelated to the field being written |
| Is the item count immediately consistent? | **No.** | `items.totalCount` read 0 immediately after creating 12 draft issues; 12 on the next run |
| Is a batch atomic? | **No — it partially applies.** | three aliases, the middle one a number value aimed at a SINGLE_SELECT column. The request failed (`VALIDATION`: `"Did not receive a single select option Id to update a field of type single_select"`) and the two valid aliases **still applied** — the marker value 777 read back from the number field |

### The six derived fields, as written and read back

`Wave` from `@mapctx/planner` over provider-shaped input; P50/P90 from the
store's `forecast-v1` snapshots; `Forecast end P90` = start basis + P90
duration.

| Task | Wave | P50 (h) | P90 (h) | end P90 | end basis | Est. custo | Custo real |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| T-116 | 1 | 0.13 | 0.92 | 2026-10-10 | today | 0 | *(cleared)* |
| T-117 | 2 | 0.21 | 0.80 | 2026-10-05 | `approximateDate(dependency)` | 0 | *(cleared)* |
| T-118 | 2 | 0.12 | 0.43 | 2026-10-10 | today | 0 | 0 |
| T-119 | 3 | 0.15 | 1.86 | 2026-10-10 | today | 0 | 0 |
| T-120 | 4 | 0.95 | 1.91 | 2026-10-10 | today | 0 | *(cleared)* |
| T-126 | 1 | 0.21 | 0.58 | 2026-10-10 | today | 0 | *(cleared)* |
| T-127 | 2 | 0.48 | 0.75 | 2026-10-10 | today | 0 | *(cleared)* |
| T-128 | 3 | 0.42 | 0.54 | 2026-10-10 | today | 0 | *(cleared)* |
| T-129 | 4 | 0.30 | 2.67 | 2026-10-11 | `approximateDate(dependency)` | 0 | *(cleared)* |
| T-131 | 5 | 0.37 | 0.59 | 2026-10-10 | today | 0 | *(cleared)* |
| T-133 | 6 | 0.30 | 2.67 | 2026-10-11 | `approximateDate(dependency)` | 0 | *(cleared)* |
| T-134 | 6 | 0.50 | 0.50 | 2026-10-10 | today | 0 | *(cleared)* |

72 writes, 0 failures, 0 read-back mismatches (`measurements/03-write.json`,
`verification`).

Two things the basis column makes visible. Nine of twelve end dates fall back to
*today* because the store has no `approximateDate` for a terminal task — a
provider that shows an end date for a finished task is showing noise. And
T-117's end date, 2026-10-05, is **in the past**: it is the store's own
dependency-derived approximate start plus 0.8 h, and that start is stale. The
derivation is faithful to the store; the store's start estimate is what needs
work before these dates mean anything on a roadmap.

#### The cost half has no data — declared, not papered over

Both cost fields were written through the same `setField` path, and both
evaluate honestly to zero or nothing, for three independent reasons measured in
the store:

- `cost_event_projection`: **0 rows**.
- All **7** `usage_event_projection` rows have `source: "absent"`,
  `coverage: "none"` and zero input/cache/output tokens. Run through the real
  `costEventFromUsage` from `@mapctx/forecast`, they produce 0 shadow micros.
- Their `provider/model` (`zai` / `glm-5.3-flash`) is **not in the vendored
  `PRICE_TABLE`** (`2026-08-17-v1`, 4 entries: `anthropic/claude-sonnet`,
  `anthropic/claude-3-5-sonnet`, `openai/gpt-4o`, `openai/gpt-4o-mini`), so
  `lookupRate` returns undefined regardless of tokens.
- `plan_period_projection`: **0 rows**. `budget_projection`: **0 rows**.
  `project_account_binding`: **0 rows**. One account exists (`Codex Pro`, USD)
  with no recorded plan payment.

So there is no rate and no measured spend to derive a cost from. `Est. custo`
takes `--usd-per-active-hour`, which defaults to 0 and was left at 0: inventing
a rate would have made an unmeasured number look measured. `Custo real` is 0
for the two corpus tasks that have usage events (T-118, T-119) and **cleared**
for the other ten — which also exercises `clearProjectV2ItemFieldValue`, 11
calls, median 327 ms.

**Cost on a provider is blocked on MapCtx-side data, not on GitHub.** E-018 can
write cost fields the day the store has a cost basis; nothing in the provider
stands in the way.

### What GitHub's state model costs the planner

Running the same graph twice, once with provider statuses and once with store
statuses, isolates it. A draft issue has no state at all and GitHub issues have
exactly two (`OPEN`/`CLOSED`):

| | provider statuses | store statuses |
| --- | --- | --- |
| Waves produced | 6 | 1 |
| Tasks placed in a wave | 12 | 3 (T-117, T-129, T-133) |

All 12 tasks diverge. The eight `done` tasks and the one `review` task are
schedulable under the provider reading and correctly excluded under the store
reading; T-117/T-129/T-133 move wave because the terminal tasks are in the
graph with them. MapCtx's planning states (`paused`, `review`,
`ready-for-do`, `blocked`, `cancelled`, `archived`) have no native
representation — they need a `Status` single-select the adapter owns, which is
also what `mapctx.toml [github.statusMap]` already does for the push path.

### Dependency reads

Implemented and exercised, cost and shape measured, **zero edges found**.

- GraphQL `Issue` exposes real edge connections, not just counters:
  `blockedBy`, `blocking`, `relatesTo`, `duplicateOf`, `parent`, `subIssues`,
  `subIssuesSummary`, `issueDependenciesSummary`, `trackedIssues`,
  `trackedInIssues`. One query returns identity, state, labels, assignees,
  milestone, issue type, parent, sub-issue tree and all three relation kinds —
  for 50 issues, for 3 points.
- `issueDependenciesSummary` is counters only (`blockedBy`, `blocking`,
  `totalBlockedBy`, `totalBlocking`); the connections carry the edges.
- REST `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` and
  `/blocking` both return `200 []`, median 267 ms, on the separate REST budget.
- Nested connections truncate silently. The harness marks a page
  `freshness.partial` with an `omitted` note when
  `totalCount > nodes.length` on any nested relation — a truncated edge list
  must never read as an absent edge.
- **Draft issues have no dependency and no sub-issue representation at all.**
  There is no `Issue` object behind a draft, so `blockedBy`, `blocking`,
  `parent` and `subIssues` do not exist for it. A project of drafts yields an
  empty graph. The harness records this as `edgeSource: "store-fallback"` and
  falls back to the store's edges for the 12 corpus tasks (9 edges) rather than
  silently planning a flat wave 1 — the adapter faces the same choice during
  migration and must label it the same way.

### Dependency writes do not exist

The GraphQL mutation surface has **`addSubIssue`, `removeSubIssue`,
`reprioritizeSubIssue` and nothing else** for relations. There is no
`addIssueDependency` / `removeIssueDependency` mutation. Dependency writes, if
they are possible at all, are REST-only (`POST`/`DELETE` on the
`dependencies/*` endpoints) and were **not exercised** — doing so needs issues
in a writable repository, which this spike did not have.

This is the gap with the largest consequence: `TaskProvider.addDependency` /
`removeDependency` cannot be implemented over the same transport as everything
else, and the mechanism is unverified.

## `TaskProvider` mapping

### Works as specified

| Contract member | GitHub mechanism | Measured |
| --- | --- | --- |
| `listItems` | `ProjectV2.items` / `Repository.issues` | yes — 1 point/page, `first ≤ 100` |
| `getItem` | `node(id:)` on `ProjectV2Item` / `Issue` | yes |
| `getProject` | `user.projectV2(number:)` | yes, 1 point |
| `setProjectField({field: 'title' \| 'notes'})` | `updateProjectV2` (`title`, `shortDescription`, `readme`, `public`, `closed`) | yes |
| `createItem` | `addProjectV2DraftIssue` / `addProjectV2ItemById` | draft path yes (12×); issue path not exercised |
| `getDependencies` | `blockedBy` / `blocking` / `relatesTo` connections | path yes, 3 points for 50 issues; **0 edges in the corpus** |
| `setField` with `surface: 'project-item'` | `updateProjectV2ItemFieldValue` | yes — 82 writes across NUMBER, DATE, SINGLE_SELECT |
| `FieldRef` project-item addressing | project id + item id + field id + option id are four genuinely distinct identities | **confirmed**; the single-select write is impossible without a resolved option id |
| `ProviderError` kinds | `auth`, `not-found`, `rate-limited`, `conflict`, `transient`, `unsupported` | `unsupported` observed repeatedly with HTTP **200** and untyped GraphQL errors; the others are mapped but were not triggered |
| `Page.freshness` partial/omitted | `pageInfo.hasNextPage`, and nested `totalCount > nodes.length` | yes, and necessary |
| `capabilities.discoveredAtWrite` | `createProjectV2View` with a roadmap layout and `visibleFieldIds` → `"Roadmap views do not support visible fields."` | **confirmed as a real need** — nothing in the schema says so in advance |

### Missing or unverified

| Contract member | Status |
| --- | --- |
| `addDependency` / `removeDependency` | **no GraphQL mutation exists.** REST-only at best, unverified |
| `expectedRevision` on every write | **no provider support.** No precondition field anywhere; `updatedAt` is the only signal, it is second-granularity, and it moves on an identical NUMBER re-write |
| `clientOperationId` as retry protection | confirmed to be an echo only; read-after-write comparison is mandatory, exactly as the study says |
| `closeOrReopen` | `closeIssue`/`reopenIssue` exist for issues; **a draft issue has no open/closed state**, so the lifecycle operation is unavailable for the only item kind this spike could create |
| `addComment` | not exercised (no writable issue) |
| `timeline` | not exercised |
| `listCriteria` / `setCriterionState` | no native criteria object. Task-list checkboxes in the issue body or sub-issues are the only candidates; a draft has neither as a first-class surface |

### No provider representation at all

| MapCtx concept | Why |
| --- | --- |
| Planning states beyond open/closed | two native states; everything else needs an adapter-owned `Status` single-select |
| `filesAffected` / resource claims | no field kind for it. The planner's collision model (10 serialized pairs in this run) is MapCtx-side by necessity |
| Per-criterion approval evidence | no criteria object to attach it to |
| Claims, dispatches, receipts, history | out of contract by design — and they stay MapCtx-side under every provider |
| `workload` / `estimatedEffort` provenance | representable only by spending more of the 37-field budget |
| Write preconditions | see above; this is what makes a provider-side atomic claim impossible |

## Risks

| Risk | Measured basis | Severity |
| --- | --- | --- |
| **No write precondition** | 10 concurrent writes to one field all succeeded, last wins, no conflict | **High.** `expectedRevision` in the contract has no backing. Concurrent agents silently overwrite each other's derived fields, and a provider-side claim is impossible — ADR 0005's claim-CAS question stays open and GitHub does not answer it |
| **No dependency write API** | GraphQL mutation list | **High.** The planning graph cannot be pushed to the provider over the main transport; a REST side-channel needs its own error model, retry policy and verification |
| **50-field ceiling** | API refusal at the 50th field | **High.** 37 custom fields for all of MapCtx's non-planning data, forever. Field budget becomes a design constraint on day one |
| **Draft issues are second-class** | no deps, no sub-issues, no open/closed | **Medium.** Anything MapCtx creates on the provider must be a real issue in a real repository, which means a writable repository is a prerequisite, not a detail |
| Rate limit with N agents | 1 point per mutation; 50 writes per point when batched; 5,000 points/hour | **Low.** All 136 tasks × 6 fields = 816 points unbatched, **17 points batched**. 221 calls over ~25 minutes never approached a limit, primary or secondary |
| **Batch writes partially apply on failure** | three aliases, one invalid: the request returned a top-level `VALIDATION` error and the two valid aliases were still written | **High.** A GraphQL document is not a transaction. A failed batch leaves the item in a mixed state with no indication of which aliases landed, so "retry the whole batch" is not safe without reading every field back first |
| Eventual consistency | `items.totalCount` read 0 right after creating 12 items | **Medium.** Read-after-write must tolerate a stale count; `freshness.stale` needs to be set from observation, not assumed false |
| Public-repository exposure | the bound repository is public | **Medium.** Writing issues/comments to carry planning data publishes it. The private Project is safe; the issues behind it are not |

## Recommendation for the adapter

Build it, with these five decisions taken up front.

1. **Batch every field write.** One mutation document with up to 50 aliased
   `updateProjectV2ItemFieldValue` calls costs 1 point and 2.9 s. Per-field
   mutations cost 50× the points for the same work. The adapter's write unit
   should be "all derived fields for a page of items", not "one field".
2. **Read-after-write is the only retry primitive, and it has to cover the
   whole batch.** `clientMutationId` is an echo, there is no precondition
   field, and an identical NUMBER re-write moves `updatedAt`. Verify by
   comparing values, never by comparing a revision. A failed batch returns a
   top-level error with *no* per-alias results while some aliases have already
   applied, so recovery means re-reading every field in that batch, not
   resending it blind. Drop `expectedRevision` from the GitHub capability map
   rather than pretending it is honoured.
3. **Treat the 37-field budget as a schema.** Decide now which MapCtx concepts
   get a provider field and which stay MapCtx-side. The six derived fields plus
   an adapter-owned `Status` single-select is seven; that leaves 30. A
   `Forecast start P50` date field is an eighth, and it is needed — a roadmap
   view needs a start and a target date to be legible, and the default field set
   has neither.
4. **Dependencies: read from GraphQL, write through a separate, explicitly
   capability-gated path.** `getDependencies` is cheap and complete (3 points
   for 50 issues with all relation kinds). `addDependency`/`removeDependency`
   should be declared `write: false` in the GitHub capability map until the REST
   endpoints are validated against a writable repository with seeded edges. The
   harness is already parameterised for exactly that run
   (`--owner`/`--dep-repos`).
5. **Claims stay MapCtx-side, unconditionally.** The concurrency probe settles
   this: GitHub offers no compare-and-swap on any write, so no provider-backed
   atomic claim is possible. ADR 0005's git-ref CAS question is unaffected by
   this spike and remains open.

On the Roadmap view: `createProjectV2View` accepts a layout and
`visibleFieldIds`, but `ProjectV2ViewConfigurationInput` exposes **only**
`visibleFieldIds`, a roadmap view rejects even that, and the start/target date
fields a roadmap draws from are not in the public schema. The view can be
created by API (#2 was); it **cannot be configured by API**. Pointing it at
`Forecast end P90` is a manual step in the web UI, and with no start-date field
written the roadmap can only draw single-point markers. Legibility was not
assessed visually: the in-app browser profile is not signed in to GitHub, and
the screenshot was optional.

## Open questions this spike does not answer

- Do the REST dependency endpoints actually write, and what do they return on
  conflict, cycle or cross-repository edges?
- Can acceptance criteria survive as issue task-list items, and can per-criterion
  state be read back reliably?
- What does `timeline` cost and does it carry enough to reconstruct field-change
  history, or must MapCtx keep its own event log regardless?
- Does the 50-field ceiling apply per project only, or is there an org-level
  budget as well?

## Reproduction

Commands, flags and the store-copy procedure are in
[`scripts/spikes/github-projects/README.md`](../../scripts/spikes/github-projects/README.md).
Every number in this document comes from
`scripts/spikes/github-projects/measurements/01-setup.json` through
`05-view.json`.

The test project is left in place, unarchived, with its 12 items and six
derived fields populated: <https://github.com/users/alotth/projects/3>.
