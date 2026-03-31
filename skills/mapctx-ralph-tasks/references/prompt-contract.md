# Prompt Contract

Use this contract to build deterministic Ralph prompts.

## Required Prompt Sections

1. Task scope and target ID (`T-XXX` or `E-XXX`).
2. Required context files:
   - `@TASKS.md`
   - `@tasks/<ID>.md`
3. Execution requirements:
    - implement requested changes
    - respect `## Work Domains` definitions from `TASKS.md`
    - prioritize changes in areas indicated by task `domains`
    - accept `touch` only as deprecated legacy alias
    - run relevant tests/checks when available
    - keep edits minimal and scoped
4. Completion markers (mandatory):
   - `<promise>COMPLETE_TESTED</promise>`
   - `<promise>COMPLETE_REVIEW</promise>`

## Completion Marker Rule

- Use `<promise>COMPLETE_TESTED</promise>` only when code changes are complete and required tests/checks succeeded.
- Use `<promise>COMPLETE_REVIEW</promise>` when work is implemented but requires human review or tests/checks were not fully validated.
- Never use any other completion marker.

## Ralph CLI Template

```bash
ralph "Work only on task <ID> using @TASKS.md and @tasks/<ID>.md. Implement what is needed for this task. Keep changes scoped to the task. Run relevant tests/checks. If implementation is complete and tests/checks passed, output <promise>COMPLETE_TESTED</promise>. If implementation is complete but still needs human review or tests were not fully validated, output <promise>COMPLETE_REVIEW</promise>." --agent codex --model gpt-5-codex --max-iterations N --completion-promise COMPLETE
```

Recommended prompt addition before execution:

- "Use `## Work Domains` in `TASKS.md` as the project registry and keep edits aligned with this task's `domains` keys (`touch` is legacy)."

Notes:

- Keep `--completion-promise COMPLETE` so either deterministic marker ends the loop.
- Always include `--agent codex --model gpt-5-codex` in Ralph execution commands.
- If repo has additional constraints (lint/test command), inject them explicitly into prompt text.

## Dry-Run Output

When `dry-run` is requested, return:

- normalized task ID
- computed iterations and source
- rendered `ralph` command
- expected status transitions (`doing` before run, `done/review` after marker)
