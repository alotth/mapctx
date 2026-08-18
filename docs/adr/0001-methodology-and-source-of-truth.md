# ADR-0001: Methodology and Source of Truth

- Status: Superseded by ADR 0003
- Date: 2026-04-24

> Historical decision. ADR 0003 replaces repository-local Markdown as live
> operational authority while preserving Git for approved intent and decisions.

## Context

MapCtx has grown beyond a single task-board format discussion.

The repository now combines:

- a canonical task contract in `TASKS.md`
- task detail files in `tasks/<ID>.md`
- planning and sync tooling
- documentation work influenced by BMAD, GSD, Superpowers, and low-token execution rules

Without one explicit decision, contributors can easily reintroduce competing state stores, heavy workflow machinery, or subagent defaults that cost more tokens than they save.

## Decision

MapCtx adopts the following methodology baseline:

1. `TASKS.md` and `tasks/<ID>.md` remain the operational source of truth.
2. Global context lives in lightweight documents under `docs/`, primarily:
   - `docs/PROJECT.md`
   - `docs/ROADMAP.md`
   - `docs/methodology.md`
   - `docs/adr/`
3. `docs/REQUIREMENTS.md` is optional and should be added only when the project needs stronger requirement traceability.
4. MapCtx selectively adopts ideas from BMAD, GSD, Superpowers, and Karpathy-style coding discipline, but does not adopt any of those systems wholesale.
5. Single-agent execution is the default.
6. Planner, implementer, reviewer, or evaluator subagents are reserved for `strict`, high-risk, or otherwise complex work.
7. Isolated evaluator flow should not be the default for all `standard` work.

## Consequences

### Positive

- project state stays centralized and easier to sync
- docs become easier to scan because each artifact has a clear role
- contributors get a consistent escalation path from simple work to complex workflows
- subagent cost stays proportional to task complexity

### Tradeoffs

- some future workflow tasks need to be scoped down from heavier original ideas
- contributors must resist the temptation to create extra planning state outside the canonical task model
- methodology docs now carry more responsibility and must stay current

## Rejected Alternatives

### Full GSD-style planning state for every repo

Rejected because it would duplicate execution state that already lives in `TASKS.md` and `tasks/<ID>.md`.

### Full BMAD-style phase and artifact stack by default

Rejected because MapCtx is a task/context substrate first, not a full methodology suite for every project.

### Default multi-agent execution for standard work

Rejected because current models can handle most small and medium tasks efficiently without the extra prompt and review overhead.

## Follow-On Implications

- `docs/methodology.md` should document adopted and rejected patterns in operator-friendly language.
- root docs should link to the methodology and global project docs.
- future workflow skills should compose existing MapCtx primitives instead of introducing a second source of truth.
