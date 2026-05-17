# GitHub Project Setup

Use this only when GitHub project configuration must be created or repaired. A local-only `mapcs.config.json` does not require these fields until GitHub sync is needed.

## Create Project and Pipeline Field

Default options:

```bash
gh project create --owner <owner> --title "<project-title>"
gh project field-create <project-number> --owner <owner> --name Pipeline --data-type SINGLE_SELECT --single-select-options "Backlog,Ready for Do,Doing,Review,Done,Paused"
gh project link <project-number> --owner <owner> --repo <repo>
```

If the project uses custom statuses, include all custom options in `--single-select-options`.
Custom options may fully replace defaults.

## Required Config Entries

Set these in `mapcs.config.json`:

- `owner`
- `repo`
- `projectId`
- `statusFieldId`
- `startDateFieldId`
- `dueDateFieldId`
- `completedDateFieldId` (optional)
- `allowedStatuses`
- `completionStatuses`
- `statusMap` with 1:1 mapping for all local statuses.

If completion status is custom, define it in `completionStatuses` and keep `bootstrap.defaultStatusForImportedIssues` inside `allowedStatuses`.

## Roadmap Note

- GitHub Roadmap bars render from Project date fields.
- Dates only in issue body do not produce roadmap bars.
