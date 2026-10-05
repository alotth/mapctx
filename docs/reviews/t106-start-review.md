---
kind: review
title: "T-106 atomic task start review"
---

## Verdict: PASS

### Re-review

The initial fresh-start finding was incorrect: `task.claimed` projection advances execution from `unclaimed` to `claimed`, so fresh `--status running` follows legal `claimed → running`.

The completed/blocked retry defect is fixed in [dispatch.ts](../../packages/store/src/dispatch.ts): running retries journal `unclaimed → claimed` before dispatch projection applies `claimed → running`. The new start test asserts attempt 2 is `running` while attempt 1 receipt remains preserved and planning remains `review`. Fresh store and CLI tests exercise `--status running`.

## Validated

- `startTask` claims, transitions planning, and appends dispatch within one `runInWriteTransaction`; write lock, journal publication, and rollback are shared with the established store transaction primitive.
- Retry validates dispatch ownership and unknown IDs before claiming. Tests cover preserving attempt 1 receipt, adding attempt 2, and leaving planning in review.
- Fresh `task start --status running` is valid: `task.claimed` projection advances execution from `unclaimed` to `claimed` before dispatch.
- Completed retry with `--status running` now replays two legal execution hops, and retains attempt 1 receipt/status.
- Claim refusal and terminal/incomplete task gates produce no events; dispatch admission exceptions roll back staged claim/expiry/planning events, including durable journal state.
- `dispatch create` now requires a live claim; prior claim → dispatch sequence remains supported.
- Build succeeded; broad store/sync suite reports 218 passed, 0 failed; `git diff --check` passed.
- Historical receipt attribution/backfill issues remain out of scope, as directed.

## Scope

Reviewed T-106 additions only: `start.ts`/`start.test.ts`, claim and dispatch helper extraction/guards, export, CLI wiring and tests, and Traycer skill update. Pre-existing T-099..102 changes were excluded. No board, source, or dispatch state changed during review.
