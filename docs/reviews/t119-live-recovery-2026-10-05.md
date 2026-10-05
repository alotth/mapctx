# T-119 — Verified live recovery without known event loss

Coordinator applied the independently reviewed procedure at `2026-10-05T01:26:51.011Z`, after a fresh consistent SQLite backup and a successful test of the integrated public CLI on a fresh isolated copy. No events or node sequences were invented, deleted, or resequenced. Project identity and incarnation stayed unchanged.

## Outcome and limits

Both original DB-only rows now have a durable, content-pinned copy in `node-attestations.json`, with independent watermark witnesses in `store-meta.json`. Their original node IDs, sequences 316/317, all eleven raw columns, payload digests and empty journal paths remain identical to the application baseline. Two consecutive real `store repair --json` calls returned `ok`, each replaying **1014 events**.

No earlier sequence was recovered for these nodes in the examined sources. Approval declares these prefixes unrecovered in this store and authorizes exactly the recovered rows. It does not prove that no earlier events ever existed elsewhere, authenticate the original writer or occurrence times, or certify universal historical completeness. No known indexed event was removed and no epoch reset or cutover was used.

## Preservation proof

| Baseline or invariant | Verified result |
| --- | --- |
| All 25 SQLite tables | Semantically preserved, with the two expected differences below |
| Original indexed events | 1014 represented after each repair |
| Original receipts | 89 preserved |
| Approved historical evidence | 13 preserved |
| History corrections | 29 preserved, including invalidated receipt attempt 3 |
| Original journals | All 1012 file hashes unchanged |
| Two DB-only historical rows | All 11 raw column values byte-identical |
| Identity, incarnation and existing metadata/watermarks | Unchanged; only two approved witnesses added |
| Second repair | Deterministic content, excluding migration application timestamps |
| Public `task show T-090 --json` | Still review/completed |
| Public `plan --json` | Serviceable |
| Public `validate --json` | 0 errors, no drift; three unchanged bulk-date warnings |

Expected differences: T-069 `execution_state` changed from `unclaimed` to `completed`, matching its existing journal receipt at sequence 115; rebuilding the temporary database refreshes `schema_migrations.applied_at`. Ordinary journal-derived JSON columns may be serialized with canonical key ordering during rebuild; comparison verifies their values, not formatting. The two attested rows are compared as raw columns without JSON normalization.

## Applied procedure

1. Verify the eight integrated source/document hashes against the final reviewed manifest.
2. Take fresh consistent backup, table inventory, metadata copy, and journal-hash inventory.
3. Revalidate current live rows against that backup; draft each node via the public CLI with the reviewed v2 reason.
4. Check each draft's content pin against the independently reviewed value; approve using `--approve-hash`. Witness publication precedes the attestation file; approval requires both durable.
5. Repair, compare all tables/raw historical rows/journal hashes, repair again, and repeat comparisons.
6. Verify public CLI serviceability before concluding the task.

| Node | Reviewed content pin | Witness |
| --- | --- | --- |
| `23224427-9da8-458b-ab90-18ebadbb8613` | `0711e40b4df021e8e752c05c804ef6fb18a133720b6907ca1acf9237a9a5e440` | 316 |
| `e7fcd6bc-e08c-4155-8ee7-432085e80ada` | `532e0024a1ce053f2dfda7a7c7a1aab30f89340c9b0fbb027ef2a134885bf569` | 317 |

Published attestation-file SHA-256: `f57beb8b24843b6e76938233248dc0c5e9d11b366fb9e6aed209f7fb14035ff0`.

The complete preparation and v2 reason are in [the recovery procedure](t119-historical-node-recovery-2026-10-04.md). [Functional review](t119-independent-review-attempt5.md) passed store 171/171, sync 107/107 and 47 independent recovery/crash cases; its remaining documentary findings were addressed in [the final integration review — PASS](t119-independent-review-integration.md). No further runtime logic changed after that review. Root build, both suites and diff check passed.

## Audit trail

Execution used the original dispatch `e5f1eedc-e0a1-4ed1-9bd7-7c58516da017`, coordinator attempt 6, true claim time `2026-10-05T01:16:32.664Z`. Worker receipts and previous attempts remain queryable. [Receipt-3 correction](t119-receipt3-correction-2026-10-05.md) preserves its original while excluding its fabricated bounds from metrics; this recovery preserves that correction.

Local evidence is under `/tmp/mapctx-t119-baseline/`: `pre-live-recovery/`, `live-recovery-verification.json`, `live-after-first-tables.json`, `live-{draft,approved}-node{1,2}-stdout.json`, `live-repair-{first,second}-stdout.json`, post-live CLI results, and `apply-live-recovery.cjs`. The separate integrated-copy proof replayed the same 1014-event baseline with the same preservation results. These machine-local backups contain private store data and are not committed.

This record covers the recovery baseline before the coordinator's completion receipt, release and planning move; those add their own normal lifecycle events. Code and durable documents remain unstaged/uncommitted. T-120 separately tracks store-only validation and end-of-process local checkpoints; it is not implemented by this recovery.
