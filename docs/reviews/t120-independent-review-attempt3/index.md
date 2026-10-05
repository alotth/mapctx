---
kind: review
title: "T-120 independent review — attempt 3"
comments: none
---

# Verdict

**PASS, with operational limits recorded below.** Attempt-3 fixes N1–N4 pass their requested probes; attempt-1 F1–F7 and the T-092 decision remain verified. No new data-integrity defect reproduced. The latest-copy import/checkpoint/repair proof ran with the new shared parser and preserved canonical source state.

Review-only continuation. No source, root, real store, claim, dispatch, or board writes. Consolidation resumed under Codex (`gpt-6-luna`); the saved attempt-3 focused probes and suites were run earlier in the same review chat under Claude after the API capacity switch. Latest-copy preservation was run by Luna child `e913e3aa-af20-4446-b475-8050eb6c0675` and reported complete; no work is attributed to a harness that did not perform it.

# Attempt-3 changes verified

| Area | Result |
|---|---|
| N1 shared fence analyzer | Pass: 20,000 generated documents vs an independent reference, 0 mismatches, 0 non-idempotent strips, 0 render-roundtrip failures. Named probes cover tilde, four-plus backticks, longer/mismatched closers, CRLF, indentation/list cases, and inline triple-backtick text. Properly closed fences preserve surrounding Git prose; checkpoint export bytes repeat exactly. |
| N1 refusal path | Pass: unmatched fence in Git-authored prose outside the owned Acceptance section returns `acceptance-render-refused` before file, checkpoint-event, or temp-file writes. Four repeated attempts remain stable. `validate --snapshots` reports the refusal without crashing or writing; canonical `validate` remains read-only and exits 0. After closing the fence, export and snapshot validation pass and repeated export hashes match. |
| N2 attribution/docs | Pass: attempt-3 delta has 44 paths including generated `TASKS.md`; receipt lists 43 physical paths and all 43 hashes match. Doc correctly retains attempt-2 errata: 41 source/doc paths plus generated `TASKS.md` (42 total), while the 43-entry receipt had two symlink aliases (`AGENTS.md` followed changed target; `CLAUDE.md` target unchanged). Attempt 3 excludes aliases. |
| N3 validator warnings | Pass: `external-id-format` and `empty-work-domains` are DB-only warnings. They do not raise error counts or exit status; applicable `domains-without-work-domains` remains an error. |
| N4 push without detail mirror | Pass: mocked GitHub push includes canonical Acceptance and explicit missing-prose note when detail mirror is absent; no canonical revision means no invented Acceptance. Unterminated prose with canonical Acceptance refuses before any mocked remote call. No real GitHub requests were made. |
| F1/F2, F4–F7, T-092 | Pass: carried results still show honest null-date ordering, applicable DB structural/date/domain/state/reference checks, canonical push content, rejection of raw revised events carrying approval metadata, mandatory `expectRevision`, stale-write refusal, and finish publication preconditions inside the writer transaction. T-092 archived with null completion date validates; `done` still requires `completedOn`; cancelled/archived legacy dates are preserved and validated. |

# Operational limits and ownership behavior

These are observable contract boundaries, not hidden passes:

1. **Repo-wide checkpoint blocking:** one task with an unmatched fence in prose outside its owned Acceptance section blocks checkpoint generation for other tasks. A finish of another task may durably move it to `done`, but records no checkpoint and reports the build refusal. After fixing the malformed prose, retry publishes the checkpoint without a duplicate done move. This protects against false/partial checkpoint publication but creates a repo-wide availability dependency on every exported detail file.
2. **Unmatched fence inside owned Acceptance:** the analyzer does not flag this as outside prose. The generated Acceptance section owns and replaces its content through the next structural heading; with an unmatched fence open, later heading-looking lines are fenced text, not structural siblings. The pathological repro therefore removes following `## Notes`/`## Design` marker prose with the owned section. This matches the chosen “drop malformed content inside the owned section” rule; it does **not** preserve those heading-looking lines as prose. See `verify3-results.json` → `N1ownership` and `verify3.test.cjs`.
3. The fence tokenizer intentionally implements a documented subset, not full CommonMark. It treats indentation-insensitively by design for raw task details. Unmatched fences remain a manual repair requirement when canonical Acceptance must be rendered.
4. Date validation remains shape-based: impossible calendar values such as `2026-13-45` are not rejected by these changes, matching prior behavior. Raw invalid values can be admitted by mutation APIs and then reported by canonical validation; acceptance contract remains DB validation, not mutation-time validation.

# Latest-copy import, checkpoint, and repair proof

Luna child ran the new-parser proof against a fresh isolated clone of `/tmp/mapctx-t120-baseline/pre-review-attempt3-latest`; source checkout was never used as a writable `MAPCTX_HOME`. The importer read the frozen attempt-3 task-detail corpus; checkpoint targets were an isolated mirror clone.

