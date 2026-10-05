# T-119 — Store recovery: attested DB-only historical nodes (no event loss)

- Task: T-119 (parent E-014) — worktree `mapctx-t119-historical-node-recovery-cf3da92a6220`
- Date: 2026-10-04 (rounds through 2026-10-05)
- Executor: traycer (OpenCode / Z.ai GLM-5.3 Flash, model `glm-5.3-flash`)
- Dispatch: `e5f1eedc-e0a1-4ed1-9bd7-7c58516da017` — attempts 1–3 and 5 worker (attempt 1 lease expired mid-verification, honestly re-admitted; attempt 2 first delivery; attempt 3 witness/validator round); attempt 4 coordinator, audit/correction ONLY (receipt-3 invalidation `efc60eb1-e08e-4a2b-a0b6-c4160907d28b`; attempt 3's receipt carried fabricated endedAt and is INVALIDATED, not a measurement — original byte-preserved, durable record `docs/reviews/t119-receipt3-correction-2026-10-05.md` at root, not copied here)
- Status: procedure implemented, independently tested across rounds; two P2 findings from the attempt-3 independent review (unsupported attribution language; unexecutable missing-witness remedy) addressed this round. **Real store NOT modified beyond the T-119/coordinator lifecycle itself.** Live application of the attestation + repair is coordinator/user-owned (see "Live procedure").

Coordinator integration uses attempt 6, claim time `2026-10-05T01:16:32.664Z`. Attempt-5 independent review passed functional recovery, 171 store tests, 107 sync tests, and the 47-case crash/loss matrix. Coordinator integrated exactly eight attributed files after checking the root baseline, then corrected documentation/comments and the divergent-witness diagnostic. No admission, replay, or persistence rule changed in that integration follow-up. Final focused review and real application are pending; the real store has received lifecycle events and the additive receipt-3 correction, not recovery writes.

## The two rows (the only store data in question)

Both in `event_log`, project `9176b907-4a73-4a03-bfdb-bb20eff306f6`:

| node_id | sequence | logical_clock | occurred_at | event |
| --- | --- | --- | --- | --- |
| `23224427-9da8-458b-ab90-18ebadbb8613` | 316 | 316 | 2026-09-27T18:51:48.242Z | task.patched T-090 → in-progress, source `reopen` |
| `e7fcd6bc-e08c-4155-8ee7-432085e80ada` | 317 | 317 | 2026-09-27T18:52:03.557Z | task.patched T-090 → in-progress, source `reopen` |

Identical payloads (`payload_sha256` `582834aa300e1c001a79b6fef4c8bafedf5aa5da0a78766f446bbe8d3ecdbded` under the compact scheme), `journal_path: ""`, `causation: []`, actor `traycer`, schema_version 1.

## Forensic audit — verified facts

1. **The two rows use a different payload-hash scheme than every other row.** Hashing-scheme survey over all 983 baseline events: exactly the 2 ghost rows match `sha256(JSON.stringify(payload))` (compact); all 981 other rows match the store's `canonicalJson(payload)` (sorted keys, 2-space indent, trailing newline). This establishes a serialization difference in the stored digests; it constrains how the pinned payload bytes serialize and does not identify the writing process or authenticate the recorded time.
2. **Normal live appends cannot produce this row shape.** The ordinary append path supplies a nonempty journal path, starts a fresh node at sequence 1 (`lastIndexedSequence(nodeId) + 1`), and fsyncs its journal before the SQLite commit. Trusted attestation replay now supplies explicit raw overrides to `insertEventLogRow`, including the original empty path; that recovery path is distinct from ordinary appends. These facts do not identify the original writing process.
3. **Node identities in the examined baseline.** `store-meta.json` records main node `5636ea0e-2c48-41c0-a6cb-79138061b88c` and creation field `2026-09-04T23:00:05.768Z`. The two other node IDs have only the pinned rows in the copies examined, with no matching journal files, watermarks, or earlier rows found. Stored sequence values 316/317 do not establish a global-counter writer or when those identities were created.
4. **Recorded timeline context.** Stored timestamps place the two rows between main-node sequences 315 and 316. The later main-node sequence 320 records T-090 moving to review with source `task-reopen`. The pinned rows have identical payloads and timestamps 15.3 seconds apart; whether they represent a retry, two operations, or something else remains undetermined. Recorded times are not independent authentication of actual occurrence times.
5. **Writing implementation not recovered.** Examined Git history has a gap between commits dated 2026-09-11 (`3154b23`) and 2026-09-30 (`2bcd0b7`). Examined sessions show the runtime symlink pointing into the root working-tree build and repeated rebuilds. A retrieved `tasks.ts` excerpt uses source `task-reopen` for review-only reopen. No matching `source: "reopen"` code or command that produced the pinned rows was identified in the listed session corpus. Unexamined or unavailable sources remain outside that conclusion.
6. **Search coverage and limits.** Executor examined three `~/.mapctx` stores; listed `/tmp` backups (`mapctx-store-backup-20261001`, T-116/T-118/T-119 baselines, gapcheck/repro copies); Codex sessions 2026-09-26..28 and 10-04; OpenCode `opencode.db` tables and logs; accessible Traycer epics, snapshots and chat-refs; and worktree Git objects. Matching UUIDs were found in database copies and documents quoting them, with no earlier node sequence recovered. No APFS local snapshot was available in the examination. The earliest available backup is dated 2026-10-01 and contains both rows. Rows are byte-identical across examined copies; this finite search does not prove no other history ever existed.
7. **No projection references the ghost nodes.** Every projection table was scanned: `task_projection`, `dispatch_projection`, `run_receipt_projection`, `resource_claim_projection`, `history_evidence_projection`, `history_correction_projection`, `task_detail_projection` — zero references. T-090 is review/completed via 4 dispatches on the main node only. The rows are pure indexed history.

**Conclusion (what the evidence does and does not establish):** ESTABLISHED — the two rows exist with these stored values; their payloads match the recorded digest under the compact-legacy scheme while all other rows use the canonical scheme; they appear byte-identically in every copy examined; `occurred_at` values are RECORDED fields, not authenticated fact times; no earlier sequence for these nodes was recovered in any examined source, which is a recovery limit — recovered-absence is NOT evidence of nonexistence. UNDETERMINED — the writing process, the actual occurrence times, whether the two rows were one retried operation, and whether matching events ever existed elsewhere. The attestation approved below pins exactly the RECOVERED rows — the only history complete enough to pin — and declares the unrecovered prefixes absent from THIS store's history; it is not a historical-existence proof.

## Recovery design: hash-pinned node attestation

Repair ordinarily requires contiguous per-node sequences from 1. No prefix was recovered for these nodes, so repair fails closed at sequence 1. Attestation provides an explicit, reviewed exception for replaying exactly the recovered rows; the historical existence of unrecovered prefixes remains unresolved.

A `node-attestations.json` file in the store directory pins, per node:

- the node's COMPLETE `event_log` rows (every column, byte-exact — the durable independent copy, like a journal),
- the reviewed reason and evidence references,
- the reviewed approval token (`contentSha256` over schemaVersion+nodeId+rows+reason+evidence), stored inside the file and re-verified on every load,
- commit-time metadata (`attestedAt`, `approvedBy`).

**The independent witness.** Approval alone once left the pinned rows with no testimony outside a single file: losing that file with a missing/corrupt DB let a rebuild silently drop the rows (coordinator review, reproduced). Approval therefore publishes a durable WITNESS FIRST — `sequenceWatermarks[nodeId]` in `store-meta.json`, merge-preserving identity, incarnation, createdAt and every other node's watermark, written tmp+fsync+rename+fsync-directory under the store metadata lock — and the attestation file SECOND, equally durable. Success is reported only after both are durable; failure never removes a witness, rows, or previous approvals. Consequences, all fail-closed:

- witness present, file lost (any DB state): the node stays in repair's node union with no journal → named gap at the node's sequence 1; an intact DB allows explicit re-approval (idempotent: an equal witness is reused, never rewritten; a divergent one refuses both draft and commit);
- witness missing while the FILE survives: the gap reason names the executable remedy — re-confirmation through the SAME draft→approve commands. Commit compares the fresh draft's pin against the stored attestation BEFORE any write: identical reviewed content conserves the original attestation object verbatim (`attestedAt`, `approvedBy` — never silently replaced) and republishes only the witness (absent → durable write under the metadata lock; equal → reused; GREATER/LESS/divergent → refusal with zero writes); different reviewed content refuses with zero writes (file, meta, rows untouched);
- witness present, file present: repair replays the pinned rows byte-exactly;
- file present WITHOUT its witness: refused until same-pin re-confirmation against an intact matching DB; no permissive compatibility bypass;
- file present with a divergent witness (greater or less): refused without changing either value. Same-command re-confirmation also refuses; separate investigation and a reviewed recovery decision are required. No automatic restoration or overwrite is offered;
- an unexplained watermark never authorizes an absent prefix on its own: only the reviewed attestation does that, and repair never writes metadata while loading or validating.

**What it attests:** these exact rows are the complete recovered set being approved for this node; sequences before the first attested row are a DECLARED unrecovered prefix in this store, not evidence that those sequences never existed. Payloads match their recorded digests under the canonical or compact-compatible scheme at draft, load, approval, and replay; the content token binds the file to the reviewed rows, reason, and evidence. No historical origin or occurrence time is authenticated by that token.

**What it does NOT attest:** that no related events ever happened elsewhere; anything after the last pinned row (new rows beyond the pin still fail repair closed); and it authenticates exactly as far as any journal does — an attacker with store-directory write access can rewrite file, witness and DB in concert, the same trust tier the journal has always had.

**Fail-closed properties preserved (T-118 unchanged where no attestation exists):**

| Scenario | Behavior |
| --- | --- |
| DB-only node, NO attestation | `gap` naming (node, 1) — unchanged from T-118 |
| Attestation file unreadable/malformed | repair aborts before building anything (never silently ignored) |
| Post-approval edit of the attestation (rows/reason/evidence) | load refuses: persisted `contentSha256` no longer matches content |
| Attestation file lost, witness present (intact/missing/corrupt DB) | named gap via the witness; never silent row loss |
| One node removed from the file, or the list emptied | remaining witnesses still force named gaps per node |
| Attestation file WITHOUT its witness | refused until same-command, same-pin re-confirmation from an intact matching DB; original approval metadata conserved |
| Witness divergent (greater/less) | repair and re-confirmation refuse without writes; investigate and separately adjudicate, never overwrite it to force replay |
| Attested row drifted in an intact DB | gap naming the drifted column |
| Attested rows deleted (fully or partially) from an intact DB | gap: "no rows in the intact database" (all rows gone) or "database holds N row(s), attestation pins M" (partial) |
| Extra rows beyond the attestation | gap: "database holds N row(s), attestation pins M" |
| Journal files appear on an attested node | gap: "unexpected journal data" |
| NEW unattested DB-only node | gap naming it — unchanged |
| Corrupt/missing DB + valid file AND witness | rebuilds; pinned rows restored from the attestation (independent-loss guarantee, same as journal) |
| Repair run twice | content-identical (only `schema_migrations.applied_at` differs; migrations re-apply into the fresh temp DB) |

Byte preservation: attested rows replay with their original `payload_json`, `causation_json` (e.g. `"[ ]"` never re-serializes to `"[]"`), and `journal_path: ""` bytes. The overrides are carried alongside the attested entries inside repair (derived from the attestation map, never sniffed from entry fields, so crafted journal files cannot inject divergent bytes); `insertEventLogRow` gained optional overrides used only by the attestation replay path, and live appends are unchanged. (Journal-sourced rows still re-serialize with sorted keys on rebuild — pre-existing behavior, semantically identical, `payload_sha256` unchanged.)

Shared validation: ONE structural validator (all 11 row columns typed and contiguous, `causation_json` parseable as a JSON array, `journal_path` empty, payload hash under a documented scheme, non-blank reason, evidence object, and — at load — the pinned token) runs at DRAFT (before any token exists), at COMMIT (on the fresh draft before witness or file is published), and at LOAD. Invalid input is rejected before anything is persisted; the CLI also refuses whitespace-only `--reason-file` content before any store call. Draft/approve is TOCTOU-safe: the draft is recomputed under the maintenance lock at approval time and the token must match that fresh computation.

Draft/approve flow (human gate): `mapctx store attest-orphan <node> --reason-file <file>` prints the draft + content SHA-256 and WRITES NOTHING. `--approve-hash <sha256>` recomputes the draft under the maintenance lock and refuses unless the token matches byte-for-byte, then writes atomically (tmp+rename+fsync). The content hash covers schemaVersion+nodeId+rows+reason+evidence only, so the reviewed token stays valid across the draft→approve gap.

## Isolated validation (real store untouched)

All on copies of the pre-execution snapshot `/tmp/mapctx-t119-baseline/real-store-before-execution` (983 events, 981 journal files, sha256 `8de1abd25f068f4c54b5f201456e14ef49375c24c0df5336936d64b13e7d7499`):

1. RED: repair refuses both nodes at sequence 1; DB hash unchanged after abort.
2. GREEN: draft → approve both nodes; repair → `ok`, 983 events replayed; both ghost rows **byte-identical** after rebuild (all 11 columns, incl. `journal_path: ""`); repair run twice → content-identical dumps.
3. Full-table semantic comparison (all 25 tables, all `_json` parsed + deep-key-normalized): repaired copy vs pristine differs in EXACTLY — `schema_migrations.applied_at` (9 rows, fresh temp DB re-applies migrations) and `task_projection.T-069.execution_state` unclaimed→completed. The T-069 change is the journal's own truth (journal seq 115: `run.receipt-recorded` outcome completed, dispatch `07ef1ead-81d6-4b6b-80f5-8269d49752c9`, 2026-09-05T16:03:12.062Z) where the live DB had drifted (unclaimed). Every task, receipt, correction, evidence row, claim, checkpoint: preserved.
4. CLI serviceability on the repaired copy: `task show T-090` → review/completed; `plan --json` → 6 waves, T-119 present.
5. Negative battery (all fail closed): tampered attestation file (refused, DB untouched); drifted attested row (gap, untouched); deleted attested row (gap, untouched); journal file on attested node (gap, untouched); truly corrupt DB (page-level corruption, `integrity_check` fails, `dbWasCorrupt: true`) → repair ok with both rows restored from the attestation alone; new unattested DB-only node (gap named); attest-orphan on a journaled node (refused); approve with mismatched reason bytes (refused, nothing written).
6. Repo test suites at attempt-2 delivery: `@mapctx/store` **163/163** (152 pre-existing + 11 new in `attestation.test.ts`), `@mapctx/sync-engine` **105/105** (104 pre-existing + 1 new CLI e2e in `attest-orphan-cli.test.ts` exercising draft→approve→repair through the real command path on a copied MAPCTX_HOME). After the attempt-3 witness/fix round: `@mapctx/store` **169/169**, `@mapctx/sync-engine` **106/106**. After this attempt-5 round: `@mapctx/store` **171/171** (+ re-confirmation conserve/refuse, zero-writes divergence), `@mapctx/sync-engine` **107/107** (+ public-CLI witness-loss end-to-end with metadata conservation).

## Independent review

### Attempt 2 → 3 round (coordinator review of the first delivery)

The coordinator's independent review of the first delivery reproduced THREE code blockers (artifact: epic `t119-review-attempt2`), fixed in the attempt-3 round RED→GREEN:

1. P1 witness gap — approving both nodes, then deleting `node-attestations.json` and removing/corrupting mapctx.db let repair "succeed" with 981 events, silently dropping the two known rows (no testimony outside the file). FIXED: the durable watermark witness above, published FIRST, file second, success only after both; file loss now yields named gaps in every DB state; no permissive back-compat (witness required at repair); crash windows and idempotent re-approval covered by tests.
2. P2 causation drift — a valid `"[ ]"` causation column re-serialized to `"[]"` on the first rebuild, and the SECOND repair then refused its own output. FIXED: original `causation_json` bytes join the attestation-derived replay overrides; regression test pins all 11 raw columns across two repairs.
3. P2 approvals persisting invalid files — whitespace-only reasons and malformed causation rows passed draft+approval but failed the loader afterwards, bricking repair. FIXED: one shared structural validator now runs at draft (before any token), commit (before witness/file publication), and load; the CLI refuses blank reason content before any store call. Negative tests assert nothing is published.

### Attempt 3 → 5 round (coordinator review of the witness round)

The coordinator's independent review of the attempt-3 delivery returned **FAIL with two P2 findings** (artifact: epic `t119-review-attempt3`), confirming all three attempt-2 code blockers fixed (47 independent edge/crash/loss/concurrency cases; suites 169/169 + 106/106; raw-row and metadata-preservation verified; real store untouched). The two findings and this round's fixes:

1. P2 unsupported attribution/event-time certainty — the report still called the rows a "duplicated, redundant reopen attempt from a build" and "genuine Sep-27 store history", and the module comment said the rows "were written by" a compact-JSON writer. FIXED this round: the whole evidence section now affirms only stored values, the serialization difference, and stability across examined copies; `occurred_at` is a recorded field, not an authenticated fact time; origin/process/writer identity and the duplicate-attempt reading are explicitly UNDETERMINED; "no prefix recovered" ≠ "never existed"; only the RECOVERED rows are complete enough to pin. The `verifyRowPayloadHash` comment states hash-scheme compatibility, not origin.
2. P2 missing-witness remedy unexecutable — repair's refusal said "explicit re-approval required" but both draft and commit refused already-attested nodes, so no supported path could restore a witness. FIXED this round: commit now supports idempotent RE-CONFIRMATION — with an intact DB and byte-identical reviewed content (same pin), it conserves the original attestation object (attestedAt/approvedBy) and republishes only the witness (absent → durable; equal → reused; greater/less/divergent → refusal, zero writes); different content refuses with zero writes. CLI draft no longer pre-refuses attested nodes (it is read-only; the gate is in commit). Regressions: public-CLI end-to-end gap→draft→approve→repair, witness-absent, watermark greater/less, divergent content zero-writes, repeat stability.

### Attempt 2 round (worker-native reviewer)

Adversarial review (separate reviewer, full repo access, suites + tsc re-run independently) returned **VERDICT: APPROVE**. Findings and disposition:

- P2 (watermark witness ignored for attested nodes) — FIXED: repair now refuses any attested node whose sequence watermark exceeds the last attested sequence, on every path including the corrupt-DB restore.
- P2 (approval token not persisted; hash-consistent tampering undetectable on the corrupt-DB restore path) — FIXED: `contentSha256` is now stored inside the attestation and verified against recomputed content on every load; doc claims softened to the journal's actual trust tier.
- P2 (replay overrides keyed off untrusted entry fields — injection surface via crafted journal files) — FIXED: overrides now derive from the attestation map at the call site; entry fields are never consulted.
- P3 (structural validation gaps, missing directory fsync after the attestation rename) — FIXED: load-time validation now type-checks every row column and `causation_json`; the write fsyncs the store directory after rename.
- P3 (no list/revoke tooling for attestations; a wrong attestation must be removed by hand under the maintenance lock) — NOT addressed; operational note for a follow-up task if ever needed. Removing an attestation legitimately requires the same human rigor as creating one.
- P3 (when `intactDatabaseFloor` cannot read an intact-but-busy DB, an attested node reports "no rows in the intact database") — NOT addressed; the message can be imprecise but the outcome is fail-closed either way.

## Changed files (vs worktree baseline manifest; dirt carried untouched)

- `packages/store/src/attestation.ts` (new — draft/approve/load/verify/entries)
- `packages/store/src/attestation.test.ts` (new — recovery, crash, validation, byte-preservation and re-confirmation regressions)
- `packages/store/src/repair.ts` (attested-node validation + injection; no behavior change without an attestation file)
- `packages/store/src/store-handle.ts` (`insertEventLogRow` optional `{journalPath, payloadJson, causationJson}` overrides)
- `packages/store/src/index.ts` (export attestation module)
- `packages/sync-engine/src/mapctx-cli.ts` (`store attest-orphan` subcommand, `--reason/--reason-file/--evidence/--approve-hash`, help text)
- `packages/sync-engine/src/attest-orphan-cli.test.ts` (new — CLI e2e)
- `docs/reviews/t119-historical-node-recovery-2026-10-04.md` (durable procedure and evidence limits)

CLI-regenerated `TASKS.md`/task structured snapshots are excluded from the attributed source delta. Coordinator's separate receipt audit record is `docs/reviews/t119-receipt3-correction-2026-10-05.md`.

Nothing staged or committed. Integrated code-file SHA-256 values (including the coordinator's comment/diagnostic follow-up; original worker hashes remain in the immutable attempt-5 receipt):

```
ae151d3307b8ad739bea1874de6ce7feec45b26ab50815a9fc19615b44941f46  packages/store/src/attestation.ts
24ac2b0339eb3bf0e44f0a1b98d106b6494209adc7a60429a1a391313ec2fb2c  packages/store/src/attestation.test.ts
2acdc8116da0b4403f5eb17b6e33d8e2fc62d23636f6f366badc660f5abf0cbf  packages/store/src/repair.ts
3b562152d46e699886de86bedfffdba1d2b6d883a771c66e155301e80d30eaaf  packages/store/src/store-handle.ts
fc4508c338312746318b479d89b9ba7d3b63aadcbd406e61f0443b575d58bb97  packages/store/src/index.ts
7f4e625b0585a8627de3c6aaef1ec40659424ce7dc0250356b46c14c831a2b3e  packages/sync-engine/src/mapctx-cli.ts
c1af4091d2eed6e687034bbdda7ce64546944ddb873c8fe135aa1a24ac4881f6  packages/sync-engine/src/attest-orphan-cli.test.ts
```

## Live procedure (coordinator/user-owned; NOT executed on the real store)

State before application: real store has NO `node-attestations.json`; `mapctx store repair` still refuses both gaps. Pre-execution and post-execution consistent SQLite snapshots exist:

- pre-execution (before T-119 lifecycle): `/tmp/mapctx-t119-baseline/real-store-before-execution/` — db sha256 `8de1abd25f068f4c54b5f201456e14ef49375c24c0df5336936d64b13e7d7499`
- post-lifecycle (after T-119 claim/dispatch events): `/tmp/mapctx-t119-baseline/real-store-after-execution.db` — sha256 `5dabdcd4d3087d5e5f6bc7d953ba281e91ad09af3713d7e2f4f66e919bfcdcf6`, 991 events, both ghost rows present

The user's T-119 execution request authorizes recovery of the known rows without losing events. No deletion of known events, incarnation reset, or epoch cutover is proposed. Coordinator application requires final review, fresh backup, and verification against the current raw rows. Unknown prefixes remain explicitly unrecovered; this procedure does not certify universal historical completeness. Any proposed loss or cutover would require a separate concrete decision.

Steps after integrating this worktree's code (root build green expected):

```sh
# 1. Fresh consistent backup from a read-only SQLite connection
# 2. Draft (writes nothing; prints contentSha256 — must equal the tokens below)
mapctx store attest-orphan 23224427-9da8-458b-ab90-18ebadbb8613 --reason-file <reason.txt> --json
mapctx store attest-orphan e7fcd6bc-e08c-4155-8ee7-432085e80ada --reason-file <reason.txt> --json
# 3. Approve
mapctx store attest-orphan 23224427-9da8-458b-ab90-18ebadbb8613 --reason-file <reason.txt> --approve-hash <token1> --json
mapctx store attest-orphan e7fcd6bc-e08c-4155-8ee7-432085e80ada --reason-file <reason.txt> --approve-hash <token2> --json
# 4. Repair + verify
mapctx store repair --json
# 5. Verify ghost rows byte-identical + task/receipt comparisons vs the backup
```

Approval tokens valid for these exact inputs (rows unchanged since snapshot; any drift re-tokenizes and refuses):

- reason file content (single line, exact bytes; `--reason-file` trims both sides, so a trailing newline is harmless):
  `Recovery attestation, not a historical existence proof: no journal, watermark, backup, session transcript, or store copy examined contains any earlier sequence for this node; the two pinned rows are the complete recovered history. Whether additional events for these node identities ever existed elsewhere is undetermined and remains an open question. This attestation declares the unrecovered prefixes absent from this store's history and authorizes replay of exactly the pinned, hash-verified rows, preserving their original bytes.`
- expected token N1 `23224427…`: `0711e40b4df021e8e752c05c804ef6fb18a133720b6907ca1acf9237a9a5e440`
- expected token N2 `e7fcd6bc…`: `532e0024a1ce053f2dfda7a7c7a1aab30f89340c9b0fbb027ef2a134885bf569`

(The earlier v1 tokens `9aaf33c0…`/`e4d714e3…` are SUPERSEDED — their reason text overclaimed provenance and must not be used.)

Post-repair expectations: `status: "ok"`, eventsReplayed equals the event count in the fresh application baseline, both pinned rows byte-identical, T-069 execution_state → completed (known journal/DB drift), all other projection values unchanged apart from migration-application timestamps. Compare parsed JSON columns semantically for ordinary journal-derived rows; all raw columns of the two pinned rows must remain identical.

## Acceptance criteria

- [x] Auditar origem dos nós/linhas e backups alcançáveis, documentando proveniência verificável e lacunas sem copiar transcrições privadas.
- [x] Propor recuperação suportada que preserve eventos originais, identidade, hashes e limites de continuidade; não completar sequências por suposição nem excluir órfãos silenciosamente.
- [x] Validar procedimento em cópia isolada com revisão independente, backup e comparação de tarefas/receipts/evidências/correções/journal.
- [ ] Se houver perda inevitável ou novo epoch/cutover, obter decisão explícita após apresentar resultado concreto; até lá store repair continua recusando de forma segura.
- [ ] Aplicar apenas procedimento autorizado; comprovar preservação, resultado do CLI e replay determinístico, ou registrar falta de recuperação sem alegar sucesso.

Known-row loss or epoch cutover is not proposed. Final review and verified coordinator application remain required; this document does not claim either has happened.
