# TaskProvider contract: design decisions

**Date:** 2026-10-14
**Status:** implementation record for T-139 (epic E-018)
**Code:** [`packages/provider/`](../../packages/provider/)
**Inputs:** [provider-authority-study.md](provider-authority-study.md) (T-123) · [github-projects-spike.md](github-projects-spike.md) (T-135) · [ADR 0005](../adr/0005-provider-authority-proposal.md)

The study fixed the vocabulary; the spike measured the provider the first
adapter has to live with. This records where the code departs from the study's
sketch and why, so the GitHub adapter does not have to rediscover it.

## The decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | New package `@mapctx/provider`, depending on `@mapctx/protocol` and `@mapctx/store`. Nothing depends on it yet. | A leaf package cannot create a cycle. The store must not know about providers, and the CLI is explicitly out of scope for this task, so nothing is wired in — which also leaves `sync-engine`'s `bundleDependencies` and the pack smoke test untouched. |
| 2 | `expectedRevision` is **not** a parameter on every write. It is an optional `precondition`, legal only when `capabilities.preconditions.revision` is true, and a provider that cannot honour it must refuse with `unsupported`. | The spike found no write precondition anywhere on GitHub, and ten concurrent writes to one field all succeeded last-write-wins. A contract where every write *accepts* `expectedRevision` invites a caller to believe its write was guarded. Refusing is the only honest option: silently dropping a precondition converts a safety mechanism into a lie. |
| 3 | The batch is the primitive: `applyFieldWrites` returns a per-write `BatchOutcome` with an explicit `partiallyApplied`. `setField` is a one-write convenience. | 50 aliased writes cost one rate-limit point, and a failing batch still applied its valid writes. A caller that sees `partiallyApplied` must re-read rather than resend, and that state has to be reportable rather than inferred. |
| 4 | `capabilities.batch.singleOperation` says whether a batch reaches the provider as one operation — not whether `applyFieldWrites` exists. | The local provider emulates a batch write-by-write. The method must still work there; what differs is the cost, and conflating "no cost win" with "unavailable" would force callers to branch on the provider. |
| 5 | Idempotence is declared per field (`idempotentRewrite`) and defined in terms of the **reported outcome**, not the revision. | The spike measured a same-value rewrite as a no-op for a single select and as a revision-moving write for a number. And a provider's revision marker can be too coarse to show a write at all — the local provider's is a date — so "the revision did not move" proves nothing. |
| 6 | `ProviderError.retryable` is derived from the kind in one place (`results.ts`), never set by hand. | Two providers that each decide whether `auth` is retryable will eventually disagree, and the caller is the one who pays. |
| 7 | No hard delete, anywhere. Lifecycle is `createItem` + `closeOrReopen`. | Carried over from the study, and the contract suite asserts no provider grows a `deleteItem`. A migration mistake is closed with an audit trail; a contract that can destroy someone's issue eventually will. |
| 8 | `listComments` was added to the study's fourteen operations. | The study specified writing comments and never reading them back, which makes a comment unverifiable. Read-after-write is the only verification this contract has. |
| 9 | The contract suite **reports** rather than asserts: `checkProviderContract` returns named checks. | It stays independent of any test runner, so the same suite can run against a fake or against GitHub. It also makes mutation testing possible — mutate a provider and assert that the specific check which should catch it is the one that fails. |
| 10 | The suite checks each provider against **its own capability declaration**, in both directions. | This is the whole point. A declared `write: false` must actually refuse; a declared `write: true` must not refuse as `unsupported`. A suite that only drove happy paths would pass a provider that silently swallowed writes. |

## LocalStoreProvider: what the store can and cannot do

Writes go through the store's own operations (`tasks.ts`, `acceptance.ts`), never
around them. The gates are the point: the `done` transition checks acceptance,
and reaching past it to satisfy an interface would make the contract a way
around the store's own rules.

| Surface | Capability | Mapping, or why not |
| --- | --- | --- |
| `title` `type` `parent` `priority` `tags` `startDate` `dueDate` `iteration` `assignees` `milestone` | read + write | `updateTask` patch whitelist. |
| `summary` `role` `impact` | read + write | `updateTask` detail patch. |
| `planningState` | read + write, `discoveredAtWrite` | `moveTask`. The write can be refused for a reason the schema does not express — an illegal hop, or the `done` gate finding unapproved acceptance — so it reports `conflict`, never `unsupported`. |
| `body` | neither | The description prose stays Git-authored (ADR 0003/0004); the store holds only `descriptionGitHash`. It can neither return the body nor write it. |
| `completedOn` | read only | Stamped by the `done` gate. A provider that let a caller write it would be inventing a completion date. |
| `blocked-by` `blocks` | read + write | The store's `depends-on` / `blocks` edges. `depends-on` and `blocked-by` are the same edge in the same direction under two names. |
| `relates-to` | neither | The store has no undirected relation kind to map it onto. |
| criteria | read + write | `getAcceptance` / `approveAcceptanceCriterion` / `unapproveAcceptanceCriterion`. The store's acceptance revision is read internally; it is not the general write precondition. |
| comments | neither | The store has no comment surface. |
| timeline | neither | The event log exists, but there is no per-task projection of it to page over, and reaching past the public API into the schema is not worth a read. |
| lifecycle | create + closeOrReopen | `createTask`; `moveTask` to `done`/`cancelled`/`archived`, and `reopenTask` to reopen — reopen is its own operation because it clears `completedOn` and journals an audit event that a plain move cannot. |
| preconditions | **not supported** | `updateTask` takes no expected revision. Declaring it supported because *acceptance* has a revision would promise a guarantee that covers one surface out of many. |
| batch | emulated, non-atomic | Sequential, stopping at the first failure. |

### Three things the mapping turned up

- **The store's edge lists replace, they do not append.** `updateTask` rebuilds a
  task's edges from whichever lists the patch carries and drops the other kind,
  so sending `dependsOn` alone deletes every `blocks` edge the task had.
  `addDependency` therefore always sends both lists. This was found by reading
  `tasks.ts`, not by a test failing, and it is a live hazard for any other
  caller that patches one list.
- **The read-modify-write window is real.** Adding one edge means reading the
  list, changing it, writing it back, with no precondition available to close
  the gap. That is the concrete reason `preconditions.revision` is false rather
  than quietly true.
- **`createTask` canonicalises the title**, prefixing the id it assigned. So the
  contract does not require a created item to echo its input verbatim; it
  requires that the requested text survives somewhere in the title, and that
  what `createItem` reports matches what a later read shows.

## Open, and deliberately not settled here

- **A finer local revision marker.** `updatedOn` is a date, so two edits on the
  same day are indistinguishable. It is sound only because this provider refuses
  preconditions. A precise marker exists in the projection's event sequence, but
  `TaskRecord` does not carry it; exposing it is a store change, not a provider
  change.
- **Who owns `relates-to`.** Either the store grows an undirected relation or the
  contract accepts that a provider-specific relation kind has no local
  equivalent. The capability map says `false` today, which is accurate and not a
  decision.
- **Claims, dispatches, receipts and history stay out of the contract**, as the
  study and ADR 0005 both say. Nothing here changes that, and the spike confirmed
  GitHub offers no compare-and-swap that could host a provider-side claim.
