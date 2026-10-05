---
kind: review
title: "T-119 attempt 5 independent recovery review"
comments: none
---

# Verdict: FAIL — documentation-only blockers remain

The attempt-5 recovery implementation passed the independent functional checks below. I found no new functional blocker. Three documentation/comment statements still describe unsupported facts or a recovery route that the implementation correctly refuses. Correct those statements before using the live procedure. This is a surgical documentation/comment follow-up; no further functional implementation round is indicated by this review.

## Findings

### P2 — Separate missing-witness recovery from divergent-witness refusal

[docs/reviews/t119-historical-node-recovery-2026-10-04.md](t119-historical-node-recovery-2026-10-04.md:48) groups a missing witness and a divergent witness together, then says explicit re-approval is the remedy. The table at line 64 says the same commands work for greater/less watermarks. That is false for divergence: draft rejects either watermark when it differs from the pinned max, and commit also refuses; neither lowers nor raises the witness. Same-pin reconfirmation is executable only when the witness is absent or already equal.

Reproduction on an isolated store copy: after attesting node `23224427-9da8-458b-ab90-18ebadbb8613`, remove its watermark, draft with the same reason/evidence, approve the same content pin, then run repair: succeeds and republishes the absent watermark. Set the watermark to 315 or 999 instead: draft/approval refuses without writing. The unit coverage is `re-confirmation restores a missing witness...` and `re-confirmation refuses divergent content and divergent witness...` in `packages/store/src/attestation.test.ts`; the 47-case harness also exercised lower/higher watermark cases across intact, missing, and corrupt DB states.

Document separate operator outcomes: absent witness + intact matching DB → same-pin re-confirmation; divergent witness → refusal and separate adjudication, with no automatic repair remedy asserted.

### P2 — Scope the writer claim to normal live appends

The forensic section at line 23 says `insertEventLogRow` hardcodes a nonempty journal path, while the recovery design at line 73 correctly says it now accepts trusted replay overrides, including the original empty path. Qualify the forensic claim as applying to the normal live append path. The optional override is used by attested replay; it does not make this row shape producible by an ordinary append.

### P2 — Bound session-search conclusions to examined sources

Line 26 says “No session on any date” contains the code or ran the command. The documented search coverage at line 27 is finite (specified session dates, stores, logs, and repositories), and cannot establish an all-dates negative. Replace the absolute wording with what the examined session corpus supports, e.g. no matching code/command was found in the listed sessions. Keep the writer/process and event-time conclusions explicitly undetermined.

### Comment — Update the draft API docstring

[packages/store/src/attestation.ts](../../packages/store/src/attestation.ts:153) says draft refuses an “existing attestation.” Attempt 5 intentionally permits a read-only same-content draft so the supported missing-witness recovery can work. Update the comment to describe actual gates: journal-backed nodes and divergent watermarks refuse; an existing attestation may be drafted again, with same-pin enforcement at commit.

## Verification

All testing used `/tmp/mapctx-t119-independent-a5/repo`, a copy of the frozen worktree. No source, root board, or real-store writes were made.

- `npm run test:store`: **171/171 pass**.
- `npm run test:sync-engine`: **107/107 pass**, including public CLI draft → approve → witness removal → same-pin re-confirmation → repair. The test verifies the original `attestedAt`; the API test also verifies `approvedBy` and byte-identical attestation-file content.
- Independent recovery harness: **47 cases pass**. Covered no-approval refusal; full/partial/empty/lost attestation file with intact, missing, and corrupt DB; absent/lower/higher watermark; corrupt/missing DB restore; invalid inputs before publication; before/after witness and file crash windows; rename failure; retry and repeated repair; and exact 11-column raw-row preservation including whitespace-bearing JSON. First and second repairs both replayed 983 events in the isolated baseline copy; event rows and journal hashes remained stable. T-069 `unclaimed → completed` is the pre-existing journal sequence-115 correction described in the delivery document.
- Focused reconfirmation negatives: wrong token, changed reason, changed evidence, and changed DB row each refused; attestation file and metadata bytes stayed unchanged, and the DB stayed at its call-entry bytes. Draft with missing or corrupt DB refused without changing the attestation file or metadata.
- Crash/lock checks: simulated death before witness rename, after witness durability, after file rename, and after file+directory durability; file-rename failure; successful retries; and a concurrent metadata-lock holder (approval waited ~800 ms and completed). Maintenance lock refused append/open/competing approval. The T-118 writer-admission and raw-append regression tests passed in the store suite.
- Baseline comparison: the isolated repair changed only `schema_migrations.applied_at` and the already-known T-069 journal correction. The two pinned rows matched all 11 stored columns before and after repair, including `causation_json`, `payload_json`, hashes, and empty `journal_path`.
- Attempt-5 receipt evidence hashes matched all eight delivered files. Worktree manifest remained 462 files with **zero changes during review** versus the attempt-5 start manifest; unrelated carried dirt was not treated as T-119 scope.
- Read-only real-store check: 25 tables; both original ghost rows still present with their recorded values; no `node-attestations.json`. Current lifecycle counts can change independently, so they are not used as evidence of reviewer activity or recovery.

Reproduction scripts and case outputs are under `/tmp/mapctx-t119-independent-a5/` (`review.cjs`, `reconfirm-cases.cjs`, `locking-cli.cjs`, `results.json`, and `reconfirm-results.json`). The crash helper is `crash-child.cjs`. All review processes exited before handoff.

## Hash attribution check

Attempt-5 receipt SHA-256 values matched the frozen worktree for `attestation.ts`, `attestation.test.ts`, `repair.ts`, `store-handle.ts`, `index.ts`, `mapctx-cli.ts`, `attest-orphan-cli.test.ts`, and the delivery review document. Receipt timestamps were checked only as delivery attribution; they do not establish correctness.
