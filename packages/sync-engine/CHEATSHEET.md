# kanban-sync-engine Cheat Sheet

## Auth

```bash
gh auth status
gh auth refresh -h github.com -s repo,read:project,project
```

## Daily flow

```bash
kanban-sync-engine pull
kanban-sync-engine status
kanban-sync-engine push
```

## Safe preview

```bash
kanban-sync-engine pull --dry-run
kanban-sync-engine push --dry-run
```

## Reconciliation

```bash
kanban-sync-engine reconcile --list
kanban-sync-engine reconcile T-002
kanban-sync-engine reconcile T-002 --accept local
kanban-sync-engine reconcile T-002 --accept remote
kanban-sync-engine push
```

## Bootstrap

```bash
kanban-sync-engine bootstrap --from local --dry-run --confirm
kanban-sync-engine bootstrap --from local --confirm

kanban-sync-engine bootstrap --from github --dry-run
kanban-sync-engine bootstrap --from github
```

## Project setup (GitHub)

```bash
gh project create --owner alotth --title "Markdown Kanban Roadmap V2 Execution"
gh project field-create <project-number> --owner alotth --name Pipeline --data-type SINGLE_SELECT --single-select-options "Backlog,Doing,Review,Done,Paused"
gh project link <project-number> --owner alotth --repo markdown-kanban-roadmap
```

## Status workflow config snippets

Default-compatible:

```json
{
  "allowedStatuses": ["backlog", "doing", "review", "done", "paused"],
  "completionStatuses": ["done"]
}
```

Fully custom:

```json
{
  "allowedStatuses": ["inbox", "design", "build", "qa", "released"],
  "completionStatuses": ["released"],
  "statusMap": {
    "inbox": "Inbox",
    "design": "Design",
    "build": "Build",
    "qa": "QA",
    "released": "Released"
  }
}
```

Rules:

- `statusMap` must cover all `allowedStatuses`
- `completionStatuses` must be subset of `allowedStatuses`
- GitHub Pipeline options must match `statusMap` values

## Common flags

- `--config <path>`
- `--tasks-file <path>`
- `--dry-run`
- `--force`
- `--json`
