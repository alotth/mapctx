# Bootstrap and Templates (V2)

Use this reference when `TASKS.md` does not exist, or when creating new baseline files.

## Bootstrap (When `TASKS.md` Does Not Exist)

Initialize exactly this layout at repository root:

```text
./TASKS.md
./tasks/
```

Rules:

1. Create `./TASKS.md`.
2. Create `./tasks/`.
3. Start IDs at `T-001`.
4. When a task has `detail`, create `./tasks/T-XXX.md`.

## `TASKS.md` Baseline Template

Values below are examples. Replace with real project values.

```markdown
# Tasks - <project-name>

## Components

- PARSER: example component for parser and serialization
- WEBVIEW: example component for kanban rendering and interaction
- ROADMAP: example component for roadmap timeline and progress
- CI: example component for validation and automation
- DOCS: example component for rules and docs

## Tasks

### [T-001] Task title

  - id: T-001
  - status: backlog
  - priority: null
  - workload: null
  - touch: []
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-02-20
  - detail: ./tasks/T-001.md

## Notes

- Keep updates in `TASKS.md` small and deterministic.
```

## Detail File Template (`./tasks/T-XXX.md`)

Values below are examples. Replace with real task context.

```markdown
# T-001

  - role: null
  - impact: null
  - estimatedEffort: null
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - description: null
  - acceptance:
      - [ ] Define acceptance criteria.
  - steps:
      - [ ] Define implementation steps.
    ```md
    Optional context, constraints, and notes.
    ```
```
