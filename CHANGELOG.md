## [1.0.2] (2025-06-04)

### Features

* **fix:** Support CRLF line endings


## [1.1.0] (2025-06-16)


### Features

* **feature:** Add enable/disable file listener command for edit multiple files @ssebs ([#4](https://github.com/holooooo/markdown-kanban/pull/4))

## [1.1.1] (2025-06-23)

### Features

* **feature:** Allow to show/hide filter section
* **feature:** Auto save edited files

## [1.2.0] (2025-07-01)

### Features

* **feature:** Add workload support (Easy, Normal, Hard, Extreme) @ssebs ([#13](https://github.com/holooooo/markdown-kanban/issues/10))
* **feature:** Add steps support
* **feature:** Add tag autocomplete with prefix matching for existing tags @ssebs ([#9](https://github.com/holooooo/markdown-kanban/issues/9))

### refactor

* **refactor:** Separate html code @ssebs ([#12](https://github.com/holooooo/markdown-kanban/pull/12))


## [1.2.1] (2025-07-02)

### Fixes

* **fix:** Fix the webview.html not included in the extension package

## [1.2.2] (2025-07-03)

### Features

* **feature:** Add defaultExpanded support for task @ssebs ([#13](https://github.com/holooooo/markdown-kanban/issues/13))
* **feature:** Add support for header format
* **feature:** Optimize task and step dragging experience for task @ssebs ([#14](https://github.com/holooooo/markdown-kanban/issues/14))


## [1.2.3] (2025-07-05)

### Features

* **feature:** Add setting for task header format


## [1.3.0] (2025-07-05)

* **feature:** Add column archive support


## [1.3.1] (2025-07-06)

### Chore

* **chore:** shorten command name to "Kanban"

## mapctx CLI — [0.4.0] (Unreleased)

### Features: review becomes a lane the store can see (T-144)

* **feature:** a dispatch declares which lane it runs in — `kind` is
  `implement` or `review`, and absent means `implement`, which is what all 235
  recorded attempts were. A review of a task under implementation is a second,
  concurrent run with its own `dispatchId`, its own attempt counter and its own
  receipt, so implement and review attempts can never invalidate each other
  (`evaluateRunReceipt` is scoped per dispatch). A dispatch id names one lane
  for its whole life: an attempt whose `kind` contradicts the attempts already
  recorded under that id is refused by name.
* **feature:** a claim declares whether it excludes others (`exclusivity`:
  `exclusive` or `shared`) and which lane it holds (`role`: `implement` or
  `review`). An implement claim is the exclusive claim every claim has always
  been; a review claim is shared, is never refused because the task is being
  implemented, and never blocks the implementation it reviews. Two reviewers on
  one task is legitimate and admitted.
* **feature:** a review lease is longer than the implement lease the same plan
  derives (operator decision D11, 2026-10-15), by `[coordination]
  reviewLeaseFactor` — default 2, validated like `leaseFactor` and refused by
  name if non-positive. The factor scales the clamp's ceiling as well as the
  multiplier, so the proportion an operator configures is preserved
  (`maxLease = "2h"` → review ≤ 4 h) and a review lease still cannot outlive
  the 24 h absolute ceiling. `--lease` is unaffected: it still wins over config
  and is still refused above 24 h.
* **feature:** every path that reasoned from "this task's active claim" now
  names a lane. Claim admission, `dispatch create`'s claim gate, `task renew
  --dispatch` and the run-event renewal all resolve within the lane they are
  asking about, and the single-row getter that could answer with the wrong lane
  is gone. A heartbeat on a review dispatch renews the review claim or nothing
  — never the implement lease beside it. Where two live claims match one lane,
  the lookup refuses (`ambiguous-claim`) and asks for `task renew --claim <id>`
  rather than guessing; an expired claim never competes with a live one.
* **feature:** releasing or expiring a review claim leaves the task's
  `executionState` alone, as does opening a review dispatch or claim. That
  scalar describes the implement run, and a review is a different run: before
  this, a reviewer's claim expiring would have reset a still-running
  implementation to `unclaimed`.
* **fix:** a claim refusal now names the lane that refused it
  (`exclusivity`/`role` on `activeClaim`, 8 allowlisted fields becoming 10).
  Neither is a credential, and "an exclusive implement claim holds this task"
  is what a turned-away caller needs; `leaseToken` and `renewToken` remain
  absent from every refusal.
* **migration 13** (additive, and the first migration that changes an existing
  constraint): two `NOT NULL` columns with `CHECK` enums on
  `resource_claim_projection`, one on `dispatch_projection`, and
  `idx_resource_claim_active_task` dropped and recreated **under the same name**
  with the `exclusivity = 'exclusive'` predicate. `NOT NULL DEFAULT` fills every
  existing row in the same statement, so no row is ever NULL — a nullable
  column would have fallen outside the new predicate and let a second
  exclusive claim insert beside a legacy one. Downgrade-safe: a binary that
  knows only schema ≤ 12 reads and writes the migrated store, and its claims
  land on the column defaults, which is the only lane it can mean.
* **no new CLI surface.** `task start --kind review` and `dispatch create
  --kind review` deliberately ship with T-145 (C6) instead, per operator
  decision D6: exposing the lane before review-receipt admission lands would
  let a completed review receipt carry the task's planning state to `review`.
  Until then the lane exists in the store API and in the schema, and nothing a
  user can type reaches it.
* **fix:** starting a new attempt on an existing dispatch takes that
  dispatch's own lane. Previously the claim's lane came from the caller
  (defaulting to `implement`) while the attempt's came from the dispatch, so
  continuing a review dispatch without naming the kind minted an exclusive
  implement claim for a review attempt — and the run's heartbeats, which
  resolve by the dispatch's lane, then renewed the *reviewer's* claim while
  the implement claim nobody was renewing expired in silence. An absent kind
  now inherits the dispatch's lane and a contradicting one is refused by name.
  Unreachable from the CLI in this release; it would have become the natural
  mistake the moment `--kind` shipped.
* **fix:** "a dispatch id names one lane" now holds for a raw
  `dispatch.attempted` append too, not only for `dispatch create`. Replay is
  unaffected — a mixed chain already on disk still projects as the historical
  fact it is — and the lane a renewal resolves is read from the attempt that
  is actually running rather than from attempt 1, so a chain merged from
  another node behaves sensibly instead of answering for a lane it left.
* **fix:** a `task.claimed` event carrying an unknown `role` is refused
  instead of being quietly read as `implement`. The dispatch side never had
  this hole — migration 13's `CHECK` refuses an unknown `kind` loudly — and an
  absent `role` is still legal, which is what keeps the historical events
  replayable.

### Features: the store backs itself up (T-138)

* **feature:** `mapctx store backup [--out <dir>]` takes a consistent copy of the
  store -- database via `VACUUM INTO` (WAL folded in, writers not blocked), event
  journal, identity and attestations -- with a manifest carrying the manifest and
  schema versions, event count, per-node journal counts, `redactionCount`, and a
  sha256 + size per file. Archives default to `~/.mapctx/backups/<projectId>/`.
  The database is snapshotted before the journal deliberately: writes are
  journal-first, so entries appended mid-backup replay on restore, while the
  reverse order would yield an archive that verifies and cannot be restored.
* **feature:** `mapctx store verify-backup <dir>` re-hashes every listed file and
  reports files the manifest does not list (a restore would ignore them).
* **feature:** `mapctx store restore <dir> [--force]` verifies the archive, replaces
  the store under the maintenance lock, and replays journal entries newer than the
  snapshot. Refuses a tampered archive, a schema version newer than the binary, a
  manifest path escaping the archive, and an existing store without `--force` --
  which moves the current store aside rather than deleting it.
* **feature:** `mapctx store backups` lists this project's archives, newest first.
* **feature:** a schema migration and `mapctx store repair` each take an automatic
  snapshot first, reported on stderr, so a failed upgrade leaves a rollback point.
  Retention prunes only automatic snapshots; an operator backup is never pruned.
  Both are best-effort: a store that cannot be snapshotted must still be repairable.
* **feature:** `mapctx store init --from-git <ref>` recovers from the **committed**
  TASKS.md/tasks/*.md at that ref. Without it the working copy is read, as before --
  which the command used to describe as "the last git-committed checkpoint" while
  reading uncommitted files. Both paths now state the source they used.

### Privacy note

A backup predates any later redaction and still contains the original value, so
restoring an old archive undoes a `mapctx redact`. `redact --commit` now warns when
archives exist, and every manifest records how many redactions the store had applied
when it was taken.

### Breaking (public contract): an unknown flag is an error

`parseArgs` used to drop any unrecognized `--flag` in silence. That made four
plausible spellings of the new `--no-snapshot` — `--no-snapshots` (one
character from the existing `--snapshots`), `--snapshot=none`,
`--snapshot none`, `--no-snapshot=true` — close the task **and rewrite every
mirror**, exit 0, no warning: the exact harm the flag exists to prevent.

An unknown `--flag` now exits non-zero with `Unknown flag: --x`. Matching is on
the base name before `=`, so a boolean flag written with a value keeps its
0.4.0 behaviour (`--json=true` is still accepted and ignored) — except
`--no-snapshot=...`, which is refused, because for that flag silence costs a
rewritten working tree. `--snapshot` is a validated value flag accepting
`none` or `full`.

Migration: a typo that used to be ignored now fails. Nothing in this
repository passed an unknown flag; `mapctx workspace`'s flags are parsed by a
separate parser and are explicitly registered, so `mapctx workspace --no-open
--port <n>` (used by the `pack:smoke` CI step) keeps working.

### Breaking (public contract): refusals leave on stderr

A refused `mapctx` command no longer prints its structured refusal to stdout.
It exits non-zero and leaves **stdout empty**; with `--json` the refusal is the
**first line of stderr** as one line of compact JSON, followed by the human
`Error: ...` line. Without `--json` only the `Error:` line is printed, so a
holder's lease token is not sprayed across a terminal.

Affected: `task move/update/create/start/claim/renew/release`,
`dispatch create`, `dispatch receipt`, `task acceptance revise/approve/unapprove`,
`acceptance import --commit`, `redact`, `export`, `task finish`.

**Gate reports are unchanged** and still print to stdout even when they exit
non-zero, because the document is the deliverable: `mapctx validate`,
`mapctx import --dry-run`, `mapctx store repair`.

Migration: read stderr's first line (or split stderr on `"\nError:"`) instead
of stdout. Check the exit code first, as before. No consumer in this repository
depended on the old channel.

### Breaking (library contract): `@mapctx/planner` no longer derives violations from redacted receipts

`@mapctx/planner` and `@mapctx/store` each carried their own copy of the same
claim-path comparison and violation-id derivation, and only the store's copy
had been hardened against redacted evidence (T-133, from the T-131 review).
There is now one definition, in `@mapctx/protocol`, and the planner behaves
like the store:

* `pathsOverlap` returns `false` when either side is the redaction sentinel
  (`mapctx:redacted`) — including when **both** are. It used to report two
  sentinels as the same path, which made two receipts with entirely disjoint
  files "collide".
* `detectClaimViolations` no longer emits a `collision` whose path is the
  sentinel, no longer emits `overbroad` for a serialized pair when either
  receipt holds a redacted path (non-intersection cannot be established, and
  claiming it asserts two tasks did *not* conflict when they may have), and
  drops caller-supplied sentinel paths from `serializedPairs`.
* Detecting over a redacted receipt now raises a process warning: an empty
  result there means "cannot tell", not "no collision".

Names, arities and return types are unchanged — `detectClaimViolations` and
its `deriveClaimViolations` / `detectViolations` / `detectWaveClaimViolations`
aliases, and `pathsOverlap`. Violation **ids are unchanged**: the shared
derivation uses the same field order both copies already used.

Migration: none for callers that never pass redacted receipts. A caller that
relied on the old output over redacted receipts was reading fabricated audit
facts; to get the blind spot as data rather than a warning, use
`@mapctx/store`'s `detectClaimViolationsWithCoverage`.

### Behaviour change (scheduler): declared paths are compared in canonical Unicode normal form (NFD) (T-166)

`normalizeSchedulerPath` — the one comparison `@mapctx/planner`'s scheduler and
its `schedulerTreatsAsSameFile` guard both read — now folds the path to
canonical Unicode **NFD** before resolving `..` and folding case. macOS reports
filenames in NFD and Linux in NFC, so `café.ts` written on one host and
`café.ts` written on the other were two different files to `mapctx plan`.

Two consequences, and the first is the reason the second was accepted:

* **`mapctx plan` serializes more, not less.** Two tasks whose declared paths
  differ only in the normal form of one combining sequence now collide, so they
  land in different waves instead of running in parallel over one file, and
  nothing that used to be serialized becomes parallel. Canonical reordering was
  an exception to that until T-170 closed it in `staticPrefix`, below.
* **The serialized-pair route stops recording a false `overbroad`.** Two
  receipts spelling one file NFC and NFD no longer read as proof that
  serializing the pair was unnecessary; guard G4 fires and the pair is skipped
  with the usual INCOMPLETE warning. Symmetrically, the collision route now
  warns that it may have MISSED a collision where it was previously silent. A
  legitimate `overbroad` between genuinely disjoint files is unaffected, and
  genuinely different filenames (`café.ts` vs `cafè.ts`) stay disjoint.

**NFD specifically, and not NFC.** For equality the two canonical forms are
interchangeable. But `pathOverlap` also compares globs by their static prefix,
truncated at the first wildcard and matched with `startsWith`, and NFC is not
prefix-preserving: composing `e`+`◌́` into `é` consumes the base letter a
prefix ended on, so under NFC `src/cafe*` stops matching the NFD spelling of
`src/café.ts` and a pair that used to be serialized runs in parallel over one
file. Across 15 declared-path shapes against a `52c73af` build, NFD narrows 0
and NFC narrows 4; tests pin each of those four shapes.

**What no normal form fixes, fixed in the truncation instead (T-170).** Every
form sorts combining marks by canonical combining class, so a glob whose static
prefix is cut *between* two marks written out of canonical order does not
survive the sort — `src/à*` against `src/à`+`◌̣`+`.ts` (grave first, dot-below
second, which NFD swaps) serialized on `52c73af` and ran parallel under T-166.
No choice of normal form delivers that, because it is a property of the
truncation: `staticPrefix` now drops trailing combining marks so a static
prefix always ends on a base character, which closes the shape. Note also that
a prefix sweep with one mark per name — which is what shows NFD breaking none —
has no boundary between two marks and therefore cannot see this class at all;
over two marks, NFD breaks roughly a third of its probes, and those breaks are
now absorbed by the trim.

The form is canonical on purpose: NFKC/NFKD map 215 code points onto
characters this comparison treats as structure (`U+2025` → `..`, `U+FF0F` → `/`,
`U+FF0A` → `*`), which would turn `src/x/‥/a.ts` into path traversal. A test
forbids them.

The audit comparison in `@mapctx/protocol` deliberately still does **not**
normalize: what normal form a receipt reported is evidence, and this change does
not rewrite receipts or violation rows already recorded.

Measured cost on the reference board: **none.** `mapctx plan --json` is
byte-identical between a `52c73af` build and this one, modulo the cwd-derived
`tasksFilePath`, measured on one pristine copy of the store per run. Of the 243
distinct declared paths on that board, 0 contain a character either canonical
form would change — so the widening is unexposed there rather than absent, and
the first accented declared path will exercise it. For orientation only, that
board on 2026-10-15 planned 4 waves / 14 serialized pairs / 11 advisories / 170
claims, identical on both builds; those four counts track board state and will
not reproduce later, whereas the byte-equality and the 243/0 figures do.

Migration: a caller that relied on two normal forms of one filename being
schedulable in parallel will now see them serialized. The warning text for both
INCOMPLETE routes now ends "and folds Unicode to canonical NFD", and a pair
holding a non-ASCII path additionally carries its `\uXXXX`-escaped form in
brackets, because the two spellings are otherwise indistinguishable in a
terminal; callers matching those sentences verbatim should match on
`INCOMPLETE` instead.

### Behaviour change (scheduler): a glob's static prefix ends on a base character (T-170)

`staticPrefix` in `@mapctx/planner` cuts a declared pattern at its first
wildcard, and `pathOverlap` compares the pieces with `startsWith`. Cutting
there can land in the middle of a combining sequence, and since every canonical
form sorts such a run by canonical combining class, a prefix ending mid-run is
not a reliable prefix of anything. Trailing combining marks are now dropped, so
the prefix ends on a base character.

This closes the last reordering hole left by T-166: `src/à*` against the
canonically equivalent `src/ạ̀.ts` — dot-below (ccc 220) sorting ahead of grave
(ccc 230) — now serializes again, as it did before the scheduler normalized at
all. Across 18 declared-path shapes against an `a47024c` build, 8 go from
parallel to serial, 10 are unchanged, and **0 narrow**.

The class is `\p{M}`, not `\p{Mn}`: 27 of the combining marks that canonical
ordering reorders are *spacing* marks (U+302E/U+302F Hangul tone marks, U+1B44
Balinese adeg adeg, U+1715 Tagalog pamudpod), and a nonspacing-only trim leaves
the bug reachable through every one of them — measured, both shapes stay broken
under `\p{Mn}` and are fixed under `\p{M}`.

It costs breadth, in the conservative direction: an accented glob now also
matches its bare base letter, so `src/café*` collides with `src/cafe.ts` as
well as with `src/café.ts`. That can serialize two tasks that touch genuinely
different files, which is the error this comparison is required to prefer — and
two named tests pin it so it is not rediscovered as a defect.

`mapctx plan --json` on the reference board is byte-identical before and after,
modulo the cwd-derived `tasksFilePath`, measured on one pristine copy of the
store per run. On that board the trim cannot run at all: of the 253 distinct
declared paths behind its 173 derived claims, 0 carry a wildcard construct, so
`staticPrefix` returns before reaching the trim. The equality is therefore
structural rather than a coincidence of the current board.

Migration: none unless a caller declares an accented glob and relies on it not
matching the unaccented spelling.

### Public contract: `task acceptance approve --json` output shape

`approve` now routes every selection through the batch path, so its result
carries `approved: [criterionId, ...]` and `alreadyApproved: [criterionId, ...]`
instead of a single `criterionId`/`state` pair:

```
before:  {"ok":true,"revision":1,"criterionId":"350d45b5-…","state":"approved"}
after:   {"ok":true,"revision":1,"approved":["350d45b5-…"],"alreadyApproved":[]}
```

**The pre-existing invocation is unchanged in practice**: for a single explicit
selection (`--index <n>` or `--criterion-id <id>`) the output still carries
`criterionId` and `state` alongside the new fields, so the change is purely
additive there and no existing caller breaks. The batch-only shape applies to
`--index` with a list and to `--all`, both of which are new in this release and
never had the old shape. No consumer in this repository read either field.

### Public contract: closing a task expires a dead lease instead of "releasing" it

`task move --status done` (and `cancelled`/`archived`) used to journal a
`task.claim-released` for whatever claim row the task still had marked
`active`, without looking at the lease. A claim row stays `active` until
something re-claims the task or a sweeper touches it, so a task whose lease
expired days earlier was closed with a release event for a lease nobody held —
a fiction in an append-only log, attributed to whoever ran the close.

Closing a task now reads the lease and journals what is true of it:

| At close time | Journaled | Result field |
| --- | --- | --- |
| live claim | `task.claim-released` by the closing actor (unchanged) | `releasedClaimId` |
| expired claim | `task.claim-expired` by `system` | `expiredClaimId` |
| no claim | nothing (unchanged) | neither |

`task.claim-expired` is the same event claim admission already journals when it
reclaims over a dead lease, so a closed task ends in the same state a reclaim
would have left it in: the row moves to `expired` and `executionState` leaves
`claimed`. Both events are appended in the same transaction as the planning
move, so a close is still all-or-nothing.

For a consumer, a close over a dead lease stops reporting a release and starts
reporting an expiry: pair a close with **either** event, not with
`task.claim-released` alone.

Both fields are reported by every closing path — `task move --status
done|cancelled|archived` and `task finish`, the latter including
`--no-snapshot` and the checkpoint-failure result, whose job is to make a split
state explicit and so has to name the claim effect too. Each field is present
only when it happened, so `"releasedClaimId" in result` is now an honest test;
it used to be an always-present `undefined`, answering `true` for a close that
released nothing. `--json` output is unchanged by that detail, since
`JSON.stringify` already dropped the undefined — the difference is visible to
an in-process caller.

Why the event rather than silence: `task.claim-expired` is also what clears
`executionState` and moves the row out of `active`, so journaling nothing would
leave a closed task reading `executionState: "claimed"` over a lease nobody
holds, plus an `active` row that nothing could retire — claim admission refuses
a terminal task before reaching its own expiry branch, so for an
already-closed task reclaim is not a cleanup path at all.

### Public contract: the lease is derived from the plan, not a fixed 30 minutes

Every claim used to last 30 minutes, whatever the work was: an `Easy`/`30m`
task and a `Hard`/`2d` task got the same window, and the long one expired
mid-flight — 26 renewal events across 162 claims in this store, only 8 % of
claims ever renewed at all. The inputs for a better number were already
mandatory (a claim is refused without `workload` and a parseable
`estimatedEffort`) and were simply discarded.

`task claim` and `task start` now compute

```
lease = clamp(estimatedEffort × leaseFactor, defaultLease, maxLease)
```

with `leaseFactor = 0.5`, `defaultLease = 30m` and `maxLease = 8h` — the
figures decision D10 approves **as a starting point**, to be re-derived once
C4's heartbeat exclusion makes receipt durations trustworthy. A task with no
parseable estimate (an epic, which is not required to carry one) gets
`defaultLease` whole, which is exactly the old behaviour.

**`task renew` extends by the same derived duration**, re-read from the plan at
renewal time rather than remembered from the claim. So re-classifying a task
mid-flight (`task update --set workload=Hard` with the estimate, which the
skills ask for) is honoured by the next renewal; leaving renewal on the
constant would have reproduced the original bug one step later — claimed for
8 h, renewed for 30 min. `--lease` is not offered on `renew`: it is one number
with one decision behind it.

New `--lease <duration>` on `task claim`/`task start` takes `30m`, `4h`, `1d`,
`1w` (the `estimatedEffort` vocabulary) and **wins over config and over the
derived value**. It is not clamped by `maxLease`: the flag is the operator's
explicit choice, and silently shrinking `--lease 12h` to 8 h is the sort of
quiet adjustment this CLI refuses elsewhere. An unparseable value is refused
with the accepted formats.

Not clamped is not unbounded, though: **above 24 hours `--lease` is refused**
(exit non-zero, naming the ceiling), rather than shrunk. That is D4's absolute
ceiling, declared once as `ABSOLUTE_LEASE_CEILING_MS` and enforced here on the
only surface that can currently exceed it; C4 extends the same number to the
renewal paths. `--lease 9999w` used to be accepted and wrote an expiry in 2072.

`task renew` **refuses `--lease`** instead of ignoring it. The flag has to live
in the CLI's single flag table for claim/start to accept it, so the parser took
it on `renew` too and dropped it on the floor while this file said it "is not
offered" — a reader takes that for a refusal, and it now is one.

**Known coupling, by design and worth stating:** a renewal re-reads
`detail.estimatedEffort`, and nothing requires whoever edits that field to hold
the claim. So a third party raising it lengthens the holder's next renewal, and
lowering it pins their renewals to `defaultLease`. That is the price of
honouring a mid-flight re-classification, which is the behaviour the skills
ask for; whether editing the estimate under a live claim should require being
the holder is a C3/C5 decision, not a C2 one.

Optional tuning in `mapctx.toml`, absent by default:

```toml
[coordination]
leaseFactor = 0.5
defaultLease = "30m"
maxLease = "8h"
```

An absent file, an absent table and an absent key all mean the defaults above.
Unlike `[privacy]`, a malformed value here is **refused when the file is read**
rather than degraded to the default — including `defaultLease > maxLease`,
which leaves the clamp no room. A lease is an exclusivity window, and an
operator who typed `maxLease = "2h"` must not silently get eight hours.

Migration: nothing to do, but expect longer leases than 30 minutes wherever
`estimatedEffort` exceeds one hour, and a correspondingly longer wait before
another agent can reclaim a task whose holder died. That trade is why
evidence-based liveness (C4) is designed alongside this change rather than
after it.

### Public contract: a claim carries two capabilities, and renewal has a dispatch address

Renewal used to require `--claim <id> --token <leaseToken>`, and `leaseToken`
is printed once, to whoever ran `task claim`/`task start`. An orchestrator that
dispatched the work holds the `dispatchId` and not the token, so it could not
keep the lane alive; the executing agent had to interrupt itself to do it by
hand, and the measurement says it does not happen (26 renewals across 162
claims; 8 % of claims ever renewed).

A claim now carries **two independent capabilities**, both minted from the same
CSPRNG at claim time and both scoped to the `claimId`:

| Credential | Renews | Releases |
| --- | --- | --- |
| `leaseToken` | yes | yes |
| `renewToken` | yes | **no** |

`task claim` and `task start` return both to the holder — it already has the
stronger one — so an agent can hand `renewToken` to its orchestrator and keep
release authority to itself. The split is by **possession**, not by derivation:
an earlier draft proposed `HMAC(leaseToken, …)`, which still requires reading
the secret it was meant to avoid. Two random values compared for equality need
no algorithm and no second lookup. Release has no `renewToken` branch at all,
which is what makes the split real rather than checked. Both comparisons are
constant-time.

`task renew` takes **exactly one address and exactly one credential**:

```
mapctx task renew <task-id> (--claim id | --dispatch id) (--token leaseToken | --renew-token renewToken)
```

`--dispatch` is a **lookup**, not a scope: dispatch → task → that task's active
claim. A claim carries no dispatch reference (`task claim` mints one with no
dispatch at all, and one claim legitimately spans the attempts of a retry), so
`task_id` is the only edge there is, and the token's lifetime stays the claim's.
With `--dispatch` the task id in the command is checked rather than used, and a
dispatch belonging to another task is refused. `--claim/--token` is unchanged
and remains the only renewal path for a claim that has no dispatch.

Two new refusals on that path, each by name: a dispatch whose **latest attempt
already has a receipt** cannot renew (that lane reported itself finished — admit
a new attempt first), and a lookup that resolves **more than one** active claim
refuses and asks for `--claim` instead of picking one. The second is
unreachable today, since the partial unique index allows one active claim per
task; it exists so that stays an index guarantee rather than a coincidence when
C5 introduces shared review claims.

**A renewal discloses exactly what the presented credential already proves.**
With `--token` the result is the claim record as before, tokens included — that
caller holds the stronger capability already, and it stays the tested contract
0.4.0 shipped. With `--renew-token` the result carries **no token at all**: an
orchestrator that may renew must not be handed release authority as a reward for
renewing, which would void the split. Either way `expiresAt` is the answer a
renewal owes, so a consumer that reads only that works on both paths.

`task renew` also **refuses `--dispatch-id`** by name, pointing at `--dispatch`.
It is the spelling `task start` uses for the same identifier and a known global
flag, so the parser would have accepted it and renewed nothing while exiting 0.

**Legacy claims keep working and gain nothing.** Migration **12** adds a
nullable `renew_token` column with no backfill and no default. A claim made
before this release has no `renewToken` and never will — its holder was handed
one token, and minting a second now would create a capability nobody was ever
given. A `DEFAULT` would be worse: every legacy row would share one value, and
presenting it would renew any of them. `--renew-token` against such a claim is
refused as `renew-token-unavailable`, naming the remedy (`--token`), rather than
compared against NULL. Schema 11 is deployed, so it is frozen; this is additive
on top of it, and a CLI that knows only versions ≤ 11 never reads the column.

**Editing the estimate under a live claim now says so.** A renewal re-derives
the lease from `detail.estimatedEffort` (0.4.0, above) and nothing requires the
editor to be the holder, so `task update --set detail.estimatedEffort=…` prints
a note on stderr when the task has a live claim, naming the claim by id (never
a token) and stating that the next renewal will use the new figure. The edit
still lands: freezing the duration on the claim would undo the deliberate
decision that a mid-flight re-classification is honoured, and requiring
holdership is a role-aware question that belongs with C5.

### Public contract: liveness events renew a lease and never count as work

`mapctx run event <dispatch-id> --type heartbeat|progress` records one liveness
event and, as a by-product, renews that lane's claim — addressed by the
dispatch id, with **no token**. It exists because renewal needed a credential
printed once to whoever opened the lane, so the agent doing the work had to
interrupt itself to stay alive, and measurably did not: 26 renewal events
across 162 claims, 8% of claims ever renewed. Emit one where the run already
pauses — after a suite, between slices.

The event is always recorded; whether it renewed is reported separately in
`renewal`. It does **not** renew when the event is on an attempt older than the
dispatch's latest, when that attempt already has a receipt, when the task has
no active claim or more than one, when the claim has expired, or past the
ceiling below. `--attempt` defaults to the latest attempt and naming an older
one is refused; `--sequence` defaults to the next unused one for that attempt.

**The 24-hour ceiling (D4) now binds how long a claim can live at all**, not
just how long renewals may extend it, measured from the claim's original
`claimedAt` rather than from its current expiry — a ceiling measured from the
thing it constrains is no ceiling. Two halves:

- **Minting.** `[coordination] maxLease` above 24 h is now **refused** when the
  config is read, with the message naming the ceiling, rather than quietly
  minting a claim nobody may renew. Before this, `maxLease = "30h"` produced a
  30-hour claim through the derived path while `task start --lease 30h` was
  refused by name for exactly the same number. The default (`8h`) is unchanged,
  and no claim in any store was ever held past the ceiling.
- **Renewal.** Inside the window a renewal that would reach past the ceiling is
  clamped to it; past it nothing extends the claim and only a fresh `task
  start` opens a lane. `task renew` gains the refusal `ceiling-reached` for
  that case — reachable only outside the default configuration, since with any
  lease of 24 h or less the clamp means you meet plain `expired` at the ceiling
  first. When that happens the expiry message now says the 24-hour limit was
  also reached, so a lane that dies exactly at the ceiling says why.

The clock is the local clock of whichever process renews, which is the same
trust level as the rest of the local CLI.

A `run event` that records its event but renews nothing still exits 0 — the
event is the deliverable — and now also prints one warning line to stderr
naming the reason, so a renewal loop that only checks exit codes cannot miss
that its lane stopped being kept alive. `stdout` is unchanged.

**Measurement change, observable:** `heartbeat` and `progress` events no longer
count as interior events when a receipt's active time is measured. Proving you
are alive is not evidence of work, and counting it as such inverts the
measurement — a four-hour run emitting one every ~20 minutes has no gap under
the 10-minute idle threshold, so it would measure ≈0 active time **and** lose
the honest `substituted` coverage label, making the corrupted sample look more
trustworthy than the one it replaced. The exclusion covers the whole vocabulary
this command can write, not just `heartbeat`, because the collapse is a
property of the cadence: `progress` at the same spacing reproduces it exactly.
Work measurement still comes from `timeEvidence`, which takes precedence, and
from executor boundary events, neither of which this command writes.

**Nothing in the store is re-measured by this:** there are 0 run events against
152 receipts today, because nothing has ever emitted one. The change is
forward-looking, and a receipt whose events are all liveness measures exactly
what it measured before — wall clock, labelled `substituted`.

### Features

* **feature:** `mapctx --help` prints an "Enumerated values" table for every
  enumerated flag, with the schema-derived rows marked, plus sections on prose
  ownership and output channels
* **feature:** `mapctx validate --task <id,...>` filters issues by task,
  `--baseline <file>` fails only on an issue the board did not already have, and
  `--write-baseline <file>` records the current run
* **feature:** `externalLinks` is editable through `mapctx task update --set`,
  validated as `https://host/...` (http too) or `provider:entity:id`
* **feature:** list-valued `--set` fields and `--tags`/`--domains`/`--depends-on`/
  `--blocking` accept a bare comma list or a JSON array, and refuse a bracketed
  guess instead of storing the brackets as part of the values

* **feature:** acceptance in one step: `task create --acceptance-file <path>`, or a
  `## Acceptance` section in `--description`/`--description-file`, records the
  criteria as revision 1 in the SAME transaction as the task, so a failure
  creates neither. `--acceptance-file` wins over the description's section and
  says so; a checklist with no `## Acceptance` heading is reported and not
  recorded
* **feature:** `task acceptance approve --index 0,2,5` and `--all` approve
  several criteria in one transaction, under one `--expect-revision`, with one
  `--evidence` set; a mid-batch refusal approves nothing. `--all` skips
  already-approved criteria and reports them, while naming one that is already
  approved is refused
* **feature:** `task acceptance revise --expect-title "<title>"` refuses when
  the task is titled differently, catching a revise aimed at the wrong id --
  which a revision check cannot catch, since a fresh task satisfies
  `--expect-revision 0` as well
* **feature:** `acceptance import --task T-1,T-2` narrows the import; an id
  that does not exist is refused instead of importing a smaller set in silence
* **feature:** `task acceptance revise --from-file` accepts a bare `- [ ]`
  checklist when the file has no `## Acceptance` heading, and reports on stderr
  which reading it used
* **fix:** `--expect-title` normalizes Unicode to NFC before comparing, so an
  NFD argument matches an NFC stored title instead of refusing with two strings
  that render identically; a genuine mismatch that still looks identical now
  reports the differing code points
* **fix:** recording an acceptance revision with no criteria (a source holding
  only the `## Acceptance` heading) warns that `task finish` will refuse until
  it is revised with criteria, instead of silently building a task that cannot
  be finished
* **fix:** `--all=true` is refused rather than silently dropped, and a missing
  `--acceptance-file` names the flag and the resolved path instead of returning
  a bare ENOENT

### Fixes

* **fix:** the `task update` unknown-field refusal names both the task and the
  `detail.*` field groups and redirects a field used on the wrong side
* **fix:** a flag written without its value is refused instead of swallowing the
  next argument (`--actor --json` used to journal an event attributed to
  `"--json"` in the append-only log). The test is pertinence, not shape, so a
  value that merely looks flag-ish (`--title "--foo is a flag"`) still works
* **feature:** `--flag=value` is accepted for value-taking flags, which is how
  you pass a value that is itself a flag name (`--query=--json`)
* **feature:** `mapctx task finish <id> --no-snapshot` (or `--snapshot none`)
  applies the canonical done gate without regenerating TASKS.md or tasks/*.md
  and without journaling a checkpoint — for a shared checkout where rewriting
  every mirror would mix generated files into uncommitted work. The default
  still publishes; the success result carries
  `snapshot: "published" | "skipped"` and omits `checkpoint` when skipped.
  It is a durability trade: the committed checkpoint is what `mapctx store init`
  recovers from, so publish with `mapctx export` at wave-end or epic-end — one
  export captures every previously skipped task, because a checkpoint carries
  the filesHash of the whole mirror set. `--snapshot task` is refused by name
* **fix:** an acceptance refusal from either closing path (`task finish` and
  `task move --status done`, which have always shared the gate) now names the
  command that closes a task and mentions `--no-snapshot`
* **security:** a refused claim no longer discloses the holder's `leaseToken`.
  `task claim` and `task start` against a task somebody else holds used to
  return the whole claim record — including the lease token, which is the
  bearer credential for `task renew` and `task release` — so any agent that
  merely tried to claim a busy task could take over or drop that lease. The
  token is now stripped at the source by a single `disclosableClaim` allowlist
  in the store, so no print site can reintroduce it, and it is gone from both
  `--json` and human output. The refusal still carries `claimId`, `holder`,
  `expiresAt`, `state` and the journal coordinates, and in human mode the
  `Error:` line now names the claim, its holder and its expiry so you can
  decide to wait or escalate without `--json`. A holder still receives its own
  token from a successful `task claim`/`task start` and from `task renew`.
  **This stops new disclosures but rotates nothing:** `task renew` extends a
  lease without reissuing its token, so a token printed by any pre-0.4.0 build
  stays valid until that lease expires or is released. If a pre-fix claim
  refusal may have reached a CI log, a transcript or a shared terminal,
  release those leases and re-claim them rather than waiting them out.
  Rotating the token on renew is a separate change
* **fix:** `externalLinks` refuses userinfo credentials (`https://user:pass@...`),
  caps each link at 2048 characters, and matches the `scheme:word:rest` provider
  form case-insensitively
* **fix:** a missing `--expect-revision` refusal reports the revision the store
  currently holds
* **fix:** list elements may not contain a comma, and a `{...}` group split
  across a comma is refused: the generated snapshots cannot represent either,
  and the resulting drift did not converge
* **fix:** `task update --depends-on a,b` with no `--blocking` (and the mirror
  case) no longer deletes the other kind's dependency edges. Supplying one list
  used to drop BOTH the `depends-on` and the `blocks` edges and re-add only the
  kind the patch carried, while the detail list was rewritten only for the list
  supplied — so the edges lost a real `blocks` relation while
  `detail.blocking` still advertised it, which is the one thing these flags
  exist to prevent. Under `plansAuthority: store` the loss is silent: `plan`
  and `gantt` read the edges, and `export` rebuilds both detail lists FROM the
  edges, so the regenerated `tasks/<ID>.md` looks self-consistent and the next
  export erases the orphaned list for good. Each flag now replaces exactly its
  own kind and an omitted flag leaves its kind untouched. `mapctx validate`
  reports an existing divergence per task and kind as
  `dependency-detail-divergence`; **repair an affected task by replaying BOTH
  lists through one update** — `mapctx task update <id> --depends-on a,b
  --blocking x,y`, spelling an empty list as `""` (omitting the flag is now a
  no-op on that kind, so it would leave the divergence in place)
* **fix:** `--set detail.prerequisites=...` and `--set detail.blocking=...`
  are refused. Those two lists are not fields, they are a rendering of the
  task's dependency edges — `export` builds them from the edges, `reconcile`
  diffs them against the edges, and `plan`/`gantt` read only the edges — so
  writing one on its own moved the rendering while the thing it renders
  stayed put. The refusal names the flag that writes both surfaces in one
  event: `--depends-on` for `prerequisites`, `--blocking` for `blocking`.
  Both keys are gone from the patchable-detail list in `--help` and in the
  unknown-field refusal. The library's `createTask` likewise refuses a
  `detail.prerequisites`/`detail.blocking` that disagrees with its
  `dependsOn`/`blocking` argument (compared as sets, so order and duplicates
  are not a disagreement) and derives the stored lists from the edges; the
  CLI's `task create` never exposed those two, so no `task create` invocation
  changes
* **fix:** `mapctx validate` reports `bulk-updated-timestamp` as `info`
  instead of `warning`, and adds `info` as a severity that counts as neither
  an error nor a warning. A shared `updated` date is what an ordinary day of
  board work looks like — one export stamps every task it rewrites — so it
  proves nothing and no action clears it; as a warning it was permanent noise
  that trained operators to stop reading the command (the live board shows
  four). An `info` never gates: `--write-baseline` does not record one, and
  no baseline entry can suppress one, so an observation cannot be hidden by
  accepting it. A baseline recorded before this change reports its
  `bulk-updated-timestamp` entry as stale `not-reported` — the warning it
  recorded no longer exists, so drop that entry. The legacy Markdown
  validator behind `validate --snapshots` still reports the same code as a
  `warning` in `snapshots.structural`, so a `--json` consumer sees the
  observation twice with two severities; it never affects the exit code
* **fix:** a claim's `claimedAt` and `expiresAt` now come from one clock
  read, so `expiresAt - claimedAt` is exactly the lease that was applied.
  Before this, both values came from two reads, so the recorded lease was a
  few milliseconds short of the real one, and the 24 h ceiling, measured
  from `claimedAt`, ended that much earlier.
* **fix:** an internal CLI fault (`TypeError`/`ReferenceError`) now prints its
  stack on stderr after the `Error:` line, so the failing module is named.
  Refusals keep their exact shape (one JSON line under `--json`, then `Error:`).
* **fix:** a backup manifest carries `storeSchemaVersion`, the archived
  database's own schema. `schemaVersion` stays the writing binary's newest
  migration, and the restore gate keeps reading it. In a pre-migration
  snapshot, `storeSchemaVersion` is the version before the upgrade, and
  `store backups` lists that version.
* **fix:** `mapctx store repair` no longer reports `pre-migration snapshot
  SKIPPED (Store is under maintenance (repair) by pid N ...)` while migrating
  the store anyway. `repair` holds the maintenance lock and then opens the
  database — and that open is what applies a pending migration — so the
  pre-migration hook was refused by the lock naming its own holder. Since
  every read refuses a store with a migration pending, `store repair` is the
  path an operator is sent down to migrate one, and it was the path with the
  bogus warning. The lock is unchanged: the holder now publishes the archive
  it already took, the hook verifies that archive holds the exact state the
  migration is about to rewrite (same `storeSchemaVersion`, same `eventCount`)
  and names it, and anything else makes it take its own snapshot. A SKIPPED
  can no longer be the lock refusing itself, and one taken under another
  process's live lock is still refused.
  **What changes for you:** after a migration applied by `store repair` there
  is **no archive with `reason: pre-migration`** — the rollback point is the
  `pre-repair` archive of that run, and `storeSchemaVersion` (which
  `store backups` prints) is what identifies the schema it holds. Look for the
  version, not the reason. An ordinary command that migrates still writes its
  own `pre-migration` archive, as before.
* **fix:** automatic-snapshot retention always spares the newest archive of the
  schema below the newest schema archived — the rollback point of the last
  migration. Retention counts directories, and a count cannot tell the only
  copy of the previous schema from the fifth copy of the current one: five
  ordinary repairs after an upgrade used to evict the single archive that made
  that upgrade undoable, leaving five archives the store can reproduce and
  none it cannot. Exactly one directory is spared, so the retention limit can
  be exceeded by one, and it stops being spared once a newer migration is
  archived. Archives from before `storeSchemaVersion` existed state no schema
  and never claim the exemption.
