# Tasks - markdown-kanban-roadmap-v2

## Components

- PARSER: markdown parser and serialization
- WEBVIEW: kanban webview rendering and interaction
- ROADMAP: roadmap timeline and progress
- CI: validation, checks, workflow automation
- DOCS: rules, examples, and migration docs

## Tasks

### [T-001] Support status-based single-list parser mode

  - id: T-001
  - status: doing
  - priority: high
  - workload: Hard
  - touch: [PARSER, ROADMAP]
  - dependsOn: []
  - start: 2026-02-12
  - due: 2026-02-18
  - completed: null
  - externalId: null
  - updated: 2026-02-12
  - detail: ./tasks/T-001.md

### [T-002] Migrate legacy section boards to single-list format

  - id: T-002
  - status: backlog
  - priority: high
  - workload: Normal
  - touch: [PARSER, DOCS]
  - dependsOn: [T-001]
  - start: 2026-02-19
  - due: 2026-02-22
  - completed: null
  - externalId: null
  - updated: 2026-02-12
  - detail: ./tasks/T-002.md

### [T-003] Build conflict and parallelization analyzer

  - id: T-003
  - status: review
  - priority: medium
  - workload: Hard
  - touch: [PARSER, CI]
  - dependsOn: [T-001]
  - start: 2026-02-10
  - due: 2026-02-16
  - completed: null
  - externalId: github:issue:203
  - updated: 2026-02-12
  - detail: ./tasks/T-003.md

### [T-004] Render kanban columns from task status values

  - id: T-004
  - status: backlog
  - priority: high
  - workload: Hard
  - touch: [WEBVIEW]
  - dependsOn: [T-001]
  - start: 2026-02-20
  - due: 2026-02-25
  - completed: null
  - externalId: null
  - updated: 2026-02-12
  - detail: ./tasks/T-004.md

### [T-005] Add schema guardrails for tasks metadata

  - id: T-005
  - status: done
  - priority: medium
  - workload: Normal
  - touch: [CI, DOCS]
  - dependsOn: []
  - start: 2026-02-08
  - due: 2026-02-11
  - completed: 2026-02-11
  - externalId: github:issue:205
  - updated: 2026-02-11
  - detail: ./tasks/T-005.md

## Notes

- `touch` drives fast conflict checks with minimal token use.
- Detail files hold rich context and volatile metadata.
- Keep updates in `TASKS.md` small and deterministic.
- Use `externalId` as provider-agnostic mapping key (`<provider>:<entity>:<id>`).
