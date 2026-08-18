# Dispatch / attempt lifecycle

A `dispatchId` identifies one logical unit of work sent to an executor
(Traycer, Orca, Paperclip, ...). A dispatch can be retried; each try is a
distinct `attempt` (1, 2, 3, ...) carried on `DispatchEnvelope`, `RunEvent`,
and `RunReceipt` alongside the same `dispatchId`.

## Per-attempt state machine

`Dispatch.status` (`dispatchStatusSchema` in `entities.ts`) is the lifecycle
of a single attempt. `DISPATCH_TRANSITIONS` in `state-machines.ts` is the
transition table, same pattern as `PLANNING_TRANSITIONS` /
`EXECUTION_TRANSITIONS`:

```text
claimed   -> running, cancelled, expired
running   -> blocked, completed, failed, cancelled, expired
blocked   -> running, failed, cancelled, expired
completed -> (terminal)
failed    -> (terminal)
cancelled -> (terminal)
expired   -> (terminal)
```

Terminal states have no outgoing transitions. A retry after `failed` is a
**new** `Dispatch` row with `attempt + 1`, starting again at `claimed` — never
a transition on the old attempt's state.

## Why late receipts must be rejected

Attempt 1 can fail, attempt 2 gets dispatched, and attempt 1's `RunReceipt`
can still arrive afterward (slow executor, retried network call, replayed
webhook). If that stale receipt were accepted, it could overwrite attempt 2's
real, more recent outcome. `changedFiles`/`usageEvents`/`evidence` on the
receipt are also the only ground truth the rest of the system has (see ADR
0003, "Resource claims are advisory" — everything derived from a receipt is
post-hoc, never real-time), so accepting the wrong attempt's receipt corrupts
that derived state permanently.

`attempt-lifecycle.ts` makes the accept/reject decision a pure function:

```ts
evaluateRunReceipt(history: DispatchAttemptHistory, receipt): ReceiptDecision
```

Given the attempts dispatched so far for a `dispatchId` and which of them
already have an accepted receipt, it accepts a receipt only for the latest
known attempt that has not already been accepted; otherwise it rejects with
`dispatch-mismatch`, `unknown-attempt`, `stale-attempt`, or
`duplicate-receipt`. No storage is involved — `DispatchAttemptHistory` is an
in-memory value the caller builds. `recordAttempt` / `recordAcceptedReceipt`
are pure reducers over that value. T-058 wires this to a real store; this
package only guarantees the decision function is correct and exhaustively
tested (`attempt-lifecycle.test.ts`).

## Failure detail

`RunReceipt.failure` is `FailureDetail | null`: required (non-null) exactly
when `outcome === "failed"`, `null` otherwise — enforced by a `superRefine` on
`runReceiptSchema`. `FailureDetail.category` is a closed enum
(`executor-error`, `timeout`, `policy-violation`, `context-mismatch`,
`cancelled-by-operator`, `unknown`) plus a free-text `message` and a
`retryable` flag, so a caller deciding whether to spawn the next attempt
doesn't have to parse prose.
