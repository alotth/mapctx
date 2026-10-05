---
kind: review
title: "T-116 attempt 7 independent review"
---

# Verdict: PASS

Both operational gaps are fixed end to end. Attempt 5 invariants remain
intact; attempt 7 changes are confined to the requested CLI flag plumbing,
OpenCode source pinning, tests, and durable review doc.

## Findings validated

- **Public `--include-inferred` path — PASS.** Parser stores the flag;
  `mapctx` forwards it to `historyScanCommand`; command passes it into
  `buildApprovalTemplate`. CLI E2E proves default template excludes degraded
  mixed session and opt-in template emits it with
  `intendedTier: "inferred"`.
- **OpenCode source pin — PASS.** Hash includes session id, directory, title,
  and every scanned message/part/prompt row. Row payloads are SHA-256 digested
  at full length; timestamps/update timestamps participate; canonical sort
  removes SQLite row-order dependence. Only resulting hex digest is emitted;
  transcript text remains out of report/template.
- **Stale approval guard — PASS.** E2E proves same DB content yields stable
  pin, reversed insertion order yields same pin, appended part/title edit
  changes pin, and stale CLI approval refuses before evidence/correction or
  task lifecycle changes. Commit's source/link preflight precedes its write
  transaction, so refusal appends no journal event.
- **Attempt 5 null aggregate guard — PASS.** Existing regression verifies
  inferred-only cache/Gantt `activeMs: null`, while mixed history exposes
  exactly the numeric sum of measured rows. Attempt 7 did not change this
  code path.
- **Prior attempt 4 guards — PASS, carried forward.** Per-session tiering,
  explicit inferred intent, fail-closed path truncation, atomic approval,
  correction scope/replay, receipt-only calibration, and tier-honest UI
  unchanged by this delta; attempt 5 re-review had these passing.

## Acceptance coverage

All six T-116 criteria remain covered by attempts 4–5; this attempt directly
revalidated approval and source-version pin requirements:

1. **Repository/worktree scope — PASS, carried forward.**
2. **Lifecycle-independent evidence — PASS, carried forward.**
3. **Auditable correction and invalid-data exclusion — PASS, carried forward.**
4. **Done-task backfill without dispatch/reopen — PASS, carried forward.**
5. **Dry-run approval, explicit intent, idempotency — PASS.** Public CLI E2E
   now reaches inferred opt-in; content changes invalidate stale approval.
6. **Tiered reconstruction — PASS, carried forward.** Inferred-only active
   time stays null; shipping dataset and UI preserve evidence tier. Live
   recovery remains coordinator-owned and has not run.

## Verification

- Used `/tmp/mapctx-t116-verification/delta-attempt7.json` against
  `/tmp/mapctx-t116-baseline/manifest.json`; did not use HEAD. Pre-existing
  T-099..T-102/T-106 dirt and lifecycle snapshot noise are not findings.
- Full sync-engine suite: **103 passed**; roadmap UI: **22 passed**.
- Focused public-CLI and SQLite-source-pin E2E: **2 passed**.
- Fixtures and temporary stores only. No source, board, or real-store
  mutation; no live approvals or corrections.

