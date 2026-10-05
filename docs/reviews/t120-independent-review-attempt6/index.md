---
kind: review
title: "T-120 attempt 6 focal CLI evidence review"
comments: none
---

# Verdict

**PASS for attempt-5 findings.** All three fixes hold in independent isolated CLI probes. Attempt-3 PASS/preservation stays historical; no full preservation rerun. No adoption opinion: parent owns integration.

# Verified

| Attempt-5 issue | Attempt-6 result |
|---|---|
| Malformed approval args opened writable store first | Fixed for CLI-shape/evidence/source-read refusals. Public CLI test reconstructs true schema 9 (drops migration-10 tables/row and added column), adds unreplayed journal, snapshots DB, store-meta, and journal hashes. Malformed evidence, unsupported evidence on unapprove, and missing revision each refuse with every hash unchanged; schema remains 9 and pending journal remains unreplayed. Valid writable control then migrates to 10. |
| No `--evidence` changed null to `{}` | Fixed. Approval without flag returns `null` in `task acceptance show` and `acceptance.approved` event. The public CLI test covers show; an isolated `/tmp`-only assertion also checks event payload. |
| `__proto__` evidence key was dropped | Fixed. `Object.fromEntries` retains own `__proto__`, `constructor`, `toString` values exactly in public `show` and event payload. |

Also held: ordinary multiple pairs, embedded `=`, malformed/stale refusal without acceptance events, revise resets evidence, unapprove rejects evidence, attest-orphan shared helper behavior, and help accurately says no snapshot-drift gate. Focused suites: 16/16 pass (13 task-write, 3 attest-orphan). Isolated `build:sync-engine`: exit 0.

# Preflight boundary

Preflight covers CLI syntax/shape, evidence parsing, and source-file read/parse before writable open. Store-dependent checks still happen after open: stale `--expect-revision`, unknown task/criterion, already-approved state. Those may trigger schema migration or pending-journal replay before refusal. This is an intentional boundary; stale revision cannot be verified without canonical store state. Do not read the comment as a zero-write guarantee for every store-dependent refusal.

# Provenance and limits

- Attempt 6 receipt says completed, dispatch `7524abd1-8f3e-448b-8dd7-23774fd9ebb7`, attempt 6; worker provenance OpenCode / GLM 5.3 Flash. Receipt's 43 physical evidence hashes all match this frozen source (manifest in `assets/receipt-integrity.json`). Coordinator reports attempt-5-to-6 source delta limited to `mapctx-cli.ts`, `task-write.test.ts`, and durable review report.
- Build and focused tests ran in `/tmp/mapctx-t120-review-attempt6/code`, with exit 0. Attempt-6 worker-reported full suites (store 192, sync 124) are not independently rerun here.
- **Execution deviation:** one initial build was accidentally launched with frozen worktree as cwd. Tool process is no longer running; tool returned no exit code after interrupt request. It wrote generated `dist` outputs only; no source file was edited. Receipt hashes were rechecked afterward and remain 43/43. All later builds/tests used isolated `/tmp` copy. This is recorded rather than treated as a clean-room build.
- Parent reports worker claim released and all worker processes exited. Reviewer one-shot build/test processes exited (build 0, focused 0); no reviewer process remains. No claim, board, live store, source, root integration, migration/import/repair, or remote changes by reviewer. Live store remains schema 9 per coordinator; no adoption authorized by this review.
- Attempt-3 broad PASS and preservation results remain historical. This focal pass does not rerun import/export/repair preservation, full suites, or claim that historical output was replayed.

# Assets

`assets/assets-manifest.json` pins evidence files. See `commands.txt`, isolated logs, source diffs, exact probe tests and 43/43 receipt hash audit. The raw RunReceipt remains outside the repository; this promoted copy includes its integrity report.
