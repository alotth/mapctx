---
title: "T-121 independent Acceptance prose review, attempt 3"
kind: review
comments: none
---

# Verdict

**FAIL. Keep T-121 open and ELA recovery blocked.** F1, F2, and F4 regressions now pass focused independent checks. F3 still silently moves criterion-linked trailing evidence when canonical criteria are reordered or added.

Reviewer: Codex, `gpt-6-luna`, high reasoning. Review covered only the seven attributable T-121 paths. No source edits, planning/claim mutations, real ELA writes, or real GitHub operations. Builds, suites, fixtures, database copy, and recovery checkpoints ran only in `/tmp`.

## Finding

### P1 — Reordering criteria silently moves trailing evidence to a different criterion

[task-detail.ts:659–683](/Users/alt/.traycer/worktrees/alotth__mapctx/fix-t121-acceptance-prose-ea633f82980d/packages/core/src/task-detail.ts:659) refuses notes *between* managed bullets, but treats every nonblank line after the last managed bullet as safe trailing prose. When canonical order changes, it emits the full new criterion sequence and appends that prose at the end. The retained line can then point at a different criterion.

Independent input:

```md
## Acceptance
- [x] A.
- [x] B.
Evidence for B: docs/B.md
```

Canonical order: `B, A`. The public `mapctx export --reason manual --json` exited 0 and checkpointed:

```md
- [ ] B.
- [ ] A.
Evidence for B: docs/B.md
```

The evidence used to follow B now follows A. A second probe with only A plus `Evidence for A` and a newly added B produced the same reassociation. The pure renderer and public CLI both reproduce it; current F3 tests cover interleaved notes, not a criterion-linked note after the final bullet. The report’s “trailing prose keeps its anchor” statement is therefore too broad.

**Impact:** export/checkpoint and push can silently change evidence association while preserving every line. The renderer cannot establish that trailing prose is unlinked, so it must refuse the reorder/addition when association is uncertain, or use an explicit reliable anchor.

## Carried regression check

| Prior finding | Attempt 3 result | Independent evidence |
| --- | --- | --- |
| F1 — push discarded notes for empty/absent canonical acceptance | **PASS** | Isolated store/sync suites; separate empty/absent renderer probes; note-bearing mocked push regressions. No `keptLines` fallback remains. |
| F2 — removing/renaming criterion stranded nearby evidence | **PASS** | Independent renderer probe refuses. Public CLI refusal returns `stage: build`, `publishedFiles: []`; task files, event count, checkpoint count, and store clock remain unchanged in the copied fixture. |
| F3 — canonical reorder ignored or reassociated interleaved notes | **FAIL** | Checkbox-only reorder emits canonical order; interleaved-note reorder refuses; nested reorder refuses. Trailing criterion-linked evidence still moves as described above. |
| F4 — matched nested criterion flattened | **PASS** | Independent nested-match probe preserves indentation; nested reorder refuses. |
| N1 — fence and repeated-section safety | **PASS** | Independent open-fence and multiple-section refusal probes; existing relevant suites pass. |

Repeated identical criterion text was also probed: two authored bullets consume two canonical entries once each, with canonical states applied.

## Validation

- `npm run build:sync-engine` — **PASS** in isolated copy.
- `npm run test:store` — **213/213 PASS** in isolated copy.
- `npm run test:sync-engine` — **129/129 PASS** in isolated copy.
- Independent 15-task recovery using incident HEAD `fc3a5e2` prose and current ELA working-tree descriptions: **226 non-checkbox authored lines from incident descriptions preserved**, **0 missing**, all 15 store criterion sequences and states match exactly. Current non-Acceptance descriptions are byte-identical after export, and every current authored Acceptance line remains. Novel current Acceptance lines beyond the incident prose: 0 in this input set.
- Two public `mapctx export --reason manual --json` checkpoints in the isolated ELA copy both succeeded; each listed 318 files and file-path/hash lists matched byte-for-byte.
- Copied store state: all domain tables unchanged; exactly two `checkpoint.exported` events and checkpoint rows added; logical clock advanced 3168→3170; node/incarnation unchanged.
- The ELA HEAD advanced during review from `2222b11d90b3f5c69fc11c733f610398f99bffc5` to `07871fce2f9925a0298a6127668c33679deb8362`. Both objects exist; the 9-file commit range touches none of the 15 affected task paths. All 15 dirty worktree path hashes used for recovery match their end-of-review hashes. The dirty worktree descriptions, not committed HEAD files, were the current input.

This validates the 15 affected task set through public checkpoint paths. It does not independently rerun the worker’s 302-file helper-only corpus replay; that helper result is not treated as end-to-end proof.

## Receipt and source audit

Attempt 3 receipt/readback: dispatch `c8adf88f-bc41-41ed-8719-5eadbbe2c844`, attempt 3, completed, `2026-10-05T13:37:20.391Z` to `13:50:09.000Z`. It lists six changed paths and nine evidence records. All nine available content hashes match their referenced files. The six changed paths match the documented delta. `packages/store/src/export.ts` remains byte-identical to attempt 2 (`21a5148b…`); it was not in this attempt’s changed-file list.

The seven focused source hashes and working-tree status hash match at review start/end. Existing dirty baseline files were not compared to Git HEAD. All review processes exited. Evidence contains sanitized suite logs and excludes database copies, claim-environment data, and lease tokens.

## Evidence

- [Evidence assets and hashes](evidence/assets-manifest.json)
- [Independent renderer probes](evidence/render-probes.cjs) and [results](evidence/render-probes.json)
- [Public CLI reorder repro](evidence/cli-reorder-repro.cjs) and [output](evidence/cli-reorder-repro.json)
- [Public CLI pre-publication refusal repro](evidence/cli-refusal-repro.cjs) and [output](evidence/cli-refusal-repro.json)
- [Current ELA recovery input hashes](evidence/recovery-input-manifest.json), [end pin](evidence/ela-source-pin-end.json), and [HEAD advance audit](evidence/ela-head-advance-audit.json)
- [Current prose preservation checker](evidence/check-current-prose.cjs) and [results](evidence/current-prose-preservation-summary.json)
- [Two-checkpoint file comparison](evidence/checkpoint-file-hashes-summary.json), [15-task criteria/prose summary](evidence/checkpoint-content-summary.json), and [copied-store preservation](evidence/db-preservation-summary.json)
- [Attempt 3 receipt/readback hash audit](evidence/receipt-readback-audit.json)
- [Build and test logs](evidence/build.log), [store suite](evidence/store-tests.log), [sync suite](evidence/sync-tests.log), and [test summary](evidence/test-summary.json)
- [Source start/end manifests](evidence/source-start-hashes.json), [root start manifest](evidence/root-start-hashes.json), [root end manifest](evidence/root-end-hashes.json), and [process exit record](evidence/review-processes-end.txt)
