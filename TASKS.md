# Tasks - markdown-kanban-roadmap

## Components













- PARSER: markdown parsing and serialization
- WEBVIEW: kanban and roadmap UI rendering
- EXTENSION: VS Code command and panel wiring
- SYNC: external sync engine and conflict policy
- CI: checks, tests, and publish pipeline
- DOCS: guides, examples, and migration docs













## Tasks

### [T-001] Define V2 task schema and sync mapping contract

  - id: T-001
  - status: done
  - priority: high
  - workload: Normal
  - tags: []
  - touch: [SYNC, DOCS]
  - dependsOn: []
  - start: 2026-02-12
  - due: 2026-02-13
  - completed: 2026-02-13
  - externalId: github:issue:2
  - updated: 2026-02-19
  - detail: ./tasks/T-001.md

### [T-002] Build sync engine package CLI and core commands

  - id: T-002
  - status: review
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [SYNC]
  - dependsOn: [T-001]
  - start: 2026-02-13
  - due: 2026-02-15
  - completed: null
  - externalId: github:issue:3
  - updated: 2026-02-19
  - detail: ./tasks/T-002.md

### [T-003] Add Workspace V2 panel with Kanban and Roadmap tabs

  - id: T-003
  - status: review
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [WEBVIEW, EXTENSION]
  - dependsOn: [T-001]
  - start: 2026-02-13
  - due: 2026-02-15
  - completed: null
  - externalId: github:issue:4
  - updated: 2026-02-19
  - detail: ./tasks/T-003.md

### [T-004] Implement native V2 parser mode status-first

  - id: T-004
  - status: backlog
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [PARSER, WEBVIEW]
  - dependsOn: [T-001]
  - start: 2026-02-15
  - due: 2026-02-18
  - completed: null
  - externalId: github:issue:5
  - updated: 2026-02-19
  - detail: ./tasks/T-004.md

### [T-005] Integrate sync commands into VS Code extension

  - id: T-005
  - status: backlog
  - priority: high
  - workload: Normal
  - tags: []
  - touch: [EXTENSION, SYNC]
  - dependsOn: [T-002]
  - start: 2026-02-15
  - due: 2026-02-18
  - completed: null
  - externalId: github:issue:6
  - updated: 2026-02-19
  - detail: ./tasks/T-005.md

### [T-006] Build migration command from legacy sections to V2

  - id: T-006
  - status: backlog
  - priority: medium
  - workload: Normal
  - tags: []
  - touch: [PARSER, DOCS]
  - dependsOn: [T-004]
  - start: 2026-02-16
  - due: 2026-02-19
  - completed: null
  - externalId: github:issue:7
  - updated: 2026-02-19
  - detail: ./tasks/T-006.md

### [T-007] Remove debug instrumentation and stabilize tests

  - id: T-007
  - status: backlog
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [PARSER, WEBVIEW, CI]
  - dependsOn: [T-003, T-004]
  - start: 2026-02-17
  - due: 2026-02-21
  - completed: null
  - externalId: github:issue:8
  - updated: 2026-02-19
  - detail: ./tasks/T-007.md

### [T-008] Publish sync engine package and release V2 rollout guide

  - id: T-008
  - status: backlog
  - priority: medium
  - workload: Normal
  - tags: []
  - touch: [SYNC, CI, DOCS]
  - dependsOn: [T-002, T-005, T-007]
  - start: 2026-02-20
  - due: 2026-02-24
  - completed: null
  - externalId: github:issue:9
  - updated: 2026-02-19
  - detail: ./tasks/T-008.md

### [T-009] Add agent execution logs and provider comment publishing flow

  - id: T-009
  - status: backlog
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [SYNC, EXTENSION]
  - dependsOn: [T-002]
  - start: 2026-02-25
  - due: 2026-03-01
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-009.md

### [T-010] Create npm workspace monorepo foundation under packages/

  - id: T-010
  - status: done
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [CI, DOCS]
  - dependsOn: [T-009]
  - start: 2026-02-25
  - due: 2026-02-27
  - completed: 2026-02-25
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-010.md

