# Tasks - mapctx-monorepo

## Work Domains

- SYNC: sync engine reliability and conflict handling
- WEBVIEW: OpenCode task UX and task detail flows
- EXTENSION: VS Code integration touchpoints
- DOCS: guides, migration notes, runbooks
- SKILLS: local skills and references for task and sync workflows
- HOOKS: session-start automation for OpenCode and other clients
- GITHUB: GitHub API and issue/project integration behavior
- PROJECT: GitHub Projects field and timeline mapping
- CONFIG: configuration model and setup workflow
- CLI: command-line behavior and operator UX
- PARSER: TASKS markdown parsing and serialization
- TEST: automated coverage and regression validation
- PROTOCOL: harness-neutral contracts, schemas, and identity
- STORE: external project state, events, and projections
- PLANNER: dependency, resource-claim, and context planning
- ADAPTER: executor and tracker integration boundaries
- TELEMETRY: run, token, cost, and changed-file actuals
- FORECAST: delivery estimates, confidence, and variance

## Tasks

### [T-001] Harden session-start sync hooks and OpenCode plugin integration

  - id: T-001
  - status: paused
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [hooks, automation, plugin]
  - domains: [SYNC, HOOKS, WEBVIEW, DOCS]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-001.md

### [T-002] Add task log timeline sync using GitHub issue comments

  - id: T-002
  - status: paused
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
  - updated: 2026-05-29
  - detail: ./tasks/T-002.md

### [T-003] Add iteration and assignees with backward compatibility

  - id: T-003
  - status: paused
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
  - updated: 2026-05-29
  - detail: ./tasks/T-003.md

### [T-004] Map sub-issue progress from GitHub Projects GraphQL

  - id: T-004
  - status: paused
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
  - updated: 2026-05-29
  - detail: ./tasks/T-004.md

### [T-005] Add migration docs and regression coverage for new fields

  - id: T-005
  - status: paused
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
  - updated: 2026-05-29
  - detail: ./tasks/T-005.md

### [E-007] Epic: Obsidian vault sync (future)

  - id: E-007
  - status: paused
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
  - updated: 2026-05-29
  - detail: ./tasks/E-007.md

### [E-008] Epic: Clean and organize new repository

  - id: E-008
  - status: done
  - type: epic
  - parent: null
  - subIssueProgress: 2/2
  - priority: high
  - workload: Normal
  - tags: [repo-hygiene, documentation, epic]
  - domains: [DOCS, SKILLS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-12
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-008.md
  - iteration: 2026-W10

### [T-008] Align skills and task references to new contract

  - id: T-008
  - status: done
  - type: task
  - parent: E-008
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [skills, contract]
  - domains: [SKILLS, DOCS]
  - dependsOn: []
  - start: 2026-03-06
  - due: 2026-03-07
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-008.md

### [T-009] Remove legacy task-model artifacts and outdated guidance

  - id: T-009
  - status: done
  - type: chore
  - parent: E-008
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [cleanup, skills]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-008]
  - start: 2026-03-06
  - due: 2026-03-08
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-009.md

### [T-010] Rewrite `rules/CLAUDE.md` to single-list contract

  - id: T-010
  - status: done
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
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-010.md

### [T-011] Rewrite `rules/.cursorrules` to single-list contract

  - id: T-011
  - status: done
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
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-011.md

### [E-001] Spec-Driven v3 contract and status model foundation

  - id: E-001
  - status: ready-for-do
  - type: epic
  - parent: null
  - subIssueProgress: 4/6
  - priority: high
  - workload: Hard
  - tags: [sdd, contract, status-model]
  - domains: [SKILLS, DOCS, SYNC]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-001.md

### [T-012] Approve naming and lifecycle defaults (`specMode`, `ready-for-do`)

  - id: T-012
  - status: done
  - type: task
  - parent: E-001
  - subIssueProgress: null
  - priority: high
  - workload: Easy
  - tags: [decision, naming, workflow]
  - domains: [SKILLS, DOCS]
  - dependsOn: []
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-012.md

### [T-013] Extend canonical task contract with `specMode`

  - id: T-013
  - status: done
  - type: feature
  - parent: E-001
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [contract, task-model, specmode]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-012]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-013.md

### [T-014] Update default status policy to include `ready-for-do`

  - id: T-014
  - status: done
  - type: feature
  - parent: E-001
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [status, workflow, ready-for-do]
  - domains: [SKILLS, DOCS, SYNC]
  - dependsOn: [T-012]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-014.md

