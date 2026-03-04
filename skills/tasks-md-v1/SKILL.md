---
name: tasks-md-v1
description: Maintain legacy section-based Markdown Kanban boards (Backlog/Doing/Review/Done/Paused); trigger for projects still using section columns or when preserving production v1 behavior.
---

# Markdown Kanban and Roadmap (V1 Snapshot)

This skill preserves the production section-based rules used before V2 single-list adoption.

## TASKS.md File Structure

The `TASKS.md` file follows Kanban sections:

- Backlog: Tasks that have not been started yet
- Doing: Tasks currently in progress
- Review: Tasks awaiting review
- Done: Completed tasks
- Paused: Temporarily paused tasks
- Notes: General project notes (optional)

## Task Format

### Basic Structure

Each task follows this format:

```markdown
### Task Name

  - id: T-001
  - tags: [tag1, tag2, tag3]
  - priority: high|medium|low
  - workload: Easy|Normal|Hard|Extreme
  - milestone: sprint-26-1_1
  - start: YYYY-MM-DD
  - due: YYYY-MM-DD
  - updated: YYYY-MM-DD
  - completed: YYYY-MM-DD
  - detail: ./tasks/T-001.md
  - defaultExpanded: true|false
```

### Task Properties

#### Required

- `id`: Unique task identifier (`T-XXX`)

#### Optional

- `tags`: Array format `[tag1, tag2, tag3]`
- `priority`: `high | medium | low`
- `workload`: `Easy | Normal | Hard | Extreme`
- `milestone`: sprint marker or custom grouping key
- `start`: `YYYY-MM-DD`
- `due`: `YYYY-MM-DD`
- `updated`: `YYYY-MM-DD`
- `completed`: `YYYY-MM-DD`
- `detail`: `./tasks/T-XXX.md`
- `defaultExpanded`: `true | false`

### Inline Description

If not using a detail file, include inline markdown block:

```markdown
### Task Name

  - id: T-001
  - tags: [backend]
  - priority: high
    ```md
    Detailed task description here.
    Can contain multiple lines and markdown formatting.
    ```
```

## Detail Files (`tasks/T-XXX.md`)

When using `detail: ./tasks/T-XXX.md`, file format is:

```markdown
# T-001

  - steps:
      - [ ] Step 1
      - [x] Step 2
      - [ ] Step 3
    ```md
    Detailed task description.
    ```
```

### Steps Format

- Use `- [ ]` for open steps
- Use `- [x]` for completed steps
- Keep indentation with at least 6 leading spaces before checklist items

## Important Rules

1. Use 2-space indentation for task properties.
2. Use `YYYY-MM-DD` for all dates.
3. Keep IDs unique (`T-XXX`).
4. Keep tags in bracket array format with comma+space separators.
5. Keep descriptions in ` ```md ` blocks.
6. Keep steps in detail files, not in `TASKS.md`.
7. Maintain section flow between Backlog/Doing/Review/Done/Paused.

## Status Flow

- Backlog -> Doing
- Doing -> Review
- Review -> Done
- Doing -> Paused
- Paused -> Doing

## Best Practices

1. Use sequential IDs (`T-001`, `T-002`, ...).
2. Keep tags consistent.
3. Update `updated` on every task change.
4. Use detail files for complex tasks.
5. Use milestones for grouping.
6. Keep sections organized.
