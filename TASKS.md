# Tasks - mapctx-monorepo

## Work Domains

- SYNC: sync engine reliability and conflict handling
- WEBVIEW: OpenCode task UX and task detail flows
- EXTENSION: VS Code integration touchpoints
- DOCS: guides, migration notes, runbooks
- SKILLS: local skills and references for task and sync workflows
- HOOKS: session-start automation for OpenCode and other clients

## Tasks

### [T-001] Harden session-start sync hooks and OpenCode plugin integration

  - id: T-001
  - status: doing
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [hooks, automation, plugin]
  - domains: [SYNC, HOOKS, WEBVIEW, DOCS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-10
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-001.md

### [T-002] Add task log timeline sync using GitHub issue comments

  - id: T-002
  - status: backlog
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [sync-reliability, github]
  - domains: [SYNC, DOCS]
  - dependsOn: [T-001]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-002.md

### [T-003] Add iteration and assignees with backward compatibility

  - id: T-003
  - status: backlog
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [github-projects, phase-2]
  - domains: [SYNC, WEBVIEW, EXTENSION, DOCS, SKILLS]
  - dependsOn: [T-001]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-003.md

### [T-004] Map sub-issue progress from GitHub Projects GraphQL

  - id: T-004
  - status: backlog
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [github-projects, graphql]
  - domains: [SYNC, DOCS]
  - dependsOn: [T-003]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-004.md

### [T-005] Add migration docs and regression coverage for new fields

  - id: T-005
  - status: backlog
  - type: chore
  - parent: null
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [migration, compatibility]
  - domains: [SYNC, DOCS, SKILLS]
  - dependsOn: [T-003, T-004]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-005.md

### [T-006] Epic: Obsidian vault sync (future)

  - id: T-006
  - status: backlog
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [obsidian, epic]
  - domains: [SYNC, DOCS]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-006.md

### [T-007] Epic: Clean and organize new repository

  - id: T-007
  - status: doing
  - type: epic
  - parent: null
  - subIssueProgress: 0/4
  - priority: high
  - workload: Normal
  - tags: [repo-hygiene, documentation, epic]
  - domains: [DOCS, SKILLS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-12
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-007.md
  - iteration: 2026-W10

### [T-008] Align skills and task references to new contract

  - id: T-008
  - status: review
  - type: task
  - parent: T-007
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [skills, contract]
  - domains: [SKILLS, DOCS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-07
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-008.md

### [T-009] Remove legacy task-model artifacts and outdated guidance

  - id: T-009
  - status: review
  - type: chore
  - parent: T-007
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [cleanup, skills]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-008]
  - start: 2026-03-06
  - due: 2026-03-08
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-009.md

### [T-010] Rewrite `rules/CLAUDE.md` to single-list contract

  - id: T-010
  - status: review
  - type: task
  - parent: T-008
  - subIssueProgress: null
  - priority: high
  - workload: Easy
  - tags: [rules, claude]
  - domains: [DOCS, SKILLS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-06
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-010.md

### [T-011] Rewrite `rules/.cursorrules` to single-list contract

  - id: T-011
  - status: review
  - type: task
  - parent: T-008
  - subIssueProgress: null
  - priority: high
  - workload: Easy
  - tags: [rules, cursor]
  - domains: [DOCS, SKILLS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-06
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: ./tasks/T-011.md

## Notes

- Scope is focused on monorepo priorities: reliability, task UX, GitHub Projects, docs, and hooks/plugins.
- Legacy and fork-era tasks were intentionally removed.
