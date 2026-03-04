# Migrate V1 to V2

Use this reference to convert legacy section-based boards to V2 single-list format.

## Scope

- Source: section-based `TASKS.md` with `## Backlog`, `## Doing`, `## Review`, `## Done`, `## Paused`.
- Target: single-list `TASKS.md` with one `## Tasks` section and `status:` field on every task.
- Detail files remain in `./tasks/T-XXX.md` and should be normalized to V2 conventions.

## Section to Status Mapping

- `## Backlog` -> `status: backlog`
- `## Doing` -> `status: doing`
- `## Review` -> `status: review`
- `## Done` -> `status: done`
- `## Paused` -> `status: paused`

## TASKS.md Migration Steps

1. Read all tasks and preserve task order by ID when possible.
2. Move all task blocks into one `## Tasks` section.
3. Add/normalize canonical V2 fields in this order:
   - `id`, `status`, `priority`, `workload`, `touch`, `dependsOn`, `start`, `due`, `completed`, `externalId`, `updated`, `detail`.
4. Keep every canonical key present.
   - Use `null` for unknown scalar values.
   - Use `[]` for known-empty list values.
5. Set `completed` consistency:
   - If status is in completion state (default: `done`), keep date if available; otherwise set completion date.
   - If status is not in completion state, set `completed: null`.
6. Normalize `externalId`:
   - Keep existing mapping values.
   - If missing, set `externalId: null`.

## Detail File Migration (`./tasks/T-XXX.md`)

1. Keep one file per task ID, path `./tasks/T-XXX.md`.
2. Ensure heading matches task ID (`# T-XXX`).
3. Normalize structure to deterministic keys where possible:
   - `role`, `impact`, `estimatedEffort`, `prerequisites`, `blocking`, `filesAffected`, `testsRequired`, `description`, `acceptance`, `steps`.
4. Preserve existing checklist state and markdown context blocks.
5. If values are unknown, use `null` or `[]` placeholders.

## Validation Checklist

- Every task appears once under `## Tasks`.
- No duplicate IDs.
- Canonical field order is preserved.
- `updated` present and current on migrated tasks.
- `detail` path is valid or `null`.
- All detail files referenced by `detail` exist.