| Check | Result |
|---|---|
| Source state | Schema 9; 1,044 events, 1,042 journals, 134 tasks, 93 receipts. Read-only validation returned `maintenance-needed`; one prepared SELECT plus connection-local `PRAGMA busy_timeout=5000`; DB/journal/store-meta hashes unchanged. |
| Migration and pre-import validation | Schema-10 migration preserved schema-9 rows and added migration metadata. Pre-import validation: 68 expected `completion-acceptance-incomplete` errors and 3 `bulk-updated-timestamp` warnings. 76 prepared statements, all SELECT; dry-run import wrote nothing. |
| Parser and import | Old/new acceptance parsers compared across all 134 frozen task details: 109 sections each, 0 result differences. Import: 109 events; 25 absent Acceptance sections; 0 unreadable/empty; 371 approved and 130 pending. All 134 source-byte hashes matched. The 371 observed approvals came from checked source criteria; no `done`-state inference. All 326 criteria on 68 `done` tasks were source-observed checked criteria. |
| Post-import validation | 0 errors; 3 timestamp warnings; semantic errors/warnings 0. No approvals were added to force green. The prior 68 errors were pre-adoption state, not a post-import regression. |
| Checkpoints | Two exports succeeded, 135 files each. Written file hashes matched returned hashes; checkpoint hash maps identical. Snapshot inspection after each: store-authority, no drift/issues. No refusal occurred on the real task corpus. |
| Preservation and repair | All 1,044 original event rows and 93 receipt rows preserved semantically. Only allowed event additions: 109 `acceptance.imported`, 2 `checkpoint.exported`; expected migration/checkpoint and acceptance projections added. All 1,042 original journal files SHA-256 exact. Both T-119 rows exact in all 11 raw fields; attestation file, witnesses, node/incarnation identity, createdAt, and history-dates unchanged. Repair ×2: both `ok`, 1,155 events replayed each; semantic changes 0. The 34 rows with repair diffs were embedded-JSON key ordering only. Ten migration `applied_at` timestamps refreshed; checksums unchanged. Logical clock advanced only for the 111 explicit appended events. |

Journal/table digests, SQL traces, parser comparison, scripts, summaries, and checkpoint mirror hashes are in `assets/preservation-evidence.tar.gz`. Raw full-table dumps remain in the private review artifact; the repository bundle excludes those dumps and writable DB/home and checkout clones.

# Build and test evidence

All commands ran from the isolated copy `/tmp/mapctx-t120-review-attempt3/code`; no build output was written to the frozen worktree or repository root.

```bash
zsh -lic 'npm run build:sync-engine'
zsh -lic 'npm run test:store && npm run test:sync-engine'
node --test /tmp/mapctx-t120-review-attempt3/verify3.test.cjs
node --test /tmp/mapctx-t120-review-attempt3/carried.test.cjs
```

Results: build exit 0; store 192/192; sync 121/121; focused attempt-3 probes 18/18; carried hold probes 9/9. Evidence logs and full JSON outputs are included under `assets/`.

# Integrity and process state

- Attempt-3 frozen worktree: **472/472** paths match `review-attempt3-start-manifest.json`, 0 mismatches.
- Root baseline: **465/465** paths match original `worktree-manifest.json`, 0 mismatches.
- Receipt: **43/43** evidence hashes match; delta: 44 paths including generated `TASKS.md`, receipt: 43 physical paths.
- Dispatch `7524abd1-8f3e-448b-8dd7-23774fd9ebb7` attempt 3 receipt says `completed`.
- Build/test shell exited code 0. Luna reported all preservation processes exited. No review process or child remains running.

# Provenance

- Focal attempt-3 probes/build/suites: this review chat, previously running Claude after API capacity switch; the preserved logs are the evidence of those executions.
- Preservation/import/checkpoint/repair: child Luna `e913e3aa-af20-4446-b475-8050eb6c0675`; preserved reports and SQL/table evidence bundled above.
- Consolidation and final manifest/receipt hash audit: resumed Codex `gpt-6-luna` (`849ef408-7ac7-4e4b-92ce-1762035a8155`). No tests or store operations were rerun during consolidation.
- Worker execution provenance remains receipt/coordinator-owned; no claims made beyond the recorded evidence.

# Assets

`assets/assets-manifest.json` lists SHA-256 and byte length for every copied asset. Key files: `verify3.test.cjs`, `verify3-results.json`, `carried.test.cjs`, `carried-results.json`, manifests, delta, receipt hash checks, integrity checks, logs, consumer outputs, and compressed preservation evidence.

## Repository promotion boundary

This is the complete review report, promoted with repros, logs, summaries, and hashes. The raw RunReceipt and full live-table dumps were excluded from the repository copy: receipts remain outside the committed tree, and event/claim payloads must not expose lease tokens. The preservation bundle here retains scripts, audit summaries, parser comparison, SQL traces, and table digests; it excludes the seven full table dumps. The original private artifact is preserved unchanged. The repository asset manifest describes this promoted subset and its actual hashes; omission does not change the recorded review verdict.