### [T-015] Align agent rule packs with Spec-Driven v3 policy

  - id: T-015
  - status: done
  - type: task
  - parent: E-001
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [rules, agents, governance]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-012]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-015.md

### [T-016] Publish migration guide for status and naming changes

  - id: T-016
  - status: backlog
  - type: chore
  - parent: E-001
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [migration, docs, rollout]
  - domains: [DOCS, SKILLS]
  - dependsOn: [T-013, T-014, T-015]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-016.md

### [T-017] Define epic-ID migration policy (`T-xxx` -> `E-xxx`)

  - id: T-017
  - status: backlog
  - type: task
  - parent: E-001
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [ids, epic, compatibility]
  - domains: [SYNC, DOCS, SKILLS]
  - dependsOn: [T-013]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-017.md

### [E-002] Product-first task specification templates

  - id: E-002
  - status: review
  - type: epic
  - parent: null
  - subIssueProgress: 3/4
  - priority: high
  - workload: Hard
  - tags: [product, user-story, planning]
  - domains: [SKILLS, DOCS]
  - dependsOn: [E-001]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-002.md

### [T-018] Define product-first detail template for `tasks/T-XXX.md`

  - id: T-018
  - status: done
  - type: feature
  - parent: E-002
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [template, user-story, task-detail]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-013]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-018.md

### [T-019] Add risk-based auto-classification rules for `specMode`

  - id: T-019
  - status: done
  - type: feature
  - parent: E-002
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [specmode, scoring, policy]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-013]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-019.md

### [T-020] Update `mapctx-tasks` guidance for product-first planning

  - id: T-020
  - status: done
  - type: task
  - parent: E-002
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [skill, planning, product-first]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-018, T-019]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-020.md

### [T-021] Add product-oriented example detail files and runbook

  - id: T-021
  - status: backlog
  - type: chore
  - parent: E-002
  - subIssueProgress: null
  - priority: medium
  - workload: Easy
  - tags: [examples, docs, onboarding]
  - domains: [DOCS, SKILLS]
  - dependsOn: [T-018]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-021.md

### [E-003] Isolated generator/evaluator execution model

  - id: E-003
  - status: paused
  - type: epic
  - parent: null
  - subIssueProgress: 0/5
  - priority: high
  - workload: Hard
  - tags: [evaluation, quality-gate, subagents]
  - domains: [SKILLS, SYNC]
  - dependsOn: [E-001, E-002]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-003.md

### [T-022] Define evaluator handoff contract and evidence bundle

  - id: T-022
  - status: paused
  - type: task
  - parent: E-003
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [handoff, evaluator, contract]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-019]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-022.md

### [T-023] Implement isolated evaluator flow in task execution skill

  - id: T-023
  - status: paused
  - type: feature
  - parent: E-003
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [subagent, evaluator, execution]
  - domains: [SKILLS, SYNC]
  - dependsOn: [T-022]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-023.md

### [T-024] Add optional parallel evaluator mode with `auto` fallback

  - id: T-024
  - status: paused
  - type: feature
  - parent: E-003
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [parallel, capability-detect, evaluator]
  - domains: [SKILLS, SYNC]
  - dependsOn: [T-023]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-024.md

### [T-025] Standardize evaluation verdict model and status transitions

  - id: T-025
  - status: paused
  - type: task
  - parent: E-003
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [verdict, transitions, quality]
  - domains: [SKILLS, DOCS]
  - dependsOn: [T-023]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-025.md

### [T-026] Add regression coverage for isolated evaluation behavior

  - id: T-026
  - status: paused
  - type: task
  - parent: E-003
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [tests, evaluator, regression]
  - domains: [SYNC, SKILLS]
  - dependsOn: [T-023, T-024, T-025]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-026.md

### [E-004] Validation and execution-order tooling

  - id: E-004
  - status: review
  - type: epic
  - parent: null
  - subIssueProgress: 4/5
  - priority: high
  - workload: Hard
  - tags: [tooling, validator, planning]
  - domains: [SYNC, EXTENSION, WEBVIEW, DOCS]
  - dependsOn: [E-001]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-004.md

### [T-027] Implement `mapctx validate` command MVP

  - id: T-027
  - status: done
  - type: feature
  - parent: E-004
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [cli, validation, contract]
  - domains: [SYNC, DOCS]
  - dependsOn: [T-013, T-014]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-027.md

