# T-118 repair replay review — attempt 3

**Verdict: PASS for implementation.** No remaining code findings. Receipt planning admission now shares one helper across command and raw-write paths, preserving the blocked-run projection behavior. Documentation needs coordinator cleanup before it is treated as final evidence.

## Verified

- `assertReceiptPlanningAdmission` computes the same planning targets as command-side `assertReceiptTransitions`: `completed` → `review`; `failed` → `ready` only from `in-progress`/`blocked` (with the required `in-progress` → `blocked` → `ready` hops); `blocked` → `blocked` admission. Both command and raw writer call it.
- `applyRunReceipt` remains unchanged for blocked receipts: execution/dispatch become blocked; planning stays where it was, preserving R9 export semantics. Admission check does not leak into replay.
- Attempt-3 tests cover blocked archived rejection on both paths with no journaling, whole-transaction rollback, completed refusal parity, failed acceptance parity, and valid blocked receipt while planning remains `in-progress`.
- Reindex still applies already-journaled facts without admission checks; repair replay still uses the projector only. Attempt-1 synthetic historical replay coverage remains present.
- P1 rechecked on an isolated baseline copy: repair reports `gap` at sequence 1 for both DB-only nodes; 958 event-log rows and DB bytes remain unchanged. Source and post-repair-copy event manifests match across all 956 journal files.
- Attempt-3 receipt file `/tmp/t118-receipt-attempt3.json`: all seven recorded content hashes match their corresponding delivery files.
- `zsh -lic 'npm run test --workspace @mapctx/store'`: **152/152 passed**.
- `zsh -lic 'npm run test --workspace @mapctx/sync-engine'`: **104/104 passed**.
- No source, board, or real-store writes. Repair and repro work used `/tmp` copies only.

## Documentation follow-up

`docs/reviews/t118-repair-replay-2026-10-04.md` contains stale attempt-3 delivery digests at lines 106, 107, and 110. Correct values, independently matched to attempt-3 receipt and files:

| File | Stale value in doc | Correct delivery SHA-256 |
| --- | --- | --- |
| `packages/store/src/events.ts` | `9b966a49e0c23963a68877f2c9926c93f6a4fa8712aca157827ce25cfdfac982` | `0c9f375ac30a5cd4b149807b91cf481937473bab17d43641426f390050cda776` |
| `packages/store/src/projections.ts` | `4b4a0eb9fc42a58e6bd1b6860c2095d4f1ceb9379f2e8ffa1ae26d6b92b294e4` | `e5d081db160d08ad2581c9bf92a45c85784e5b9e54ae9d2954244e7ebbb8830c` |
| `packages/store/src/repair.test.ts` | `bb923535e5a88754b9cd1e89d50e5298e54acbfc99b202c34e4cba855d6ee06b` | `45faf3f50ea9b8c6d997d127dae478da44999b5522275dc8385ee737108add65` |

The receipt and each file independently agree on the correct values above. Doc status line still says attempt 2, and “Admission surface after attempt 2” should describe attempt 3's parity state. The factual note correctly states that blocked raw-receipt bypass predated T-118; it was not caused by removing the old projection helper. These are documentation corrections, not implementation blockers for this review verdict.
