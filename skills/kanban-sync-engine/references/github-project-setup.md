# GitHub Project Setup

Use this only when project configuration must be created or repaired.

## Create Project and Pipeline Field

Default options (when using default workflow):

```bash
gh project create --owner <owner> --title "<project-title>"
gh project field-create <project-number> --owner <owner> --name Pipeline --data-type SINGLE_SELECT --single-select-options "Backlog,Doing,Review,Done,Paused"
gh project link <project-number> --owner <owner> --repo <repo>
```

If project uses custom statuses, include all custom options in `--single-select-options` (example: `Inbox,Design,Build,QA,Released`).
Custom options may fully replace default options.

## Required Config Entries

Set these in `kanban-sync-engine.config.json`:

- `projectId`
- `statusFieldId`
- `startDateFieldId`
- `dueDateFieldId`
- `completedDateFieldId` (optional)
- `statusMap` with 1:1 mapping for all local statuses (default or fully custom)

If completion status is custom (not `done`), define that completion policy in sync configuration and docs.

## Roadmap Note

- GitHub Roadmap bars render from Project date fields.
- Dates only in issue body do not produce roadmap bars.
