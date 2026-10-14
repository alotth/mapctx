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
| 3a | **The batch path is verified by read-back**, with values only the batch could have produced. | Review of attempt 1: the batch was checked only for internal self-consistency, and two batch implementations — one applying nothing while claiming `verified: true`, one applying every value into `summary` — scored a clean pass. The verified path was the single-write one; the unverified path is the one the cost model tells every adapter to write *everything* through. Reading back the same samples an earlier `setField` already wrote proves nothing, so each batch value is derived to be distinct (`"… [batch]"`, a shifted date, an extra array element) and fields with no derivable distinct value are left out rather than guessed at. |
| 3b | **`outcomes` carries one entry per submitted write**, with `status: "skipped"` for the ones never attempted, plus a `skipped` count. | The local provider stops at the first failure; GitHub applies every valid alias and reports the failure at the top. A short array would mean the opposite thing on each, so a caller learning one would be wrong against the other. The suite checks the length, and puts the unsupported write first in the mixed batch so a stop-at-first-failure provider has to account for the trailing one. |
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

### Four things the mapping turned up

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
- **Creation is narrower than patching, and the first version of this provider
  lied about it.** `iteration`, `assignees` and `milestone` are patchable through
  `updateTask` but have no `createTask` parameter, so `createItem` accepted them
  and returned `ok` with the values discarded — the exact accept-and-drop
  failure the contract is built to prevent, shipped in the thing built to
  prevent it. It now refuses them as `unsupported` and tells the caller to
  create then write. The suite gained the check that catches it for any
  provider: a writable field passed to `createItem` must be **stored or
  refused, never swallowed**. That check is why the lifecycle group grew from 5
  checks to 26.

A related guard came out of the same review: a field declared writable that
neither patch map knows how to route now fails with `unsupported` saying the
capability record has drifted, instead of building a patch around an undefined
key and reporting success.

## What the suite does not verify

Worth knowing before trusting a green run.

- **`freshness.source` and `freshness.stale` are advisory.** Nothing outside a
  provider can tell whether a page came from a cache or how stale that cache is,
  so the suite checks `partial` and `fetchedAt` and leaves these two as the
  provider's self-report. A wrapper claiming `source: "cache"` while serving
  live data passes. Do not build a cache-invalidation policy on them.
- **The read-modify-write window on dependency writes is declared, not closed.**
  Two concurrent edge writers — provider and CLI, or two provider calls — lose
  one edge silently, and the loser gets `ok`. The store offers no precondition
  to close it. This becomes a real problem the moment anything writes edges
  concurrently with a human running `mapctx task update`.

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

## T-150: the GitHub read adapter, and four gaps closed

The T-139 review left seven gaps. Four were contract gaps and are closed here;
three were not, and are registered in T-152's description rather than invented
into the interface.

### Closed

| Gap | Shape | Why it had to be contract surface |
| --- | --- | --- |
| Single-select option discovery | `describeFields` → `ProviderFieldDescriptor[]`, plus `resolveOptionId` | A GitHub single-select write needs the OPTION id, and an option id cannot be derived from a value. Without this, every caller needed provider-specific code to find one, and `FieldRef.optionId` was a field nobody could fill. |
| Per-species capabilities | `capabilities.primarySpecies`, `capabilities.species`, `capabilitiesForItem` | GitHub puts draft issues and issues on one board. A draft has no `Issue` object behind it: no relations, no sub-issues, no comments, no timeline, no open/closed state. One static record describing both is a record that is wrong for one of them. |
| Field budget | `capabilities.fieldBudget` | A board holds at most 49 observable fields (T-135 measured 49; GitHub's refusal message says 50). 13 are built-ins, so 36 are left for everything MapCtx wants to project. That is a design constraint on day one, not a runtime surprise. |
| Proactive rate limit | `rateLimit()` + `capabilities.rateLimit` | A mirror sizing a batch needs the balance before sending. The rule matches preconditions: a provider that cannot measure one must refuse, because a fabricated balance is worse than none. |
| Key resolution | `findByKey({project, keys})` | The mirror reconciles 136 tasks against a board whose ids it does not own. Otherwise that is a full `listItems` walk per pass plus an undeclared title convention. |

Two directions were decided rather than discovered, and both could reasonably
have gone the other way:

- **A species may only narrow.** `capabilities` describes `primarySpecies`, and
  `widenedSpeciesClaims` is checked by the suite. The alternative — a
  conservative floor that species widen — would have made the primary record
  safe to act on but useless to read, because every caller would under-use the
  provider while believing it had the truth. Narrowing keeps the record a
  description and makes `capabilitiesForItem` the thing a caller asks before a
  write.
- **`planningState` carries the provider's own value.** The GitHub adapter
  returns the `Status` option name, or the issue's `open`/`closed` when the board
  has no value — never a MapCtx planning state. Translating inside the adapter
  would mean it had decided that "In progress" is `in-progress`, and the day a
  column is renamed it would be inventing states silently.
  `GITHUB_STATUS_TO_PLANNING` and `PLANNING_TO_GITHUB_STATUS` are exported for
  callers that want the translation, cover `cancelled` and `blocked` (which
  `mapctx.toml`'s statusMap never did), and are pinned in both directions by a
  test, so the write side cannot emit a label the read side will not understand.

### Registered for T-152

Dependency writes over REST (unvalidated, so the capability stays `false`),
`bundleDependencies` (the CLI does not import the provider yet, so nothing was
touched), and the read-modify-write window the store and GitHub share. The
detail is in `tasks/T-152.md`.

### What the suite gained, and what it caught

Four groups: `species`, `keys`, `field-descriptors`, `rate-limit`. The
precondition check also stopped skipping when no field is writable — which was
exactly the provider most likely to drop a precondition silently.

It caught two mistakes while being written, the same mistake twice: the store's
`tags`/`assignees` and GitHub's `Labels` built-in were all typed as enumerated
when none of them has an option set at that layer. `ProviderFieldDataType` now
separates `text-list` from `multi-select`, which is a real distinction rather
than a workaround.

### Fixtures: two provenances, never mixed

`npm test` runs offline. `github-recorded.json` is captured read-only from the
live API by a recorder that drives this same adapter and this same suite, so the
recorded keys are exactly the keys the tests ask for; it aborts if a mutation
document appears, and bodies are truncated and absolute paths scrubbed because
these bytes are committed to a public repository.

`github-synthetic.json` is hand-built in the recorded shape and says so.
It exists because every issue reachable for T-135 and T-150 has zero dependency
edges and zero sub-issues — so a recorded fixture proves the query and its cost
and proves nothing at all about the mapping. Its node ids contain the word
SYNTHETIC. Keeping the two files apart is what lets a later reader tell a
measurement from a construction.

### Read-only, and why the capabilities say so

Every write refuses with `unsupported` and names its capability. This is the
measured truth: no GraphQL mutation for issue dependencies exists, no write
precondition of any kind exists, and a failing batch leaves its valid writes
applied. Declaring any of it writable before T-152 validates the REST path would
be precisely the lie the suite exists to catch.
