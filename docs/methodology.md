# MapCtx Methodology

> **Authority update (ADR 0003/0004, post-cutover):** the external project
> store is the live operational authority (`plansAuthority: store`); `TASKS.md`
> and the structured field blocks of `tasks/<ID>.md` are generated, read-only
> snapshots. This document still describes the rigor and workflow model, but
> the writing surfaces below now go through the `mapctx` CLI. Host workflow
> rules remain authoritative.

MapCtx is contract-first, task-first, and low-token by design.

The system centers on a deterministic local task model and uses lightweight docs, skills, and optional subagents to help operators plan and execute work without duplicating project state.

## Core Position

- The external project store is the operational source of truth; `TASKS.md` and the structured blocks of `tasks/<ID>.md` are generated snapshots. Edits go through the `mapctx` CLI, never direct file writes.
- Global docs in `docs/` explain project intent, sequencing, and durable decisions, but do not replace task state.
- Skills and tooling drive behavior; rule files stay short and route the agent into the right workflow.
- Single-agent execution is the default. Subagents are reserved for complex, high-risk, or cross-domain work.

## Canonical Artifacts

| Artifact | Purpose | Canonical for state? |
| --- | --- | --- |
| project store (`~/.mapctx/projects/<id>/`) | backlog, status, dependencies, workload, `specMode`, claims, events, actuals | Yes |
| `TASKS.md` | generated board snapshot (read-only after cutover) | No |
| `tasks/<ID>.md` | structured block generated (read-only); `description:` prose, decisions, implementation notes stay Git-authored | Prose: Yes; block: No |
| `docs/PROJECT.md` | living project context, value, constraints, major decisions | No |
| `docs/ROADMAP.md` | epic/theme order and current delivery path | No |
| `docs/adr/<number>-*.md` | durable repo-level decisions | No |
| `docs/REQUIREMENTS.md` | optional formal requirement traceability for larger efforts | No |
| `tasks/<ID>.plan.md` | optional execution plan for heavier work | No |
| `.mapctx/threads/<ID>/summary.md` | portable conversation resume context for a task | No |
| `.mapctx/threads/<ID>/thread.md` | append-only human-readable task conversation history | No |

Rule of thumb:

- If the information changes task status or execution readiness, record it through the `mapctx` CLI; never hand-edit the generated board files.
- If the information explains project-wide direction or durable architecture choices, keep it in `docs/`.
- If the information helps a runtime resume a conversation or run, keep it in `.mapctx/threads/<ID>/` and link it from the task detail file.

## Rigor Model

MapCtx uses `workload` and `specMode` to scale process up only when needed.

| Task shape | Default execution mode | Extra artifacts |
| --- | --- | --- |
| `specMode: lite` or small `Easy` work | single agent | none beyond task detail |
| `specMode: standard` or typical `Normal` work | single agent by default; review when risk justifies it | optional plan or doc update |
| `specMode: strict`, `Hard`, or `Extreme` work | planner/reviewer/subagent flow is allowed and often preferred | `tasks/<ID>.plan.md`, ADR if decision is durable |

Additional routing cues:

- Cross-domain changes, dependency-heavy work, migrations, and behavior with irreversible impact should bias upward.
- Bugs and small fixes should stay lightweight unless they expose systemic risk.
- Isolated evaluator/reviewer passes should be the default only for `strict` or otherwise high-risk work, not for all `standard` tasks.

## Default Workflow

1. Capture or refine work with `mapctx task create` / `mapctx task update`; board files regenerate.
2. Keep task details product-first: user context, expected outcome, acceptance, then technical notes.
3. Run `mapctx validate` before major execution or sync.
4. Run `mapctx plan` when dependency order or waves matter.
5. Execute directly by default.
6. Escalate to subagents only when the task is complex enough to justify the extra context and review cost.
7. Sync with GitHub only through `mapcs` or the sync skill.

## Selective Adoptions

### BMAD ideas we keep

- Dense, traceable requirement language.
- Product intent before implementation detail.
- Durable decision records when architecture needs to stay stable.

### GSD ideas we keep

- Lightweight living project context in `docs/PROJECT.md`.
- A separate roadmap artifact for sequencing larger efforts.
- Thin orchestration and next-step guidance instead of one giant prompt.

### Superpowers ideas we keep

- Optional plan-then-execute flow for multi-step work.
- Explicit planner/implementer/reviewer handoffs for heavier tasks.
- Wave-aware execution only when dependencies allow independent batches.

### Karpathy-style behavior we keep

- State assumptions when they materially affect the result.
- Prefer the simplest solution that fully solves the request.
- Make surgical changes and avoid drive-by refactors.
- Define verifiable success for non-trivial work.

## Intentional Non-Adoptions

- No duplicate operational state store like `.planning/STATE.md`.
- No mandatory PRD, requirements doc, or phase doc for every repository.
- No roleplay-heavy agent system as the default operating mode.
- No always-on evaluator/subagent stage for `lite` or ordinary `standard` work.
- No large prompt boilerplate when a short rule, task detail, or skill is enough.
- No speculative abstractions just because AI can generate them cheaply.

## Subagent Policy

Subagents are a tool, not the baseline.

Use them when one or more of these are true:

- the task is `strict`, `Hard`, or `Extreme`
- the work spans multiple domains or dependency waves
- an execution plan is needed before code changes are safe
- an independent review pass materially increases confidence

Keep the default stack small:

- `planner` for decomposition and execution order
- `implementer` for isolated execution
- `reviewer` for independent acceptance/quality checks

Avoid multiplying roles until the simpler trio proves insufficient.

## Workflow Layer

Workflow-oriented additions should stay narrow and compose the existing contract instead of replacing it.

Current lightweight helpers:

- `mapctx-enrich-task`: gather missing context for a task detail file
- `mapctx-correct-course`: record and apply mid-stream scope adjustments safely
- portable thread substrate: preserve review/replanning context across runtimes without making it task state

Next likely additions:

- `mapctx-sprint-status`: summarize current position and suggest next runnable work
- `mapctx-next`: recommend the next best operator action
- wave-aware execution on top of planner output

These workflows should read through `mapctx task context` and global docs, then write back through CLI commands with minimal diffs.

## Document Placement

- Use `docs/PROJECT.md` for repo-wide context.
- Use `docs/ROADMAP.md` for sequencing and themes.
- Use `docs/adr/` for stable architectural or methodological decisions.
- Add `docs/REQUIREMENTS.md` only when scope or compliance needs stronger traceability.
- Keep `tasks/<ID>.plan.md` temporary and task-scoped.

## Practical Tests

This methodology is working when:

- task status lives in one place
- task detail files stay readable and product-first
- docs explain the project without becoming a second backlog
- most small and medium tasks finish without spawning subagents
- subagents, when used, make hard tasks clearer rather than heavier
