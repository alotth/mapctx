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
with the accepted formats. (The bound on a very long lease is C4's 24 h
absolute renewal ceiling, which lands with the heartbeat path.)

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
