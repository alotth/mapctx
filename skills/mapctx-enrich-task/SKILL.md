---
name: mapctx-enrich-task
description: Enrich a task detail file with missing product, dependency, and implementation context while keeping planning product-first and low-token.
---

# MapCtx Enrich Task

Use this skill when a task detail file exists but is too thin to support confident execution.

Keep this file focused on operational flow. Load detailed guidance from:

- `./references/flow.md`
- `./references/output-contract.md`

## Trigger Situations

- The user asks to enrich or expand a `tasks/<ID>.md` file.
- A task detail file is missing key context such as outcome, constraints, dependencies, or verification hints.
- The task is complex enough that execution would otherwise rely on guesswork.

## Guardrails

- Keep `TASKS.md` and `tasks/<ID>.md` as the only operational source of truth.
- Keep detail files product-first; do not jump straight to implementation.
- Default to a single-agent workflow. Only escalate to deeper research or subagents when the task is clearly broad, cross-domain, or high-risk.
- Do not answer unresolved decisions speculatively; record them under `Open Decisions for Execution` instead.
- Do not over-prescribe implementation for `lite` or ordinary `standard` work.

## Response Format

- Gaps found.
- Sources used.
- Sections added or updated.
- Open questions that remain.
- One recommended next action.
