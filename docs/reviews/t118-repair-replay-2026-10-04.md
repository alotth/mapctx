# T-118 — Store repair: replay of historical terminal-task dispatch

- Task: T-118 (parent E-014) — worktree `mapctx-t118-repair-replay-3119e6414f01`
- Date: 2026-10-04
- Executor: traycer (OpenCode / Z.ai GLM-5.3 Flash, model `glm-5.3-flash`)
- Dispatch: `0e976792-705a-4892-8f3a-7d350ae1322d` — attempt 1 (initial fix), attempt 2 (review P1/P2), attempt 3 (review P2a receipt-admission parity)
- Status: attempt 3 independently reviewed PASS; integrated and validated in root; real store repair safely refused with history preserved; real store NOT repaired (coordinator-owned). Current live criterion: repair safely REFUSES with named gaps while the real DB-only node history is unresolved.

## Symptom

`store repair` on the existing journal aborted with:

```
Error: Cannot dispatch terminal task: T-090
```

Reproduced on the pre-T-116 backup (contiguous journal 1..867) and on today's baseline snapshot (journal 1..956). Not a T-116 regression: the failing events predate T-116.

## Root cause (evidence, from the actual journal)

The journal is an immutable record of facts; the shared projection applier (`applyEventToProjections`, used by live append, crash-window reindex, and repair replay) re-adjudicated every historical event against the CURRENT admission FSM. Three conflicts, each evidenced by real journal sequences:

1. seq 312/313/314 (T-090): archived under pre-terminal rules → claimed → `dispatch.attempted` ⇒ old applier guard threw `Cannot dispatch terminal task: T-090`. (T-090 is the very task that introduced archived-as-terminal.)
2. seq 317: completed receipt while planning was archived ⇒ `Illegal planning transition: archived -> review`.
3. seqs 539/541/545 (retro-attestation import of 2026-10-01): dispatches onto execution-`completed` tasks without `retry-admission` reset patches ⇒ `Illegal execution transition: completed -> claimed` (the import tool evolved mid-flight; later rows journal the reset).

Design rule: **projection ≠ admission.** The applier projects facts; today's admission rules belong where new commands and new events are admitted.

## Fix

### Attempt 1 (applier de-adjudication)

- `packages/store/src/events.ts` — `dispatch.attempted` case: removed the terminal-planning guard and the execution-transition assert from the shared applier (projection kept: unknown-task check, row insert, execution-state patch).
- `packages/store/src/projections.ts` — `applyRunReceipt`: removed the planning-receipt transition assert (+ its private helper). Execution/dispatch asserts stay (evidenced clean across the full 867- and 956-event journals).

### Attempt 2 (review P1 + P2)

P1 — `packages/store/src/repair.ts`: node discovery now unions `Object.keys(dbFloor)` (intact-DB indexed max sequence per node) with journal directories and watermarks. A node indexed in an intact DB but absent from journal and watermarks can no longer vanish in a journal-only rebuild: it reports its first missing sequence through the existing `gap` result and repair aborts BEFORE temp DB creation/swap, leaving mapctx.db byte-untouched. A corrupt database still contributes no floor (its rows prove nothing; `intactDatabaseFloor` returns `{}` and is now exported for tests). Reconstruction of only the orphan rows was rejected in review: nodes `23224427…` (316) and `e7fcd6bc…` (317) are missing sequences 1..315/1..316, so continuity cannot be validated; nothing is reinvented, resequenced, or deleted.

P2a — attempt 3 (review attempt 2): receipt admission parity for ALL outcomes. Attempt 2 gated only `completed` receipts at the writer; a blocked receipt on a terminal-planning task was still admitted raw while `recordRunReceipt` threw `Illegal planning transition: archived -> blocked` (review repro). Fix: the receipt planning admission rule now lives in ONE shared helper, `assertReceiptPlanningAdmission(planningState, outcome)` (projections.ts), computing the same target as command admission for every outcome — completed → review, blocked → blocked, failed → ready from in-progress/blocked, with the special in-progress → blocked → ready hop and the completed remedy preserved verbatim. `dispatch.ts` `assertReceiptTransitions` and `events.ts` `assertNewEventAdmission` both call it (private duplicate deleted), so the two can never drift. Projection untouched (R9: a blocked RUN never moves planning; applyRunReceipt keeps its own projection semantics). Replay/reindex remain applier-only with no re-adjudication.

