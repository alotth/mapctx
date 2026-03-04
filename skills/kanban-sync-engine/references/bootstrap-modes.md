# Bootstrap Modes

Use bootstrap to initialize mapping between local `TASKS.md` and GitHub.

## Local-First Bootstrap (`TASKS.md` -> GitHub)

Use when local board exists and GitHub project/issues should be created from it.

```bash
kanban-sync-engine bootstrap --from local --dry-run --confirm
kanban-sync-engine bootstrap --from local --confirm
kanban-sync-engine status
```

Expected preview summary:

- Issues to create/update
- Status mappings to apply
- External IDs and links to write

## Remote-First Bootstrap (GitHub -> `TASKS.md`)

Use when GitHub project/issues already exist and local files should be materialized.

```bash
kanban-sync-engine bootstrap --from github --dry-run
kanban-sync-engine bootstrap --from github
kanban-sync-engine status
```

Expected preview summary:

- Tasks to create/update locally
- Field mappings to normalize
- Detail files to create/update

## Decision Rule

- Run `--dry-run` first for both modes.
- Explain impact before running non-dry-run bootstrap.
