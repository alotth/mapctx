# T-120 — canonical validation and final local checkpoints

The operational validator reads the canonical store and identity/project configuration. Local Markdown snapshots are inspected only with `mapctx validate --snapshots`. Routine claim/start/update/receipt/move no longer exports mirrors. Canonical Acceptance is edited through `mapctx task acceptance`; `mapctx task finish <id>` applies the completion gate and publishes a task-end checkpoint.

## Reviewed delivery

OpenCode `zai-coding-plan:glm-5.3-flash` implemented the change. Attempt 1 also continued under Codex after a session boundary; the switch operator/time is unknown. [Worker report](t120-store-validation-checkpoints-2026-10-05.md) records this and original receipt attribution errata. [Broad independent review](t120-independent-review-attempt3/index.md) passed with explicit fence limits. [Focal independent review](t120-independent-review-attempt6/index.md) passed evidence forwarding, preflight-before-write, absent-evidence null semantics and own special-key preservation.

Coordinator integrated the three final reviewed files byte-identically. Root build passed; sync-engine 124/124 passed. Root store 192/192 passed at the earlier integrated checkpoint, and its source is unchanged by the final three-file fix. Independent final focal suites passed 16/16. No claim that full preservation was rerun by that focal reviewer. Its initial accidental frozen-worktree build affected generated dist only; source hashes remained 43/43 exact.

## Explicit live adoption

Coordinator dispatch attempt 7 started at 2026-10-05T08:12:34.140Z. Fresh consistent backup contains 1,062 events, 96 receipts, 1,060 journals and 134 tasks, including T-119 attestation file and independent witnesses. It remains outside the repository at `/tmp/mapctx-t120-baseline/pre-live-coordinator-attempt7`.

Before migration, schema-9 `validate` reported maintenance-needed and left DB bytes unchanged. Explicit `store init` applied additive migration 10; migration checksums 1–9 and every original row were preserved. Acceptance dry-run left DB bytes unchanged. All source-byte pins were checked against current files before commit.

Explicit import recorded 109 sections, 25 absent, zero unreadable/empty. The 501 imported criteria include 371 observed checked and 130 observed unchecked criteria. Approval is observation of source checkboxes, not independent verification or inference from `done`. T-120 imported all seven pending. Repeating import recorded zero events and skipped 109 existing revisions.

Post-import canonical validation: **zero errors, three pre-existing bulk-timestamp warnings**. Read-only audit retained every original event/receipt/task/detail/dependency/evidence/correction row, every original journal hash, both T-119 historical rows in all eleven raw fields, attestation bytes, history-date bytes, identity/incarnation/createdAt and attested-node witnesses. Only explicit imported events and their new projections were added. [Preservation summary](t120-live-adoption-evidence/preservation-summary.json) and [validation result](t120-live-adoption-evidence/validation.json) are promoted without raw rows. Private proof scripts/results remain outside the repository; raw event/claim tables can contain lease tokens and are not promoted.

## Criterion verification

| Criterion | Evidence |
|---|---|
| Store/config-only read-only validation | Broad two-worktree/mirror-poison/maintenance tests; live schema-9 refusal byte identity and canonical zero-error result |
| Structural/dependency/state/completion gates | Broad poison/DAG/state/date and canonical Acceptance tests; completion gate independent of mirrors |
| Explicit honest migration/import and preservation | Source-byte pin preflight, 109 observed imports, idempotent rerun, original-row/journal/T-119 audit |
| Routine operations do not regenerate mirrors | Broad mutation/consumer tests; only explicit checkpoint exports retained |
| Final checkpoint behavior | Broad failure/race/retry and deterministic 135-file copy proofs; task finish is the supported final boundary |
| Explicit snapshots and Markdown compatibility; updated guidance | Broad compatibility and snapshot tests, ADR/rules/skills changes |
| E2E and independent approval before live migration | Broad PASS plus focal PASS, root build and 124 sync tests; live migration performed afterward |

All seven criteria were explicitly approved through the public CLI at revision 1 with durable review references and verification notes. Read-back confirmed approved state and evidence in both show and the seven approval events. Closure uses `task finish`, then canonical and explicit snapshot validation. The final board/checkpoint records the resulting planning state; this report records adoption evidence rather than fabricating a future receipt or checkpoint outcome.

## Operational limits

Checkpoint files are a local mirror, not a backup of full journals, receipts or node attestations. Keep store backups separately. No automatic wave-end/epic-end controller is claimed. `task finish` can persist accepted done before a checkpoint failure; correct the publication/prose problem and retry without duplicating the done transition.

The fence parser is a documented subset, not full CommonMark. An unmatched fence outside owned Acceptance anywhere blocks repository-wide checkpoint publication before files/events. An unmatched fence inside owned Acceptance keeps subsequent heading-looking text owned by that section; it may be replaced with generated criteria. CLI syntax/evidence/source-read errors refuse before writable open; canonical-state refusals such as stale revision occur after open and may apply pending maintenance.

No remote GitHub operation, stage or commit was performed. RunReceipt JSON remains outside the committed tree. Prior immutable receipts remain preserved, with factual errata in the worker report.
