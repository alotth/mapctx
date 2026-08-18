# Flow

Use this sequence when enriching a task detail file.

## 1) Identify the task and current gaps

- Read `TASKS.md` and the target `tasks/<ID>.md` file.
- Capture task metadata that affects enrichment: `type`, `status`, `workload`, `domains`, `dependsOn`, `detail`, and `specMode` when present.
- Identify what is missing or weak in the detail file:
  - product context
  - expected outcome
  - acceptance detail
  - constraints
  - dependency context
  - implementation notes or verification hints

## 2) Gather only relevant supporting context

- Read the smallest useful set of supporting docs first:
  - `docs/PROJECT.md`
  - `docs/ROADMAP.md`
  - `docs/methodology.md`
  - linked ADRs when the task clearly touches a durable decision
- If needed, read detail files for prerequisite tasks listed in `dependsOn`.
- If needed, inspect a narrow set of code or package docs referenced by the task.
- Avoid broad repo exploration when a focused read is sufficient.

## 3) Choose enrichment depth

- `lite` or `Easy`: fill only the missing essentials needed for direct execution.
- `standard` or `Normal`: add product intent, expected outcome, acceptance clarity, and targeted constraints.
- `strict`, `Hard`, or `Extreme`: add stronger dependency notes, verification expectations, and explicit open decisions when needed.

## 4) Update the detail file with minimal prescription

- Preserve existing structure when possible.
- Prefer improving these sections before adding new technical content:
  - `## Product Context`
  - `## User Story`
  - `## Expected Outcome`
  - `## Acceptance`
  - `## Constraints`
- Add `## Open Decisions for Execution` entries for unresolved questions.
- Add `## Implementation Notes` only for concrete landing spots or factual context.
- Do not turn the file into a full implementation script unless the task clearly needs a separate plan file.

## 5) Escalate only when justified

- Stay single-agent by default.
- Consider deeper research or a planner handoff only when:
  - the task spans multiple domains
  - prerequisites are numerous or unclear
  - the work is `strict`, `Hard`, or `Extreme`
  - the task would otherwise require broad codebase discovery before safe execution

## 6) Report the result

- Summarize what was enriched.
- List sources consulted.
- Call out open decisions still blocking confident execution.
- Recommend whether the next step is direct execution, planning, or clarification.