### [T-028] Add full contract checks to validator

  - id: T-028
  - status: done
  - type: task
  - parent: E-004
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [schema, ids, dependencies]
  - domains: [SYNC, DOCS]
  - dependsOn: [T-027]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-028.md

### [T-029] Implement `mapctx plan` DAG and wave planner

  - id: T-029
  - status: done
  - type: feature
  - parent: E-004
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [dag, waves, execution-order]
  - domains: [SYNC, WEBVIEW, EXTENSION]
  - dependsOn: [T-027]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-029.md

### [T-030] Add Mermaid and CLI outputs for execution tree

  - id: T-030
  - status: done
  - type: task
  - parent: E-004
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [mermaid, visualization, docs]
  - domains: [WEBVIEW, DOCS, EXTENSION]
  - dependsOn: [T-029]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-030.md

### [T-031] Integrate validation and planning checks in CI

  - id: T-031
  - status: backlog
  - type: chore
  - parent: E-004
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [ci, quality-gates, automation]
  - domains: [SYNC, DOCS]
  - dependsOn: [T-028, T-030]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-031.md

### [E-005] Methodology documentation (SDD + BMAD + GSD)

  - id: E-005
  - status: review
  - type: epic
  - parent: null
  - subIssueProgress: 3/4
  - priority: high
  - workload: Normal
  - tags: [documentation, methodology, onboarding]
  - domains: [DOCS, SKILLS]
  - dependsOn: [E-001]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-005.md

### [T-032] Create `docs/methodology.md` with SDD/BMAD/GSD strategy

  - id: T-032
  - status: done
  - type: task
  - parent: E-005
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [docs, methodology, strategy]
  - domains: [DOCS, SKILLS]
  - dependsOn: [T-012]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-032.md

### [T-033] Align root docs (`README`, `skills`, `contributing`) with methodology

  - id: T-033
  - status: done
  - type: chore
  - parent: E-005
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [readme, onboarding, docs]
  - domains: [DOCS, SKILLS]
  - dependsOn: [T-032]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-033.md

### [T-034] Migrate docs site to single-list model and new status terms

  - id: T-034
  - status: backlog
  - type: task
  - parent: E-005
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [docs-site, migration, consistency]
  - domains: [DOCS, WEBVIEW]
  - dependsOn: [T-032, T-033]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-034.md

### [T-035] Document adopted vs rejected ideas (including implicit naming)

  - id: T-035
  - status: done
  - type: task
  - parent: E-005
  - subIssueProgress: null
  - priority: medium
  - workload: Easy
  - tags: [adr, scope, conventions]
  - domains: [DOCS, SKILLS]
  - dependsOn: [T-032]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-035.md

### [E-006] Workflow layer inspired by GSD/BMAD

  - id: E-006
  - status: paused
  - type: epic
  - parent: null
  - subIssueProgress: 2/5
  - priority: medium
  - workload: Hard
  - tags: [workflow, gsd, bmad]
  - domains: [SKILLS, SYNC, WEBVIEW]
  - dependsOn: [E-001, E-002, E-003, E-004]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/E-006.md

### [T-036] Create `mapctx-enrich-task` skill for context enrichment

  - id: T-036
  - status: done
  - type: feature
  - parent: E-006
  - subIssueProgress: null
  - priority: medium
  - workload: Hard
  - tags: [skill, enrichment, planning]
  - domains: [SKILLS, DOCS, SYNC]
  - dependsOn: [T-020]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-036.md

### [T-037] Create `mapctx-sprint-status` workflow and recommendations

  - id: T-037
  - status: paused
  - type: feature
  - parent: E-006
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [status, dashboard, recommendations]
  - domains: [SKILLS, WEBVIEW, DOCS]
  - dependsOn: [T-029]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-037.md

### [T-038] Implement `mapctx-next` next-best-action flow

  - id: T-038
  - status: paused
  - type: feature
  - parent: E-006
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [next, orchestration, workflow]
  - domains: [SKILLS, SYNC, WEBVIEW]
  - dependsOn: [T-023, T-037]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-038.md

### [T-039] Implement `mapctx-correct-course` workflow

  - id: T-039
  - status: done
  - type: feature
  - parent: E-006
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [scope-change, correction, governance]
  - domains: [SKILLS, DOCS, SYNC]
  - dependsOn: [T-020, T-023]
  - start: null
  - due: null
  - completed: 2026-05-29
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-039.md

