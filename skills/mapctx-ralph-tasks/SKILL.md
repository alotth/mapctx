---
name: mapctx-ralph-tasks
description: Run Ralph task loops from a single slash trigger `/mapctx-ralph-tasks`; use when user wants automatic TASKS.md status transitions, task detail loading from ./tasks/<ID>.md, complexity-based iteration count, and deterministic completion markers with error-aware retry handling.
---

# Ralph Kanban Tasks

Use this skill for Ralph task-loop execution requests that map to the `/mapctx-ralph-tasks` workflow.

Keep this file focused on workflow and decisions. Load details from:

- `./references/flow.md`
- `./references/prompt-contract.md`
- `./references/retry-policy.md`

## Trigger

- Preferred trigger is `/mapctx-ralph-tasks`.
- If the trigger is exactly `/mapctx-ralph-tasks`, proceed with normal parsing and execution.
- If the request maps to this workflow but trigger is different, do not auto-execute; ask a confirmation question first: "Do you want me to execute Ralph Kanban Tasks now?".
- After explicit confirmation, continue using the same workflow and command-shape validation.

## Supported Command Shape

- `/mapctx-ralph-tasks do t-1`
- `/mapctx-ralph-tasks do T-001`
- `/mapctx-ralph-tasks do e-1`
- `/mapctx-ralph-tasks do E-001`
- Optional override: `/mapctx-ralph-tasks do t-1 --max-iterations 20`
- Optional dry-run: `/mapctx-ralph-tasks dry-run do t-1`

## Workflow

1. Parse command and normalize task ID to `T-XXX` or `E-XXX`.
2. Validate task exists in `TASKS.md` single-list model.
3. Read task metadata and detail file path.
4. Transition task to `doing` with low-conflict edits (`status`, `updated`, and `completed` policy if needed).
5. Determine `max-iterations` from `workload` unless user explicitly overrides.
6. Build Ralph prompt using references and include deterministic promises.
7. Execute `ralph` with required flags `--agent codex --model gpt-5-codex` and retry behavior from `./references/retry-policy.md`.
8. Inspect final output marker and transition status:
   - `<promise>COMPLETE_TESTED</promise>` => `done`
   - `<promise>COMPLETE_REVIEW</promise>` => `review`
9. Validate board consistency and return concise execution report.

## Status Rules

- Before running Ralph: set target task to `doing`.
- After run:
  - `done` when marker is `COMPLETE_TESTED`.
  - `review` when marker is `COMPLETE_REVIEW`.
- Always update `updated` on edits.
- Keep canonical field order unchanged.

## Guardrails

- Never reformat unrelated task blocks.
- Never auto-edit more than the targeted task block unless user explicitly asks.
- Never run unbounded loops; always set max iterations.
- Never retry prompt/parse errors.
- For `401 Unauthorized`, do not insist; provide re-login action.

## Output Format

Return concise operational updates with:

- Task resolved and normalized ID.
- Ralph command used (or dry-run command).
- Iteration limit source (workload or explicit override).
- Retry summary by error class.
- Final status transition and reason.
