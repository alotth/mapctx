---
name: mapctx-correct-course
description: Capture and apply mid-execution scope changes with minimal-diff updates while keeping the MapCtx task contract and decision trail intact.
---

# MapCtx Correct Course

Use this skill when the operator needs to adjust scope or execution direction after work has already started.

Keep this file focused on operational flow. Load detailed guidance from:

- `./references/flow.md`
- `./references/correction-template.md`

## Trigger Situations

- The user says the task scope changed mid-stream.
- A blocker or new discovery requires changing acceptance, sequencing, or non-goals.
- Work needs a traceable correction without rewriting unrelated task context.

## Guardrails

- Keep corrections small and traceable.
- Update the task detail file first unless the change is clearly broader than one task.
- Escalate to `docs/ROADMAP.md`, `docs/methodology.md`, or `docs/adr/` only when the change affects sequencing, repo-wide policy, or durable architecture.
- Do not rewrite `TASKS.md` broadly; make minimal, targeted edits only when the task graph or status actually changes.
- Default to a single-agent workflow; use broader planning or subagents only when the correction spans multiple tasks or domains.

## Response Format

- Trigger for correction.
- Affected artifacts.
- Edits applied.
- Remaining risks or open decisions.
- Recommended next operational step.