Factual note (regression vs pre-existing): in the baseline, the shared applier HAD a planning assert for completed/failed targets but none for blocked (baseline `applyRunReceipt` targetPlanning: completed/failed only). So the raw-writer blocked bypass PREDATES T-118 — it is a pre-existing command-vs-applier inconsistency, not a regression introduced by attempt 1/2. What attempt 1 DID regress was completed (and failed) raw-writer adjudication, restored in attempt 2; attempt 3 closes the remaining pre-existing gap so the new funnel delivers the consistency it promises.

P2 — new-event admission moved to the writer, keeping replay pure:

- `packages/store/src/events.ts` — new `assertNewEventAdmission(db, entry)`: for NEW `dispatch.attempted` it enforces the fresh-dispatch rules (unknown/terminal-planning tasks refuse; execution transition legal without the reset), and for NEW `run.receipt-recorded` it enforces the receipt planning rule (completed receipts land in review from in-progress/review only, with the same remedy message as the command API). This restores exactly what attempt 1 removed from the applier — but only on the new-event path.
- `packages/store/src/store-handle.ts` — the `runInWriteTransaction` `append` closure (the single funnel under both the public `appendEvent` and every composed command callback) calls `assertNewEventAdmission` before insert, inside the transaction: a refused append rolls back and journals nothing. The crash-window reindex path (`reindexPendingJournalUnderLock`) is documented and verified as replay: already-journaled facts project with NO re-adjudication.

Admission surface after attempt 3:

| Path | Guards |
| --- | --- |
| Command APIs (`dispatch create`, receipts, `task start`, claims) | unchanged, full admission incl. terminal guard, retry-admission resets, stale-receipt rejection |
| Raw `StoreHandle.appendEvent` / `runInWriteTransaction` callback | `assertNewEventAdmission` for `dispatch.attempted` + `run.receipt-recorded` (no bypass; receipt planning parity for completed, blocked, and failed via the shared helper) |
| Crash-window reindex (`StoreHandle.open`) | replay only — no admission re-check |
| `store repair` replay | replay only — no admission re-check; fail-closed on DB-only nodes (P1) |

No import/sync path journals `dispatch.attempted`/`run.receipt-recorded` through the raw writer (verified by call-site survey), so the writer guard cannot break sync flows.

## Tests (RED → GREEN)

Attempt 1 (3 tests): synthetic content-free two-node journal (node A init/upsert/archive/claim, node B dispatch interleaved by clock, then receipt/done/evidence/correction; garbage-byte DB → repair must rebuild from journal alone). RED on baseline: all fail with exactly `Cannot dispatch terminal task: T-F1`. GREEN after fix: replay projects history; done/completedOn/dispatch/receipt/evidence/correction preserved; repeated repair deterministic; NEW dispatch on the terminal task still refused via `recordDispatchAttempt`.

Attempt 3 (5 tests, paired raw-vs-command): blocked receipt on archived task refused by BOTH paths with the same `Illegal planning transition: archived -> blocked`, zero journal rows and zero journal files; composed transaction (patch + receipt) rolls back fully on the raw refusal; failed receipt parity (accepted from in-progress on both paths, execution `failed`); completed receipt parity (identical refusal remedy on both paths); blocked good path (in-progress accepts raw; planning stays `in-progress` per R9). RED before attempt 3: both blocked-refusal tests failed with "Missing expected exception" (raw accepted). After: `@mapctx/store` **152/152**, `@mapctx/sync-engine` **104/104**.

Attempt 2 (7 tests, RED first where behavioral):

