---
name: kanban-tasks
description: Create and maintain status-based single-list TASKS.md files with deterministic low-conflict edits; trigger when requests mention `status:` updates, `## Tasks` single-list model, sync metadata (`externalId`), or v2 parser/migration workflows.
---

# Kanban Tasks (Single-List V2)

Use this skill for V2 boards where tasks live under one `## Tasks` section and workflow state is in `status:`.

Keep this file focused on decisions and workflow. Load detailed templates and field specs from references:

- `./references/bootstrap-and-templates.md`
- `./references/field-types-and-contract.md`
- `./references/status-and-sync.md`
- `./references/custom-statuses.md`
- `./references/migrate-v1-to-v2.md`

For operational GitHub sync commands (`status`, `pull`, `push`, `bootstrap`, `reconcile`), use skill `kanban-sync-engine`.

## Workflow

1. Detect format before editing.
   - Confirm tasks are in one `## Tasks` list.
   - Confirm each task has `status:`.
   - If section headers (`## Backlog`, `## Doing`, ...) are primary, use `./references/migrate-v1-to-v2.md` or use skill `tasks-md-v1` for legacy-only edits.

2. Confirm source strategy (required decision gate).
   - Present source options and ask the user to choose one:
     1) Import tasks from an existing GitHub Project.
     2) Create local `TASKS.md` first (with optional future export to GitHub Project).
   - Do not proceed until one option is explicitly selected.

3. Read current board state.
   - If `TASKS.md` exists, scan all IDs to compute next `T-XXX` and keep task order stable.
   - If `TASKS.md` does not exist, run bootstrap from `./references/bootstrap-and-templates.md` and start at `T-001`.

4. Apply operation with minimal diff.
   - Move status by editing only `status:` when possible.
   - Add new tasks at end of `## Tasks`.
   - Keep all canonical task fields present; if unknown, use `null`.
   - Treat statuses as project-defined workflow states. If none are specified, use default `backlog|doing|review|done|paused`.
   - Allow full rename/replacement of defaults when user defines a custom status model.

5. Enforce V2 contract.
   - Keep exact field order and types from `./references/field-types-and-contract.md`.
   - When hierarchy is used, keep Epic stack fields deterministic: `type`, `parent`, `subIssueProgress`.
   - Keep dates as `YYYY-MM-DD`.
   - Keep `externalId` provider-agnostic (`<provider>:<entity>:<id>`), or `null`.

6. Keep metadata consistent.
   - Update `updated` on every task edit.
   - Use the project completion state policy from `./references/custom-statuses.md`.
   - By default, completion state is `done`; if project defines another completion state, follow it.

7. Maintain detail files when relevant.
   - Store rich steps and long context in `./tasks/T-XXX.md` using the detail contract from references.
   - Keep `TASKS.md` compact and deterministic.

8. Validate before returning.
   - No duplicate IDs.
   - Required fields present in canonical order.
   - Every task appears once in the single list.

## Source Strategy Gate (Required)

Before creating a new `TASKS.md` or syncing tasks, present these options and ask for one explicit choice:

1. Import tasks from an existing GitHub Project.
2. Create local `TASKS.md` first (and export to GitHub Project later, or not).

Decision rules:

- If option 1 is selected, use the existing GitHub Project as source of truth for linkage and mapping.
- If option 2 is selected, initialize local files first and keep `externalId: null` until linked.
- If option 2 is selected and user later wants sync, create/sync GitHub Project from local `TASKS.md`.
- Do not assume project creation or linkage without explicit user confirmation.