### [T-011] Import kanban-sync-engine package into monorepo

  - id: T-011
  - status: done
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [SYNC, CI]
  - dependsOn: [T-010]
  - start: 2026-02-26
  - due: 2026-02-28
  - completed: 2026-02-25
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-011.md

### [T-012] Create shared core package for parser and render helpers

  - id: T-012
  - status: doing
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [PARSER, WEBVIEW, SYNC]
  - dependsOn: [T-011]
  - start: 2026-02-27
  - due: 2026-03-02
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-012.md

### [T-013] Migrate VS Code extension to consume core package

  - id: T-013
  - status: review
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [EXTENSION, PARSER]
  - dependsOn: [T-012]
  - start: 2026-02-28
  - due: 2026-03-03
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-013.md

### [T-014] Migrate OpenCode plugin to consume core package

  - id: T-014
  - status: review
  - priority: high
  - workload: Hard
  - tags: []
  - touch: [WEBVIEW, PARSER]
  - dependsOn: [T-012]
  - start: 2026-02-28
  - due: 2026-03-03
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-014.md

### [T-015] Add tag-based release workflows for extension and packages

  - id: T-015
  - status: backlog
  - priority: high
  - workload: Normal
  - tags: []
  - touch: [CI, SYNC, EXTENSION]
  - dependsOn: [T-011]
  - start: 2026-03-01
  - due: 2026-03-03
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-015.md

### [T-016] Document release process for extension engine and plugin

  - id: T-016
  - status: backlog
  - priority: medium
  - workload: Normal
  - tags: []
  - touch: [DOCS, CI]
  - dependsOn: [T-015]
  - start: 2026-03-02
  - due: 2026-03-04
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-016.md

### [T-017] Run pilot release flow with tag strategy and smoke checks

  - id: T-017
  - status: backlog
  - priority: medium
  - workload: Normal
  - tags: []
  - touch: [CI, DOCS, EXTENSION, SYNC]
  - dependsOn: [T-015, T-016]
  - start: 2026-03-03
  - due: 2026-03-05
  - completed: null
  - externalId: null
  - updated: 2026-02-25
  - detail: ./tasks/T-017.md

### [T-018] Add Obsidian local export in kanban-sync-engine and document bidirectional sync as future work

  - id: T-018
  - status: backlog
  - priority: medium
  - workload: Normal
  - tags: [obsidian]
  - touch: [SYNC, DOCS]
  - dependsOn: [T-002]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-02
  - detail: ./tasks/T-018.md

### [T-019] Add session-start hooks for OpenCode and Claude Code/Cursor auto-sync

  - id: T-019
  - status: backlog
  - priority: high
  - workload: Normal
  - tags: [hooks, automation]
  - touch: [SYNC, DOCS]
  - dependsOn: [T-002]
  - start: 2026-03-03
  - due: 2026-03-06
  - completed: null
  - externalId: null
  - updated: 2026-03-03
  - detail: ./tasks/T-019.md

### [T-020] Add iteration and assignees support with low-risk compatibility in sync engine and UIs

  - id: T-020
  - status: backlog
  - priority: high
  - workload: Hard
  - tags: [github-projects, phase-2]
  - touch: [SYNC, WEBVIEW, EXTENSION, DOCS]
  - dependsOn: [T-002, T-012]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-04
  - detail: ./tasks/T-020.md

### [T-021] Replace metadata fallback with GitHub Projects GraphQL sub-issue progress mapping

  - id: T-021
  - status: backlog
  - priority: high
  - workload: Hard
  - tags: [github-projects, epic-stack]
  - touch: [SYNC, DOCS]
  - dependsOn: [T-020]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-04
  - detail: ./tasks/T-021.md

### [T-022] Add migration and compatibility coverage for iteration assignees and GraphQL progress

  - id: T-022
  - status: backlog
  - priority: medium
  - workload: Normal
  - tags: [migration, compatibility]
  - touch: [SYNC, PARSER, CI, DOCS]
  - dependsOn: [T-020, T-021]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-04
  - detail: ./tasks/T-022.md

## Notes













- Done: V2 schema contract and initial Workspace V2 command/panel implementation.
- In review: sync engine MVP and Workspace V2 behavior.
- Next major gap: native status-first parser mode and migration command.
