# T-119 — Receipt attempt 3 timestamp correction

The executor disclosed that receipt `e5f1eedc-e0a1-4ed1-9bd7-7c58516da017/3` contains invented bounds: `startedAt: 2026-10-05T00:35:00.000Z` and `endedAt: 2026-10-05T00:58:00.000Z`. The actual attempt claim was `2026-10-05T00:23:37.310Z`; the executor submitted the receipt before its declared end. No replacement duration or completion timestamp is inferred from that disclosure.

## Canonical correction

Coordinator used the supported `mapctx history correct` command, targeting the exact receipt, with verdict `invalid`. Correction ID: `efc60eb1-e08e-4a2b-a0b6-c4160907d28b`; recorded at `2026-10-05T00:39:19.994Z`. The original remains queryable and byte-identical. Invalidation excludes the receipt from history/actual and calibration consumers; it does not invalidate delivered source hashes or establish code correctness.

`mapctx history reconstruct --task T-119 --json` read back this correction under `invalidatedReceipts`. No fabricated replacement receipt was submitted. Code from attempt 3 remains frozen for independent re-review; integration and real orphan attestation/repair are pending.

## Preservation verification

Fresh consistent backup preceded this correction. Before/after comparison confirms:

| Original data | Preserved |
| --- | --- |
| Existing receipt rows | 87, byte-identical raw rows |
| Existing event rows | 1000, byte-identical raw rows |
| Journal files | 998, identical hashes |
| Historical DB-only rows | Both, every raw column unchanged |
| Other tasks | 133 unchanged |
| Historical evidence, task details, dependencies | Unchanged |

Only the coordinator's own task-start lifecycle and the new correction were added during this verification. Coordinator uses the same dispatch, attempt 4, claim `43981eb2-48b5-4232-a9e7-b21af993d543`, true claim time `2026-10-05T00:39:01.813Z`. This attempt covers receipt auditing/correction, not implementation, integration, or recovery.

Local reproducibility evidence is under `/tmp/mapctx-t119-baseline/`: `pre-receipt3-correction/`, `post-receipt3-correction/`, `receipt3-correction.json`, `receipt3-reconstruction.json`, `receipt3-correction-verification.json`, and `verify-receipt3-correction.cjs`. The backups include table inventories and original journal hashes. No SQL write bypass, epoch reset, event deletion, or live recovery occurred.

Approval of T-119 still requires independent code review and coordinator verification of the recovery procedure. This audit record approves only the additive invalidation described above.
