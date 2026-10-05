---
kind: review
title: "T-099 independent review — attempt 4"
comments: none
---

# Headline: PASS

T-099 passes review against its full acceptance scope, combining the unchanged backend audit from [attempt 3](attempt-3.md) with this review of the live UI fix. No actionable blocker remains. Integration, acceptance marking, and the move to done remain the orchestrator's next steps; this reviewer performed none of those mutations.

## Attempt-3 blocker resolved

The visible path is now `renderRoadmap → renderRoadmapTimeline → renderRoadmapGroups → renderRoadmapRow → renderTaskSignalChips`. The [`row call at workspaceV2.js:1549`](../../../packages/vscode-extension/src/html/workspaceV2.js#L1549) reaches the corrected [`signal renderer at line 1556`](../../../packages/vscode-extension/src/html/workspaceV2.js#L1556), which exposes:

- Planned duration and explicit agent-active/legacy-human provenance, including plans without dates.
- Variance immediately after the Planned/source chip, preserving the context for legacy comparisons.
- Actual duration and its own coverage, explicitly `substituted (not measured)` for receipt-only data. Coverage is read from Actual, independently of Forecast coverage.
- Existing Forecast/provenance chips, aligned exclusion, and no-measurement markers.

Calendar placement remains driven by dates. The legend no longer describes every Actual as measured. [`CSS at workspaceV2.css:1466`](../../../packages/vscode-extension/src/html/workspaceV2.css#L1466) lets signal chips wrap rather than clipping the longer sequence. The earlier duration-cell helper still need not be called: equivalent Planned/source information now reaches the existing visible row, satisfying the remedy proposed in attempt 3.

No concrete regression was found in chip ordering, escaping, source normalization, calendar placement, missing data, or the preserved Forecast content.

## Regression validity and results

Ran the new targeted suite independently:

```sh
zsh -lic 'node --test packages/vscode-extension/src/test/workspaceV2.roadmap.test.cjs'
```

**5 tests passed, 0 failed.** [`workspaceV2.roadmap.test.cjs`](../../../packages/vscode-extension/src/test/workspaceV2.roadmap.test.cjs) reads and executes the actual UI JavaScript source in a VM, then invokes `normalizeRoadmapTasks → buildRoadmapTimeline → renderRoadmapRow`. It does not substitute a private renderer or assert only API JSON, so it directly protects against the orphan-renderer defect from attempt 3.

| Case | Verified visible behavior |
| --- | --- |
| Agent-active `0.5d`, no dates | `Planned 4h · agent-active estimate`; calendar honestly remains Unscheduled |
| Dates plus `0.5d` effort | Planned stays 4h; a planned calendar span exists |
| Legacy `1w` plus 2h receipt | Legacy-human source appears immediately before `20× under plan`; Actual is 2h and explicitly substituted |
| Aligned and receipt-less done work | Aligned source/exclusion appears without a fabricated plan ratio; no-measurement row has no fabricated Actual duration |
| Actual with measured coverage | Measured active time appears; substituted wording does not |

## Acceptance and prior issue dispositions

| Requirement / prior finding | Disposition |
| --- | --- |
| Agent-active convention in parser, repository skill, CLI help, ADR | Pass, carried forward. 1d=8h and 1w=40h remain documented consistently. |
| Effort owns Planned duration/ratio; dates position the bar | Pass. Backend combined-input coverage was reviewed previously; new live-row test confirms displayed effort duration with dates. |
| Visible Planned without dates and explicit legacy-human warning — attempt-3 P1 | Fixed and independently verified by the new live-row tests. |
| Canonical workload and finite-positive effort at create/update/claim; repair commands; epics exempt | Pass, carried forward from the backend audit. Missing create inputs warn without inventing an effort. |
| Reconcile provenance accept/discard and edited legacy values — attempt-2 P1 | Fixed, carried forward. Source-only changes reconcile; authored source/workload/effort validate; effort-value edits stamp agent-active. |
| Explicit null effort clear — attempt-2 P2 | Fixed, carried forward. Empty effort and cleared provenance persist; claim refuses the missing plan. |
| Parser rounded-zero and overflow — attempt-2 P2 | Fixed, carried forward. Rounded milliseconds must be finite and positive. |
| Aligned-from-actual exclusion and no-measurement eligibility | Pass. Backend ratio/accuracy and sample-pool behavior remain as audited; both states now verified through actual row normalization/rendering. |
| Store and pre-cutover Gantt, migration/backward compatibility, import/export/context | Pass, carried forward. Explicit agent-active survives; legacy absence remains legacy; v5→v6 coverage exists. |
| Medium→Normal normalization and approved open-task workload backfill | Carried forward from prior reviews; attempt 4 changes no planning/backfill behavior. |
| Actual substituted coverage remains distinct from measured data | Pass. Live chips and corrected legend now expose the distinction; measured coverage test validates presentation only, not T-100's future measurement implementation. |

All previously reported actionable findings are resolved. No new findings.

## Scope and limits

Reviewed attempt-4 UI wiring, legend, CSS change, and new regression file in the same worktree. Compared Workspace V2 JS/CSS with `/Users/alt/repos/mapctx`; unrelated baseline target-selection/sidebar/style changes remain present, with differences confined to T-099 UI work. `git diff --check` passes.

Backend was unchanged per handoff; reused attempt-3's create/update/import/export/reconcile/claim/context/Gantt/forecast and migration audit. Did not repeat backend suites or builds. Prior successful backend builds and suites remain executor-reported evidence; this reviewer independently ran only the five new UI tests. Existing dataset tests and the earlier direct builder/renderer reproductions supply the separate API side of the review.

The VM tests verify emitted row HTML using representative dataset shapes. They do not start a server, exercise browser layout, validate pixel-level wrapping, or verify the post-integration packaged asset copy. No live browser check was performed. Main CLI build and integration remain pending with the orchestrator.

No source/tests, MapCtx state, staging, commits, or generated snapshots were modified. Only this review artifact was written. T-099 was not marked done.
