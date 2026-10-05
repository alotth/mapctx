---
kind: review
title: "T-099 independent review — planned, forecast and measured time"
comments: none
---

# Headline: FAIL

T-099 is not ready to close. Three acceptance-critical defects and one supported-mode gap require adjustment. Review is code-based against `7fdc161`; no tests were run, per operator instruction.

## Findings

### P1 — `estimatedEffort` does not drive Planned when dates exist

`plannedForTask` returns the calendar-date plan before parsing `estimatedEffort` ([`packages/sync-engine/src/gantt.ts:194`](../../../packages/sync-engine/src/gantt.ts#L194)). `actualVsPlannedRatio` then consumes that returned duration ([`packages/sync-engine/src/gantt.ts:387`](../../../packages/sync-engine/src/gantt.ts#L387)). A task with `start`, `due`, and `estimatedEffort: 0.5d` is therefore compared against inclusive calendar span, not four agent-active hours. This contradicts T-099 requirement that parsed effort drive planned duration and ratio.

Required adjustment: preserve dates for calendar placement, but use valid `estimatedEffort` for planned duration/ratio when present; define fallback to date duration only when effort is absent/invalid. Add combined dates+effort coverage.

### P1 — claim hard gate accepts semantically missing plans

Gate checks only non-empty strings ([`packages/store/src/claims.ts:42`](../../../packages/store/src/claims.ts#L42)). Thus `workload=Medium`/`Banana` and `estimatedEffort=tomorrow` pass claim. Gantt later treats unknown workload as undeclared ([`packages/sync-engine/src/gantt.ts:23`](../../../packages/sync-engine/src/gantt.ts#L23)) and effort parser returns no plan ([`packages/forecast/src/format.ts:47`](../../../packages/forecast/src/format.ts#L47)). Central guarantee—no executable claim without workload and plan—remains bypassable.

Required adjustment: validate canonical workload enum and parseable positive effort at create/update/claim boundaries. Claim refusal must retain exact repair commands. Add invalid-workload, invalid-effort, and zero-effort cases.

### P1 — repository skill hard gate is absent from changeset

Worktree repository still has old hard gate at [`skills/mapctx-traycer/SKILL.md:12`](../../../skills/mapctx-traycer/SKILL.md#L12), and `git diff` contains no skill change. Intended text exists only as uncommitted dirt in `/Users/alt/repos/mapctx/skills/mapctx-traycer/SKILL.md` (executor also reported editing installed `/Users/alt/.codex/skills/...`). Merging T-099 worktree would omit required create-time workload/effort rule and 1d=8h convention.

Required adjustment: carry intended hunk into repository skill inside T-099 worktree/changeset; do not rely on installed personal skill or another checkout.

### P2 — pre-cutover Gantt still ignores detail effort

`mapctx gantt` promises both pre-cutover and store modes, but Markdown branch maps only board fields and empty receipts ([`packages/sync-engine/src/mapctx-cli.ts:711`](../../../packages/sync-engine/src/mapctx-cli.ts#L711)). It never reads task detail, so `estimatedEffort` and provenance never reach `buildGanttDataset`. Store-authority mode is wired; supported Markdown mode keeps old missing-Planned behavior.

Required adjustment: resolve each detail file in pre-cutover path and pass `estimatedEffort` plus source. Add CLI-level coverage for a Markdown-authority task with effort and no dates.

### P2 — provenance migration/export/import lacks direct regression coverage

Schema v6, projection, import and export code carry `estimatedEffortSource`, but added tests do not exercise a v5→v6 row nor an explicit `agent-active` import→export round trip. Gantt test hand-builds source, so it cannot catch loss before presentation. This leaves explicit migration/export-import test acceptance unproven.

Required adjustment: add focused migration assertion for nullable legacy rows and import/export round-trip assertion preserving `estimatedEffortSource: agent-active`.

## Confirmed behavior

- Parser convention is 1d=8 active hours and 1w=40 active hours; legacy absence remains distinguishable.
- Schema v6 and projection/import/export wiring are internally consistent on inspection.
- Done task with receipt and no plan gets `aligned-from-actual`; ratio is null and accuracy eligibility false.
- Done task without receipt gets `no-measurement`; receipt-less tasks add no duration sample.
- UI exposes planned provenance, aligned exclusion, substituted coverage, and no-measurement state.
- Approved workload backfill matches operator approval: T-067/T-069 Easy; T-068/T-075/T-077/T-083/T-095/T-096 Normal; T-070/T-071/T-072/T-073/T-074/T-076/T-094/T-097/T-098 Hard. T-078 and T-090 are Normal.

## Review boundary

Baseline dirt in `TASKS.md`, T-096, ADR 0003, and Workspace V2 CSS/JS was separated by comparison with `/Users/alt/repos/mapctx`. Only T-099 hunks were assessed. No source, test, or MapCtx state was changed by this review.
