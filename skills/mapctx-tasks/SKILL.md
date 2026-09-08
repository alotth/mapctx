---
name: mapctx-tasks
description: Create and maintain status-based single-list TASKS.md files with deterministic low-conflict edits; trigger when requests mention `status:` updates, `## Tasks` model, sync metadata (`externalId`), epic/subtask hierarchy, and planning workflows.
---

# Kanban Tasks (Single-List)

Use this skill for boards where tasks live under one `## Tasks` section and workflow state is in `status:`.

Keep this file focused on decisions and workflow. Load detailed templates and field specs from references:

- `./references/bootstrap-and-templates.md`
- `./references/field-types-and-contract.md`
- `./references/status-and-sync.md`
- `./references/custom-statuses.md`

For operational GitHub sync commands (`status`, `pull`, `push`, `bootstrap`, `reconcile`), use skill `mapctx-sync-engine`.

## Authority Regime (Required)

Before any edit, detect which regime the project is in. Read `plansAuthority` from `mapctx.toml` at repo root; a missing file or missing key means `markdown`. See ADR 0003 §Authority and cutover for the full rule.

- `markdown` regime: nothing changes. Edit `TASKS.md`/`tasks/*.md` directly through the workflow below. When the user asks to migrate the project to store authority (v0 → v1), follow `./references/cutover-to-store.md` — it is an explicit, human-confirmed operation (validate → `import --dry-run` → reconcile divergences → `import --commit`), never a side effect of a routine edit.
- `store` regime: `TASKS.md` and the structured field block of every `tasks/<ID>.md` (`role`, `impact`, `estimatedEffort`, `prerequisites`, `blocking`, `filesAffected`, `testsRequired`, `summary`, and the `TASKS.md` field list) are generated, read-only output. Never hand-edit them.
  - Translate the same request into `mapctx` CLI calls instead, and let the CLI regenerate the snapshot. Do not write the Markdown yourself, even to "match" what the CLI will produce:
    - Register a new task/epic: `mapctx task create --title "<title>" [--type ...] [--parent id] ...`. The CLI auto-assigns the next free id for the type prefix (E for epic, T otherwise); `--description`/`--description-file` prose lands in the new detail file and stays Git-authored.
    - Change workflow state: `mapctx task move <task-id> --status <planning-state>`. `done` stamps `completedOn` and releases any active claim.
    - `task claim` starts work: it carries the planning state to doing automatically (backlog hops through ready; paused/blocked/review stay put until a human moves them). Terminal tasks refuse to be claimed.
    - Edit fields: `mapctx task update <task-id> --set key=value ...` (whitelisted fields only, including `detail.*` for `role`, `impact`, `estimatedEffort`, `filesAffected`, `testsRequired`, `summary`), and `mapctx task update <task-id> --depends-on a,b` / `--blocking x,y` for dependency edges (these replace both the edges and the detail `prerequisites`/`blocking` so the two surfaces never diverge).
    - Direct edits to `TASKS.md` or the structured detail blocks are drift, not edits.
  - Before calling the CLI, confirm the local store is materialized: `~/.mapctx/projects/<project-id>/mapctx.db` must resolve. If `plansAuthority: store` but no local store resolves, stop and tell the user to run `mapctx store init`. Do not fall back to editing Markdown as if this were the `markdown` regime — a missing local store under `store` authority is a materialization gap, not a lower authority tier.
  - The `description:` prose block in `tasks/<ID>.md` (Product Context, Decisions Taken, Implementation Notes, ...) stays human/agent-authored in both regimes; only the structured field block and `TASKS.md` move under CLI control after cutover.
  - If a manual Markdown edit is found anyway (drift), never merge it and never regenerate over it silently. Point the user at `mapctx reconcile <task-id>`.

## Workflow

1. Detect format before editing.
   - Confirm the authority regime first (see `## Authority Regime (Required)` above); stop and use CLI calls instead of direct edits when in `store` regime.
   - Confirm tasks are in one `## Tasks` list.
   - Confirm `## Work Domains` exists and stays in `TASKS.md` (do not remove it during normalization).
   - Confirm each task has `status:`.
   - Confirm each task has `domains:` and values align with domain keys from `## Work Domains` when that section is defined.
   - Accept legacy `touch:` when present, but treat it as deprecated alias for `domains`.
   - If section headers (`## Backlog`, `## Doing`, ...) are primary, normalize to single-list format before making changes.

