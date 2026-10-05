---
kind: review
title: "T-099 independent review — attempt 2"
comments: none
---

# Headline: FAIL

All five findings from the first review are fixed in the current worktree. T-099 still is not ready to close: one provenance path violates the new/edited-estimate contract, and two validation edges can crash or admit a zero-duration plan. Review is code-based against `7fdc161`; no tests were run, per operator instruction.

## Findings

### P1 — reconcile bypasses and cannot reconcile effort provenance

`estimatedEffortSource` is now a persisted structured detail field, but the reconcile diff omits it ([`packages/store/src/reconcile.ts:76`](../../../packages/store/src/reconcile.ts#L76)). Accept copies only fields returned by that incomplete diff ([`packages/store/src/reconcile.ts:137`](../../../packages/store/src/reconcile.ts#L137)). Two failures follow:

- changing only `estimatedEffortSource` in generated Markdown is real byte drift, but task reconcile reports no drift and can neither accept nor discard it;
- changing a legacy `estimatedEffort` through the documented manual-reconcile path updates the value without setting `estimatedEffortSource: agent-active`, so a newly edited estimate remains classified `legacy-human`, contradicting ADR 0003's new/edited-estimate rule.

Required adjustment: include provenance in detail reconciliation, validate/normalize it, and force `agent-active` when accepting an effort-value edit. Add regressions for source-only drift and legacy-effort edit acceptance.

### P2 — clearing effort through supported `task update` syntax throws

CLI parses every `--set ...=null` as JavaScript `null` ([`packages/sync-engine/src/mapctx-cli.ts:924`](../../../packages/sync-engine/src/mapctx-cli.ts#L924)). Effort validation skips non-strings, then normalization unconditionally calls `.trim()` when the value is defined ([`packages/store/src/tasks.ts:314`](../../../packages/store/src/tasks.ts#L314), [`packages/store/src/tasks.ts:343`](../../../packages/store/src/tasks.ts#L343)). Therefore `mapctx task update T-### --set detail.estimatedEffort=null` crashes instead of producing a normalized missing plan or a structured refusal. Workload already supports this clearing form.

Required adjustment: define the clearing contract explicitly—normalize null to the store's empty-string representation, or reject it as `invalid-estimated-effort`—before any string method call. Add store and CLI coverage.

### P2 — “strictly positive” parser can return zero milliseconds

Parser checks the decimal amount before conversion, then rounds converted milliseconds without checking the result ([`packages/protocol/src/effort.ts:14`](../../../packages/protocol/src/effort.ts#L14)). For example, `0.0000001m` passes the positive check but rounds to `0`. Create/update/claim accept any non-null parse, while Gantt later treats zero as no denominator ([`packages/sync-engine/src/gantt.ts:394`](../../../packages/sync-engine/src/gantt.ts#L394)). This bypasses the promised positive-duration gate.

Required adjustment: compute once, return null unless the rounded result is finite and greater than zero, and pin a sub-millisecond case in parser plus boundary tests.

## Prior-review fixes confirmed

- Valid effort now owns `planned.durationMs` and `actualVsPlannedRatio` even with dates; dates remain bar placement. Combined dates+effort coverage exists.
- Canonical `Easy | Normal | Hard | Extreme` validation and shared positive effort parsing reach create, update, and claim; missing fields retain repair commands and epics remain exempt.
- Repository-tracked `skills/mapctx-traycer/SKILL.md` now records create-time workload/effort gate and `1d=8h`, `1w=40h` agent-active convention.
- Pre-cutover Markdown Gantt reads task detail effort and provenance; CLI-level duration-only coverage exists.
- Direct v5→v6 migration coverage asserts nullable legacy provenance; import→projection→export→re-import coverage preserves `agent-active`.

## Other T-099 behavior confirmed

- `aligned-from-actual` is emitted only for done work with a receipt and no valid effort/dates; planned ratio is null and accuracy eligibility false.
- Done work without a receipt is `no-measurement`; it contributes no fabricated duration sample.
- UI exposes planned duration/source, aligned exclusion, substituted active-time coverage, and no-measurement state.
- T-078 and T-090 are normalized from `Medium` to `Normal`; approved open-task workload backfill matches the reviewed snapshot.
- `task create` help and ADR 0003 document agent-active units; invalid effort falls back honestly to calendar duration only when dates exist.

## Review boundary

Baseline dirt in `/Users/alt/repos/mapctx` for `TASKS.md`, T-096, ADR 0003, and Workspace V2 CSS/JS was compared and excluded. No source, tests, or MapCtx state was changed by this review.
