---
kind: review
title: "T-099 independent review — attempt 3"
comments: none
---

# Headline: FAIL

The three attempt-2 findings are resolved. One acceptance-critical UI gap remains: the new Planned duration/provenance renderer is unreachable from the visible roadmap. T-099 should remain in review.

## Finding

### P1 — connect Planned duration and provenance to the visible Gantt row

The new Planned bar, duration label, and source tooltip are implemented inside [`renderDurationCell`, workspaceV2.js:1608](../../../packages/vscode-extension/src/html/workspaceV2.js#L1608), but that function has **no callers**. The live [`renderRoadmapRow` path at line 1549](../../../packages/vscode-extension/src/html/workspaceV2.js#L1549) renders only task-signal chips and a calendar cell. Its chips expose Forecast and variance, without Planned duration or source; its calendar cell uses dates and renders `Unscheduled` when dates are absent.

Realistic trigger: create a task with `workload: Normal`, `estimatedEffort: 0.5d`, and no start/due dates, then open Workspace V2's roadmap. The API correctly returns a 4-hour Planned duration, but the visible row never shows that plan. This misses the central acceptance requirement that effort produce visible Planned even without dates. Historic estimates also lose the required legacy-human warning: the visible variance badge compares against the historic denominator without exposing its source.

Targeted runtime reproduction used the current compiled `buildGanttDataset` and the actual function declarations extracted from the current UI source, invoking `renderRoadmapRow` directly:

| Input | API output | Visible row output |
| --- | --- | --- |
| Ready task, Normal, `0.5d`, agent-active, no dates/receipt | `durationMs: 14400000`, `source: estimated-effort-agent-active`, `coverage: duration-only` | `[T-110] New estimate Ready / Wave 1 P50 14m / P90 29m prior / uncalibrated awaiting actual Unscheduled` — no Planned value or source |
| Review task, Normal, legacy `1w`, 2-hour receipt, no planned dates | `source: estimated-effort-legacy-human`, ratio `0.05` | Forecast/coverage chips, `20× under plan`, and Actual bar — no legacy-human warning |

Source search finds exactly one `renderDurationCell(` occurrence: its declaration. [`plannedSourceLabel` at line 1684](../../../packages/vscode-extension/src/html/workspaceV2.js#L1684) is used only inside that unreachable duration renderer and its unreachable accessibility helper. Dataset tests called “Gantt renders…” verify JSON, not the visible row.

Required adjustment: expose `task.planned.durationMs` and its provenance through the live row renderer. Either wire the duration renderer into the visible layout or add equivalent Planned/source chips to the existing row. Keep dates as calendar positioning. Include actual `activeTimeCoverage` where actual duration is shown; the new actual-coverage tooltip/label currently lives in the same unreachable renderer. Verify rendered output for agent-active and legacy estimates without dates, plus aligned/no-measurement states. This is a wiring fix, not a request for a new layout design.

## Prior issue dispositions

| Review issue | Disposition in attempt 3 |
| --- | --- |
| Attempt 2: reconcile omits provenance and leaves edited legacy effort legacy | Fixed. Source participates in diff; accept validates authored source/workload/effort, stamps effort-value edits agent-active, supports source removal, and re-exports. Source-only discard/accept and legacy-value edit regressions exist. |
| Attempt 2: `detail.estimatedEffort=null` crashes | Fixed. Update normalizes null to empty effort and persists a clearing marker so prior active provenance disappears during event replay. Store and CLI regressions assert missing-plan claim refusal. |
| Attempt 2: rounded-zero/overflow effort admitted | Fixed. Shared parser checks the converted, rounded result for finite positive milliseconds. Create/update/claim/reconcile use that parser; boundary regressions exist. |
| Attempt 1: dates override effort duration/ratio | Fixed in dataset. Valid effort owns duration and ratio; dates position the calendar bar. Combined dates/effort and invalid-effort fallback coverage exists. The visible UI gap above remains distinct. |
| Attempt 1: canonical workload/positive-effort gate missing | Fixed. Create/update validate supplied values; claim refuses missing/invalid values with exact repair commands. Epics retain the claim exemption. |
| Attempt 1: repository skill convention absent | Fixed. Repository skill contains the workload/effort hard gate and 1d=8h / 1w=40h convention; CLI help and ADR agree. |
| Attempt 1: pre-cutover Gantt omits detail effort | Fixed. Markdown CLI branch reads detail effort/source; CLI-level duration-only coverage exists. |
| Attempt 1: migration/import-export coverage absent | Fixed. v5→v6 nullable legacy migration and explicit agent-active import/projection/export coverage exist. |

## Cross-path audit

- Create stamps supplied effort agent-active; missing effort stays empty, with warnings rather than an invented duration. Update validates and stamps edits; clearing preserves a missing plan.
- Import/context/export/projection paths carry agent-active provenance. Absent or explicit legacy-human input is canonically represented by absence; existing estimates retain their legacy meaning. Schema v6 adds a nullable column without rewriting legacy rows; historical event replay defaults to legacy.
- Reconcile handles source-only changes and effort-value edits; invalid values are refused before journal append. Claim uses canonical workload and the shared finite-positive parser.
- Both store and pre-cutover CLI Gantt branches supply effort/source. Valid effort drives duration/ratio; calendar dates remain placement and explicit fallback.
- Done work with receipt and no effort/dates gets aligned-from-actual, null planned ratio, and false accuracy eligibility. Done work without receipt gets no-measurement and contributes no fabricated duration sample. Both markers reach the live task-signal chips in the targeted renderer check.
- Forecast duration pools are receipt-derived; retrospective Planned is not used as an independent calibration sample. Receipt-only Gantt actuals report substituted coverage in the dataset. T-100 measurement work remains outside this review.

No additional backend blocker was substantiated in these paths.

## Verification and limits

Review covered T-099 uncommitted changes against `7fdc161`, including changed lines and callers. Compared ADR and Workspace V2 UI against `/Users/alt/repos/mapctx` to separate unrelated baseline changes; excluded unrelated board/T-096/workspace edits. Read both prior review artifacts and the executor's attempt-3 report.

Own checks: two read-only Node/VM renderer reproductions using current UI source and compiled Gantt builder; `git diff --check` passes. No test suite or build rerun: the reported successful builds/focused suites are executor evidence, not independently reproduced here. New regression tests were inspected. No live browser/layout validation was performed; the missing function call and rendered HTML were verified directly.

No source/tests, project MapCtx state, staging, commits, or generated snapshots were modified. Only this review artifact was written. T-099 was not marked done.
