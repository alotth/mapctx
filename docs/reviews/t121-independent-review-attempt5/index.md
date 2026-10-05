---
title: "T-121 attempt 5 independent review"
kind: review
comments: none
---

# Verdict

**FAIL — P2 documentation provenance mismatch.** Renderer, export/checkpoint refusal, push refusal, and copy-recovery behavior passed independent validation. One sentence in the durable recovery report overstates which authored Acceptance prose existed in the current inputs; correct that provenance wording before using the report as the recovery record. The frozen source worktree, repo root, real ELA and real store remained unchanged; only this requested review artifact and `/tmp` evidence were written.

## Finding

### P2 — Recovery report says current Acceptance notes were composed, but none existed

[docs/reviews/t121-acceptance-prose-preservation-2026-10-05.md:42](../../../docs/reviews/t121-acceptance-prose-preservation-2026-10-05.md:42) says the copy combined incident-source Acceptance prose with “as notas Acceptance atuais”. Independent audit of all 15 current task descriptions found **zero authored Acceptance lines** in those current inputs. The 54 authored Acceptance lines in the resulting copy all match the incident commit `fc3a5e2`; current authored prose was outside Acceptance and stayed byte-identical. The report’s later total of 172 current prose lines is consistent with that outside-Acceptance content, not with current Acceptance notes. The copy-proof boolean `currentAuthoredAcceptanceLinesRetained` is true vacuously for these 15 inputs.

The recovery output itself passed: historical authored Acceptance lines and order were preserved, current outside-Acceptance prose remained byte-stable, and canonical criteria/state remained store-identical. Finding is documentation/provenance only; reviewer did not edit the frozen source.

## Independent validation

| Gate | Result |
| --- | --- |
| Isolated `npm run build:sync-engine` | PASS, exit 0 |
| Isolated store suite | PASS, 219/219 |
| Isolated sync-engine suite | PASS, 131/131 |
| Independent renderer oracle: T-063, empty/absent authority, orphan evidence, checkbox-only reorder, preface, hierarchy, duplicate bullets, fences, multiple sections, new section | PASS |
| Independent public `mapctx export --reason manual --json`: both trailing-evidence cases | PASS; both refused at `stage: build`; repo and store facts unchanged |
| Independent store-backed push: both trailing-evidence cases | PASS; refusal before the mocked GitHub runner; zero runner calls; repo unchanged |
| Independent 15-task recovery audit in fresh `/tmp` repo/store copy | PASS; 54 incident Acceptance lines retained in order; current authored Acceptance count 0; current prose outside Acceptance and canonical criterion text/state matched; two exports produced identical path/hash manifests |
| Receipt/readback, attempt 5 | PASS; 6 changed-file entries, 11 evidence entries, all 11 referenced file hashes match; readback reports attempt 5 completed |

Carried review gates F1/F2/F3/F4/N1 passed: empty/absent revision preserves prose or refuses stale checkboxes; orphan evidence refuses; reorder without authored anchors canonicalizes; ambiguous interleaved/trailing prose refuses; matched nested bullets retain indentation while hierarchical reorder refuses; unclosed fences and multiple real Acceptance sections refuse. Code contains no schema or import-parser change. Push renders all task descriptions before `getIssues`, so renderer refusal precedes GitHub calls.

## Provenance and limits

- Reviewed frozen worktree copied from current dirty state into `/tmp/mapctx-t121-attempt5-review-copy`; copy excludes `.git`. Build and suites ran only there.
- Source worktree hash manifests at review start/end contain 1,535 files and match exactly; `git status` remained 210 lines. The frozen source worktree, repo root, real ELA and real store remained unchanged. All commands/processes exited.
- Worker’s honest pre-completion baseline pins eight files and a 210-line status digest, not every dirty file; `checkpoint.test.ts` lacked a pre-edit hash. The earlier attempt-4 hash file has 547 whitespace-only lines and was not a usable baseline. No claim is made that all inherited dirty worktree state was byte-compared.
- Attempt-5 receipt is dispatch `c8adf88f-bc41-41ed-8719-5eadbbe2c844`, completed at `2026-10-05T15:36:28Z`; receipt names six changed paths and 11 evidence records (six path evidence plus five logs/proof/baseline records). All recorded evidence digests match current referenced files.
- Worker copy proof pinned ELA HEAD `9933dd5c8326b7ac3fe8136fc8f6eea70b7df212`. During this review, ELA HEAD was `d6b6f581aaff1c44da865bdfc77e329b38a699f9`; all 15 affected task path hashes still matched the worker’s input pins. A fresh copy proof verified its own before/after HEAD and task-path pins. First checkpoint changed 294 mirror files in that newer copy because of pre-existing snapshot drift; only copy was changed.
- No actual ELA recovery, GitHub operation, board mutation, claim/receipt, or task Acceptance approval was performed by reviewer. Real ELA recovery remains a coordinator decision.

## Evidence

Repro scripts, complete isolated build/store/sync logs, source/copy manifests, sanitized receipt audit, ELA pins, and recovery proof are in [evidence](evidence). Prior independent attempt-3 repros and carried oracle are in [attempt 3 review](../t121-independent-review-attempt3).

The manifest at [assets-manifest.json](evidence/assets-manifest.json) records SHA-256 and byte sizes for review assets. No raw receipt, lease/token material, or database copy is included.
