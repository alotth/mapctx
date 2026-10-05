# T-120 — coordinator integration checkpoint (attempt 4)

Scope: integrate the 43 physical attempt-3 source/documentation paths and verify the resulting root build on isolated store copies. This delivery does not close T-120 or approve live adoption.

The integrated implementation matches the worker attempt-3 hashes. Root build passed; store 192/192 and sync-engine 121/121 passed. Independent attempt-3 review and its safe, standalone assets are promoted in [the review](t120-independent-review-attempt3/index.md). RunReceipts and full event/claim table dumps remain outside the repository.

The coordinator public-CLI proof used a fresh 1,047-event, 93-receipt, 1,045-journal schema-9 backup. Explicit migration/import on its isolated copy imported 109 observed Acceptance sections (25 absent), preserved every original event and receipt semantically and every original journal hash, and retained both T-119 attested rows in all eleven raw fields. Post-import validation: zero errors, three existing timestamp warnings. Two checkpoints published 135 files with identical hashes; two repairs replayed 1,158 events and preserved semantics. Evidence: private `/tmp/mapctx-t120-baseline/root-public-proof/summary.json`; no raw live store data is committed.

Live store remains schema 9. The public CLI silently drops `task acceptance approve --evidence`: approval succeeds but the event and projection contain `evidence:null`. This new medium finding blocks adoption pending a surgical worker fix and independent focal review. Public push help also promises a snapshot-drift refusal which the implementation does not perform; wording must be corrected.

Worker execution provenance: attempt 1 began OpenCode/GLM and continued Codex after session resumption; switch operator/time is unverified. Attempts 2 and 3 verified OpenCode `zai-coding-plan:glm-5.3-flash` before edits. Attempt-1 receipt omitted three changed tests; attempt-2 receipt included two aliases, one with unchanged target. Originals are immutable; the worker report records these errata. Coordinator attempt 4 uses Codex `gpt-6.1-sol`; no provider usage counts are available or invented.

Operational limits remain explicit: an unmatched fence outside owned Acceptance blocks a repository-wide checkpoint before publication; accepted `done` may persist and checkpoint retry follows prose repair. An unmatched fence inside owned Acceptance retains section ownership through subsequent heading-looking text. No automatic wave controller or wave-end trigger is claimed.

Next: release coordinator claim, dispatch evidence-wiring fix on the same dispatch identity, focal re-review, then fresh-backup live migration/import and explicit criterion approvals with evidence. Planning closure uses `task finish` after all gates pass. Nothing staged or committed.