### [T-040] Add wave-based task execution support to operational loop

  - id: T-040
  - status: paused
  - type: feature
  - parent: E-006
  - subIssueProgress: null
  - priority: medium
  - workload: Hard
  - tags: [waves, execution, dependency-order]
  - domains: [SYNC, SKILLS, WEBVIEW]
  - dependsOn: [T-023, T-029]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-040.md

### [T-041] Sync Project date fields from TASKS.md on push

  - id: T-041
  - status: done
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [sync-engine, github-projects, dates]
  - domains: [SYNC, GITHUB, PROJECT]
  - dependsOn: []
  - start: 2026-02-24
  - due: 2026-02-24
  - completed: 2026-02-24
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-041.md

### [T-042] Document roadmap date-field requirements in config guides

  - id: T-042
  - status: done
  - type: chore
  - parent: null
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [docs, config, roadmap]
  - domains: [DOCS, CONFIG]
  - dependsOn: [T-041]
  - start: 2026-02-24
  - due: 2026-02-24
  - completed: 2026-02-24
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-042.md

### [T-043] Configure real Project date field IDs and run first sync validation

  - id: T-043
  - status: paused
  - type: task
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [config, validation, roadmap]
  - domains: [CONFIG, PROJECT, CLI]
  - dependsOn: [T-041, T-042]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-043.md

### [T-044] Pull Project date fields back into local task model

  - id: T-044
  - status: done
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [sync-engine, github-projects, parser]
  - domains: [SYNC, GITHUB, PARSER]
  - dependsOn: [T-043]
  - start: null
  - due: null
  - completed: 2026-02-24
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-044.md

### [T-045] Add optional Project field sync for priority and workload

  - id: T-045
  - status: paused
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: medium
  - workload: Hard
  - tags: [github-projects, mapping, metadata]
  - domains: [SYNC, GITHUB, PROJECT]
  - dependsOn: [T-044]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-045.md

### [T-046] Add automated tests for Project field date operations

  - id: T-046
  - status: paused
  - type: task
  - parent: null
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [tests, github-projects, dates]
  - domains: [TEST, SYNC]
  - dependsOn: [T-044]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-046.md

### [T-047] Add full support for custom status workflows and configurable completion states

  - id: T-047
  - status: done
  - type: feature
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [statuses, config, workflow]
  - domains: [SYNC, CONFIG, TEST, DOCS]
  - dependsOn: [T-044]
  - start: 2026-02-24
  - due: 2026-02-24
  - completed: 2026-02-24
  - externalId: null
  - updated: 2026-05-29
  - detail: ./tasks/T-047.md

### [E-009] MapCtx vNext protocol, store, and planning core

  - id: E-009
  - status: backlog
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, architecture, planning]
  - domains: [PROTOCOL, STORE, PLANNER]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/E-009.md

### [T-048] Define vNext protocol and operational domain model

  - id: T-048
  - status: done
  - type: task
  - parent: E-009
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, protocol, schema, adr, cost, forecast]
  - domains: [PROTOCOL, STORE, DOCS]
  - dependsOn: []
  - start: null
  - due: null
  - completed: 2026-08-16
  - externalId: null
  - updated: 2026-08-16
  - detail: ./tasks/T-048.md

### [T-049] Implement external project store and compatibility migration

  - id: T-049
  - status: done
  - type: feature
  - parent: E-009
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, sqlite, events, migration]
  - domains: [STORE, PROTOCOL, PARSER, TEST]
  - dependsOn: [T-048]
  - start: null
  - due: null
  - completed: 2026-08-16
  - externalId: null
  - updated: 2026-08-16
  - detail: ./tasks/T-049.md

### [T-050] Add bounded context queries and semantic validation

  - id: T-050
  - status: done
  - type: feature
  - parent: E-009
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, context-budget, validation]
  - domains: [CLI, STORE, TEST]
  - dependsOn: [T-058, T-060]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-050.md

### [T-051] Schedule waves from dependencies and resource claims

  - id: T-051
  - status: done
  - type: feature
  - parent: E-009
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, dag, parallelism, resource-claims]
  - domains: [PLANNER, TEST]
  - dependsOn: [T-058]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-051.md

