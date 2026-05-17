---
name: mapctx-plan-engine
description: Validate TASKS.md contract and generate dependency-wave execution plans via mapcs validate/plan; trigger for board QA, DAG checks, and next-wave planning.
---

# Planning Engine

Use this skill to run low-risk planning commands that validate board quality and produce an execution plan.

Keep this file focused on operational flow. Load command details from:

- `./references/validate-flow.md`
- `./references/plan-flow.md`

## Trigger Situations

- User asks to validate `TASKS.md` structure/contract.
- User asks for dependency order, wave order, or next runnable tasks.
- User asks for a Mermaid task graph.
- User wants a preflight before execution/sync.

## Workflow

1. Run preflight for CLI availability.
   - Check `command -v mapcs`.
   - If missing, use `npx --yes --package @mapctx/sync-engine mapcs <command>`.
   - Do not use `mapcs <command> --help` as a health check.

2. Resolve board input.
   - Prefer `./mapcs.config.json` when present.
   - If config is absent but `./TASKS.md` exists, run read-only commands with `--tasks-file ./TASKS.md`.
   - If config is absent and no tasks file is known, use `mapctx-sync-engine` to create a local-only config with `mapcs init` or ask for the tasks file path.

3. Validate board first.
   - Run `mapcs validate` before any planning output.
   - Include `--tasks-file <path>` when operating without config or outside the board root.
   - If validation fails, stop and report blockers.

4. Generate plan only after validation passes.
   - Run `mapcs plan`.
   - Include the same `--tasks-file <path>` used during validation.
   - Include `--mermaid` when user asks for graph output.

5. Return concise planning summary.
   - Include validation result, wave count, first wave tasks, blockers/cycles, and recommended next action.

## Guardrails

- Never run write/sync commands (`pull`, `push`, `bootstrap`, `reconcile`) in this skill.
- Never create or edit `mapcs.config.json` here; route config setup to `mapctx-sync-engine`.
- Never hide validation errors; show blocking issues first.
- Never auto-change `TASKS.md` from planning commands; report and suggest fixes.

## Response Format

- Validation status (`PASS`/`FAIL`) with key issues.
- Plan summary (`waves`, `first wave`, `recommended next`).
- Optional Mermaid note when requested.
- One practical next step.
