# Flow

Use this sequence for structured scope correction.

## 1) Load the current context

- Read `TASKS.md` and the target `tasks/<ID>.md` file.
- Identify the task's current `status`, `workload`, `domains`, `dependsOn`, and acceptance intent.
- If the correction touches sequencing or durable decisions, read the smallest relevant supporting doc set:
  - `docs/ROADMAP.md`
  - `docs/methodology.md`
  - matching ADRs

## 2) Capture the correction

- Record the reason for change.
- Record whether the change is:
  - local to one task
  - cross-task but still operational
  - roadmap-level
  - durable methodology or architecture change
- Record the proposed impact on scope, acceptance, dependencies, or verification.

## 3) Choose the landing zone

- Task-local change -> update `tasks/<ID>.md`.
- Dependency or sequencing change -> update task detail first, then `TASKS.md` or `docs/ROADMAP.md` only if needed.
- Durable repo-level change -> add or update `docs/adr/` and adjust methodology docs as needed.

## 4) Apply minimal-diff updates

- Prefer updating these sections in the task detail file:
  - `## Non-Goals`
  - `## Constraints`
  - `## Open Decisions for Execution`
  - `## Decisions Taken`
  - `## Implementation Notes`
- Preserve prior reasoning; do not delete old open questions just because the answer changed.
- Add dated decision entries for resolved scope changes.
- Update `TASKS.md` only when dependencies, status, or related operational metadata actually changed.

## 5) Decide whether escalation is needed

- Stay single-agent by default.
- Escalate to broader planning or review only when:
  - multiple tasks must be changed together
  - the correction crosses several domains
  - the change invalidates the current execution order
  - the change affects repo-wide methodology or architecture assumptions

## 6) Report clearly

- Explain what changed and why.
- List which files were updated.
- Call out any remaining decisions or blockers.
- Recommend the next action: resume execution, re-plan, or seek clarification.
