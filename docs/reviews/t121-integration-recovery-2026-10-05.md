# T-121 integration and authorized ELA recovery

Independent code review and its documentation addendum passed. The reviewed production/test files were copied byte-for-byte into the root checkout, together with the corrected worker report and its complete copy proof. Complete independent reviews and required assets are retained in [attempt 5](t121-independent-review-attempt5/index.md) and its [PASS addendum](t121-independent-review-attempt5/addendum/index.md); historical attempt-3 repros remain available. Lease values in promoted test logs were redacted, and the promoted asset manifests were recomputed.

## Integration verification

The global `mapctx` binary resolves to this repository's `packages/sync-engine/dist/mapctx-cli.js`. The root build completed and 55 renderer/checkpoint/push tests passed, exit 0. Carried independent full suites passed store 219/219 and sync-engine 131/131. Production files have no post-review semantic changes; this integration does not change schema, import parsing or historical receipts.

Root coordinator is Codex gpt-6.1-sol/high, agent 62b07524-92bd-4d70-8ff1-7fb45a52f902. Integration uses the existing T-121 dispatch c8adf88f-bc41-41ed-8719-5eadbbe2c844, attempt 6, with true claim start 2026-10-05T15:56:46.366Z. The attempt-5 worker used the user-authorized Codex gpt-6-luna. Earlier model phases and the invalid attempt-4 baseline are recorded in the worker report; none were reattributed to this integration. No token/usage counts are invented. Receipt times are captured from the real claim and clock after completion, not estimates.

## ELA outcome

After a confirmed no-write orchestration window and a fresh consistent backup, 54 authored Acceptance lines from incident fc3a5e2 were recovered in 15 tasks. Current input had zero authored lines inside Acceptance; current outside-Acceptance prose and all canonical criteria/revisions/states were preserved. The root CLI was rehearsed against the current ELA HEAD cc5b0d233b588195d0466d5428ce287e15bc820d before the real recovery.

Two actual CLI checkpoints (80aecd5b-39d8-455a-8b5e-ceb4959c554c and d5b14211-e5a2-45f8-add8-9daf8cd43a5b) published identical manifests of 319 files. All 3,222 previous events and journals remained exact. Only two checkpoint events/rows and the logical-clock increase were added; all domain tables were hash-identical. The wider update refreshed 293 task mirrors plus TASKS.md from pre-existing store drift. No Acceptance import/approval, task status move, repair/reset, Git commit/index change or remote operation was performed in ELA.

ELA has a complete durable report and JSON evidence in docs/engineering/mapctx-acceptance-prose-recovery-2026-10-05.{md,json}. Local backup/audits are at /tmp/ela-t121-coordinator-x1HetI. Snapshot validation has no drift; eight pre-existing invalid-specmode errors and ten timestamp warnings remain separate from this recovery.

## Boundaries

Publication refuses uncertain evidence association when criterion sequence changes, orphan evidence, unmatched fences and multiple real Acceptance sections. Evidence must be preserved and adjudicated rather than deleted to force publication. No new import semantics were introduced. The missing baseline for partial attempt 4 remains an explicit provenance limit; an actual root pre-integration manifest was captured for this delivery.

The actual recovery audit had a coordinator field-name error after the two successful exports: it looked for filesHash. It was corrected to compare files path/hash entries and actual bytes, then passed. This did not generate further events or repeat publication.

No stage/commit/push was performed. T-121 planning closure and its final MapCtx checkpoint follow explicit criterion approval against the independent review and real recovery evidence. Integration receipt JSON remains outside the committed tree.

## Attributable delta

[Physical-path delivery manifest](t121-integration-recovery-2026-10-05.delta.json). Seven existing root paths changed and 67 paths were added, including the complete promoted reviews/assets. The other 525 paths from the genuine root pre-integration manifest were unchanged before the final generated checkpoint. Aliases and inherited unrelated dirty work were not counted as new edits. ELA delivery lists the 15 recovered descriptions and two durable evidence files; generated mirror updates are recorded separately.