2. Confirm source strategy (required decision gate).
   - Present source options and ask the user to choose one:
     1) Import tasks from an existing GitHub Project.
     2) Create local `TASKS.md` first (with optional future export to GitHub Project).
   - Do not proceed until one option is explicitly selected.

3. Read current board state.
   - If `TASKS.md` exists, scan all IDs to compute next `T-XXX` and `E-XXX` while keeping task order stable.
   - ID policy:
     - Use `E-XXX` when `type: epic`.
     - Use `T-XXX` for all other executable work (`feature`, `task`, `bug`, `chore`, or `null` when unresolved).
   - If `TASKS.md` does not exist, run bootstrap from `./references/bootstrap-and-templates.md` and start at `T-001` and `E-001`.

4. Apply operation with minimal diff.
   - Move status by editing only `status:` when possible.
   - Add new tasks at end of `## Tasks`.
   - Keep required canonical task fields present; if unknown, use `null`.
   - Preserve `## Work Domains` as project-level registry for valid `domains` values.
   - When creating/updating tasks, keep `domains` explicit (`[]` when unknown) and prefer existing domain keys.
   - For legacy tasks using `touch`, migrate to `domains` on write.
   - For optional fields, add only when needed by project workflow or sync setup.
   - Treat statuses as project-defined workflow states. If none are specified, use default `backlog|ready-for-do|doing|review|done|paused`.
   - Allow full rename/replacement of defaults when user defines a custom status model.

5. Enforce contract.
   - Keep exact field order and types from `./references/field-types-and-contract.md`.
   - Keep hierarchy semantics deterministic:
     - `type` is required in every task.
     - `parent` is populated for subtasks (otherwise `null`).
     - `subIssueProgress` is populated for epics when known (otherwise `null`).
   - Keep dates as `YYYY-MM-DD`.
   - Keep `externalId` provider-agnostic (`<provider>:<entity>:<id>`), or `null`.

6. Keep metadata consistent.
   - Update `updated` on every task edit.
   - Use the project completion state policy from `./references/custom-statuses.md`.
   - By default, completion state is `done`; if project defines another completion state, follow it.

7. Maintain detail files when relevant.
   - Store short objective in `summary` and full Markdown context in `description: |` in `./tasks/<ID>.md`.
   - Keep planning product-first in detail files: clarify user context and desired outcome before technical implementation notes.
   - When a task carries real decision work, split it into `## Open Decisions for Execution`, `## Decisions Taken`, and `## Implementation Notes`.
   - Keep `Open Decisions for Execution` question-only, and mark every item as `[open]`, `[resolved YYYY-MM-DD]`, or optional `[deferred YYYY-MM-DD]`.
   - Keep canonical answers in `Decisions Taken`; do not answer inline inside the open-question list.
   - Keep file paths, routes, migrations, ADRs, and rollout notes in `Implementation Notes`.
   - Keep `TASKS.md` compact and deterministic.

8. Maintain portable execution context when working a specific task.
   - When the user asks to execute, resume, review, or continue work on a task ID, keep `.mapctx/threads/<ID>/` current.
   - Prefer the project API from `@mapctx/core/thread` when available: `ensureThreadContext`, `appendThreadMessage`, `createThreadRun`, `updateThreadRun`, and `updateThreadSummary`.
   - Use `thread.md` for concise, append-only conversation and review notes. Do not paste raw tool dumps or large logs there.
   - Use `summary.md` as the operational resume input. Update it at meaningful transitions and before returning final work.
   - Use `meta.json` and `runs/*.json` for runtime metadata and execution attempts. Create a run record at start when actual execution begins, and mark it completed, failed, or canceled with a short result at the end.
   - Link the substrate from `./tasks/<ID>.md` under `## Execution Context` when it exists. Do not add thread links to `TASKS.md`.
   - Treat `runs/`, event streams, locks, and transient runtime state as local by default unless the project explicitly wants them versioned.

9. Validate before returning.
   - No duplicate IDs.
   - `## Work Domains` exists and remains unchanged unless user explicitly requested domain edits.
   - Required fields present in canonical order.
   - Optional fields, when present, follow extension order.
   - `domains` values use domain keys declared in `## Work Domains` (or are `[]`/`null` if domain model is intentionally not defined).
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