- P1 `gap` fail-closed: intact DB + DB-only node (no journal dir, no watermark) ⇒ `status: "gap"` naming the node at sequence 1; DB bytes identical after the abort; store still opens and queries; orphan row preserved. RED before (repair returned `ok` and dropped the row).
- P1 corrupt-floor guard: `intactDatabaseFloor` returns the floor for an intact DB, `{}` for corrupt and missing files; corrupt-DB repair rebuilds journal-only without deriving nodes from untrusted rows (guard-rail, was already true).
- P2 raw `appendEvent` refuses fresh terminal `dispatch.attempted` (`/Cannot dispatch terminal task: T-TERM/`), no event row, no journal file. RED before (review's repro).
- P2 `runInWriteTransaction` callback: terminal dispatch aborts the WHOLE transaction (earlier event in the same tx rolls back, journal holds only seeded events). RED before.
- P2 raw writer refuses illegal execution transition without the journaled reset (`/Illegal execution transition: completed -> claimed/`). RED before.
- P2 raw writer refuses completed receipt when planning is not in-progress/review (remedy message; nothing journaled). RED before.
- P2 replay guard-rail: crash-window reindex (journal-only store containing the archived→claimed→terminal-dispatch history) projects everything with NO re-adjudication — proves no universal guard was returned. GREEN by construction, kept as regression protection.

Suite results after attempt 2: `@mapctx/store` **147/147** (140 + 7), `@mapctx/sync-engine` **104/104** (CLI dispatch/start/receipt/terminal-guard/retro-attestation flows). Existing maintenance-lock, stale-WAL and atomic-swap tests unchanged and green.

## Real-store validation (isolated copies only; real store untouched)

Journal SHA-256 before/after every operation: unchanged (960 files on the current copy). No direct SQL, no repair, no init against the real store.

With attempt 2, repair on all real store copies now FAILS CLOSED — this is the intended, review-mandated behavior while the DB-only node history is unresolved:

| Copy | Attempt-1 build | Attempt-2 build |
| --- | --- | --- |
| pre-T-116 backup (867 journal events + 2 orphan rows) | ok, 867 replayed, orphans dropped ❌ | `gap` naming both nodes at seq 1; 869 rows preserved; DB untouched ✅ |
| baseline snapshot (956 + 2 orphans) | ok, 956 replayed, orphans dropped ❌ | `gap` both nodes; 958 rows preserved; DB untouched ✅ |
| current real copy (960 + 2 orphans + T-118 lifecycle events) | ok ×2, deterministic ❌ | `gap` both nodes; dump identical before/after; ✅ |
| baseline snapshot with DB file deleted | ok, rebuilt from journal | unchanged: journal-only rebuild (no floor exists without a DB) |

Gap-abort verification: full-store dumps (every table) byte-identical before/after on both copies; orphan rows still present (2 each); T-090 still review/completed with 4 dispatches + 2 receipts; CLI prints `Error: Repair aborted: 2 journal gap(s) found. mapctx.db was left untouched.`

For the record (attempt-1 observation, now moot for repair but historically accurate): the only projection delta a journal-only rebuild produced was T-069 `execution_state` unclaimed→completed — the live DB had drifted from its own journal (journal ends T-069 completed at seq 115, no later reset). That correction will apply whenever the coordinator resolves the orphan-node history and a real repair becomes clean.

### DB-only orphan rows (the real gap)

Both rows are `task.patched {taskId: T-090, patch: {planningState: "in-progress", updatedOn: "2026-09-27"}, source: "reopen"}` from nodes `23224427-9da8-458b-ab90-18ebadbb8613` (seq 316, 18:51:48.242Z) and `e7fcd6bc-e08c-4155-8ee7-432085e80ada` (seq 317, 18:52:03.557Z) — duplicate cross-node fan-out of one reopen. `event_log` carries their full entry fields (incl. `logical_clock`, `payload_sha256`, `journal_path: ""`), so the two payloads are reconstructible in isolation; their nodes' sequences 1..315/1..316 are not, and per review decision nothing is reconstructed piecemeal. No disk copy found contains those node journals (searched: real store, baseline snapshot, pre-T-116 backup, backup-copy-home, copy-home, pre-live-attempt6/8/10). Final T-090 projection is identical either way (main-node seq 320 lands review); the rows matter as indexed history, which is why repair now refuses rather than dropping them.

## Errata: receipt attempt 2 evidence field (immutable)

Receipt attempt 2 (`endedAt 2026-10-04T20:10:46Z`) recorded an `evidence[0].contentHash` that is a concatenation of 16-hex prefixes of the six changed files — not a single-file digest. Receipts are immutable (a corrected duplicate is rejected by design); the field must not be treated as verifiable proof. Errata was registered with the coordinator; the real per-artifact digests for the attempt-3 deliverable live in the attempt-3 receipt (one SHA-256 per referenced file, no concatenation) and below. This document intentionally carries hashes of the CODE files only — never its own hash (no circular self-hashing).

Per-artifact SHA-256 at attempt-3 delivery:

```
a70a18339a7443a62d877c0653ef762099fc6d81d0383fe356a2e1b4338ba335  packages/store/src/dispatch.ts
0c9f375ac30a5cd4b149807b91cf481937473bab17d43641426f390050cda776  packages/store/src/events.ts
e5d081db160d08ad2581c9bf92a45c85784e5b9e54ae9d2954244e7ebbb8830c  packages/store/src/projections.ts
53712911342f492adfcac4ff1ff685bbffcd70c3cacc5fd9138fbc03742dc400  packages/store/src/repair.ts
fb7f52ef1a4db450378a70fcb6de97c73254dd7ada64a98ea352538673e01209  packages/store/src/store-handle.ts
45faf3f50ea9b8c6d997d127dae478da44999b5522275dc8385ee737108add65  packages/store/src/repair.test.ts
```

Receipt 3 pins the original delivered document (SHA-256 `51c747ac67ec58dca02fc6a4daf105887328db942e02082ae50222e3b92689fe`). This integration document corrects its status and stale digest table; the original receipt and delivery bytes remain immutable. Attempt 4 will pin this revised document separately.

## Acceptance criteria

- [x] Capturar fixture mínima do journal multi-node que reproduz falha, sem conteúdo de transcrição ou dados privados.
- [x] Corrigir ordenação/admissão histórica do replay com invariantes de execução e planejamentos terminais preservados.
- [x] Repair produz projeções equivalentes ao journal, preservando receipts/correções/evidências históricas e done/completedOn.
- [x] Replay repetido é determinístico; teste diferencia importação histórica legítima de dispatch novo proibido para tarefa terminal.

Accepted after independent implementation PASS and root verification. Criteria cover reconstruction from a complete, validated journal, deterministic replay, and rejection of incomplete sources without data loss. The current real store has incomplete source history: its correct result is a named-gap refusal, not a successful rebuild. Recovery of those missing node ranges is tracked separately in [T-119](../../tasks/T-119.md); no existing event was deleted to close T-118.

## Changed files (vs worktree baseline, excluding generated snapshots)

- `packages/store/src/events.ts`
- `packages/store/src/projections.ts` (attempt-1 de-adjudication + attempt-3 shared `assertReceiptPlanningAdmission`)
- `packages/store/src/dispatch.ts` (attempt 3: adopts the shared helper, deletes its private duplicate — no behavior change)
- `packages/store/src/repair.ts`
- `packages/store/src/store-handle.ts`
- `packages/store/src/repair.test.ts`
- `docs/reviews/t118-repair-replay-2026-10-04.md` (this document)

Nothing staged or committed; baseline dirt (T-099…T-116 carry) preserved untouched.

## Coordinator integration

See [root integration and live safety verification](t118-integration-2026-10-04.md) and [independent review](t118-independent-review-2026-10-04.md). Root build, store 152/152 and sync-engine 104/104 passed; public CLI repair returned exit 1 and both named gaps, preserving all tables and all 977 journal-file hashes.
