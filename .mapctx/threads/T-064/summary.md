# Working Summary - T-064

## Outcome

T-064 complete. RunEvents persist append-only and forecast activeTime now uses stored intra-run timestamps with explicit durable coverage.

## Decisions

- Persist every schema-valid RunEvent.
- Projection identity: dispatchId + attempt + sequence.
- Exact retry is duplicate; divergent same identity is conflicting and never overwrites.
- Only timestamps strictly inside receipt boundaries establish measured coverage.
- Gantt prefers EstimateSnapshot.durationCoverage; assumptions remain legacy fallback.

## Evidence

- Manual pre-cutover proof: wall 29,400,000ms; measured active 600,000ms; idle removed 28,800,000ms; receipt-only control 29,400,000ms substituted.
- Protocol 18/18; store 30/30; forecast 16/16; sync-engine 40/40; git diff check clean.
- Fresh re-review: zero blockers.
- No cutover performed.

## Next Action

T-066 is unblocked: run first real cutover and verify recovery checkpoint.