### [T-061] Detect claim violations from completed-wave receipts

  - id: T-061
  - status: done
  - type: feature
  - parent: E-009
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [vnext, resource-claims, receipts, telemetry]
  - domains: [PLANNER, STORE, TELEMETRY, TEST]
  - dependsOn: [T-051, T-060]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-061.md

### [T-062] Resolve the board by walking up from cwd, matching store config resolution

  - id: T-062
  - status: backlog
  - type: bug
  - parent: E-009
  - subIssueProgress: null
  - priority: medium
  - workload: Easy
  - tags: [vnext, cli, resolution, worktree]
  - domains: [CLI, SYNC, TEST]
  - dependsOn: [T-050]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-062.md

### [T-063] Fix inverted depends-on edges and silent task drops in the planner

  - id: T-063
  - status: done
  - type: bug
  - parent: E-009
  - subIssueProgress: null
  - priority: high
  - workload: Easy
  - tags: [vnext, planner, correctness, dogfood]
  - domains: [PLANNER, CLI, TEST]
  - dependsOn: [T-050, T-051]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-063.md

### [T-064] Persist RunEvent timestamps so activeTime is measured, not substituted

  - id: T-064
  - status: backlog
  - type: feature
  - parent: E-011
  - subIssueProgress: null
  - priority: medium
  - workload: Normal
  - tags: [vnext, telemetry, forecast, coverage]
  - domains: [STORE, TELEMETRY, FORECAST, TEST]
  - dependsOn: [T-054, T-060]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-064.md

### [T-065] Make the duration prior workload-aware and unit-honest

  - id: T-065
  - status: backlog
  - type: feature
  - parent: E-011
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [vnext, forecast, calibration, estimation]
  - domains: [FORECAST, WEBVIEW, TELEMETRY, TEST]
  - dependsOn: [T-054, T-064]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-065.md

### [E-010] Harness-neutral execution with Traycer first

  - id: E-010
  - status: backlog
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, traycer, dispatch, execution]
  - domains: [ADAPTER, PROTOCOL, TELEMETRY]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/E-010.md

### [T-052] Implement DispatchEnvelope, RunEvent, and RunReceipt contracts

  - id: T-052
  - status: done
  - type: feature
  - parent: E-010
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [vnext, dispatch, receipts, idempotency]
  - domains: [PROTOCOL, ADAPTER, TELEMETRY, TEST]
  - dependsOn: [T-048]
  - start: null
  - due: null
  - completed: 2026-08-16
  - externalId: null
  - updated: 2026-08-16
  - detail: ./tasks/T-052.md

### [T-053] Build Traycer adapter skill and task-ticket linking

  - id: T-053
  - status: done
  - type: feature
  - parent: E-010
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, traycer, skill, artifacts]
  - domains: [ADAPTER, SKILLS, PROTOCOL, CLI]
  - dependsOn: [T-051, T-052]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-053.md

### [E-011] Delivery forecast and planned-versus-actual UI

  - id: E-011
  - status: backlog
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, forecast, cost, gantt]
  - domains: [FORECAST, TELEMETRY, WEBVIEW]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/E-011.md

### [T-054] Ingest usage events and calculate baseline P50/P90 forecasts

  - id: T-054
  - status: done
  - type: feature
  - parent: E-011
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, tokens, cost, estimates]
  - domains: [TELEMETRY, FORECAST, STORE, TEST]
  - dependsOn: [T-058, T-060]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-054.md

### [T-055] Render Kanban and Gantt planned, forecast, and actual layers

  - id: T-055
  - status: backlog
  - type: feature
  - parent: E-011
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, ui, gantt, variance]
  - domains: [WEBVIEW, EXTENSION, FORECAST, CLI]
  - dependsOn: [T-050, T-051, T-054]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/T-055.md

### [T-056] Prove first MapCtx-to-Traycer vertical slice

  - id: T-056
  - status: backlog
  - type: task
  - parent: E-010
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, dogfood, traycer, vertical-slice]
  - domains: [ADAPTER, PLANNER, TELEMETRY, FORECAST, WEBVIEW, TEST]
  - dependsOn: [T-050, T-051, T-053, T-054, T-055]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/T-056.md

### [E-012] vNext migration, naming, and adoption gates

  - id: E-012
  - status: backlog
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: medium
  - workload: Hard
  - tags: [vnext, migration, cli, skills, github]
  - domains: [CLI, SKILLS, SYNC, GITHUB, DOCS]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/E-012.md

### [T-057] Unify CLI, consolidate skills, and define GitHub source modes

  - id: T-057
  - status: backlog
  - type: feature
  - parent: E-012
  - subIssueProgress: null
  - priority: medium
  - workload: Hard
  - tags: [vnext, mapctx-cli, skills, github, migration]
  - domains: [CLI, SKILLS, SYNC, GITHUB, DOCS, TEST]
  - dependsOn: [T-050, T-052, T-056]
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-08-15
  - detail: ./tasks/T-057.md

### [T-058] Prove walking-skeleton dispatch through Traycer before waves and forecast

  - id: T-058
  - status: done
  - type: task
  - parent: E-010
  - subIssueProgress: null
  - priority: high
  - workload: Hard
  - tags: [vnext, dogfood, traycer, walking-skeleton]
  - domains: [STORE, PROTOCOL, ADAPTER, TEST]
  - dependsOn: [T-048, T-049, T-052]
  - start: null
  - due: null
  - completed: 2026-08-16
  - externalId: null
  - updated: 2026-08-16
  - detail: ./tasks/T-058.md

### [T-060] Persist dispatch and receipt state in the external store

  - id: T-060
  - status: done
  - type: feature
  - parent: E-009
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: [vnext, dispatch, receipts, store]
  - domains: [STORE, PROTOCOL, ADAPTER, TEST]
  - dependsOn: [T-049, T-052, T-058]
  - start: null
  - due: null
  - completed: 2026-08-17
  - externalId: null
  - updated: 2026-08-17
  - detail: ./tasks/T-060.md

### [T-059] Retire superseded runtime surfaces with explicit per-surface disposition

  - id: T-059
  - status: done
  - type: chore
  - parent: E-012
  - subIssueProgress: null
  - priority: medium
  - workload: Medium
  - tags: [vnext, cleanup, legacy, adr]
  - domains: [PROTOCOL, SYNC, EXTENSION, DOCS]
  - dependsOn: [T-052]
  - start: null
  - due: null
  - completed: 2026-08-16
  - externalId: null
  - updated: 2026-08-16
  - detail: ./tasks/T-059.md

## Notes

- 2026-05-29 cleanup: `TASKS.md` is the local source of truth; GitHub/Project sync validation and uncertain future workflows are paused until explicitly resumed.
- Scope is focused on monorepo priorities: reliability, task UX, GitHub Projects, docs, and hooks/plugins.
- Legacy and fork-era tasks were intentionally removed.
- 2026-08-15 vNext: live operational state will move to an external project store; `TASKS.md` becomes a deterministic compatibility snapshot after migration.
- MapCtx owns rich planning; Traycer is first execution adapter. Host workflow guardrails remain authoritative.
- Completed legacy tasks stay unchanged. Paused runner/thread/evaluator/workflow work is not resumed unless vNext evidence requires it.
- 2026-08-16 A3: three config truths collapsed to one. Root `sync.config.json` (no reader, stale project) and `TASKS_SYNC_CONTEXT.md` (declared GitHub canonical, contradicting ADR 0003) removed; `packages/sync-engine/mapcs.config.json` moved to repository root, where the CLI actually resolves it. `mapctx.toml` supersedes it at the T-049 cutover. The GitHub binding it carries is unverified — no `read:project` scope, no sync state, all `externalId: null`.
- 2026-08-16 A4: kill list closed by `T-059`, one disposition per surface — `thread.ts` internalized (removed from `@mapctx/core`'s public API and the VS Code thread panel, but kept as a file since frozen `workspace-server.ts` still imports it directly), `workspace-server.ts` frozen (it hosts workspaceV2, which the Gantt needs), `opencode-plugin` deprecated.
- 2026-08-16 T-058: walking skeleton closed. Store + protocol survive a real cross-worktree claim/release round trip; `T-050`/`T-051` proceed on that basis. Dispatch/receipt round trip does not yet survive — no store primitive persists `RunReceipt`. New `T-060` closes that gap and now gates `T-054`.
- 2026-08-15 B1: vertical slice split so evidence lands before breadth. `T-058` walking skeleton (store + dispatch through Traycer, manual, no waves/forecast/UI) now gates `T-050`/`T-051`/`T-054`; `T-056` keeps the full three-task/two-wave/Gantt/forecast/ADR proof, unchanged in scope, and now also depends on `T-051`.
