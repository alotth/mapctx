# kanban-sync-engine - Documentation

Practical guide to operate `kanban-sync-engine` in your daily flow with `TASKS.md`, GitHub Issues, and GitHub Projects v2.

## 1) Prerequisites

- Node.js installed
- `gh` CLI installed and authenticated
- Required GitHub CLI token scopes:
  - `repo`
  - `read:project`
  - `project`

Command to refresh scopes:

```bash
gh auth refresh -h github.com -s repo,read:project,project
```

Validation:

```bash
gh auth status
```

## 2) Important files

- Main config: `kanban-sync-engine.config.json`
- Local board: `TASKS.md`
- Task detail files: `tasks/T-XXX.md`
- Local sync state: `.kanban-sync-engine/state.json` (auto-generated)
- Reconciliation conflicts: `.kanban-sync-engine/conflicts/*.reconcile.md`

## 3) Main commands

```bash
kanban-sync-engine status
kanban-sync-engine pull
kanban-sync-engine push
kanban-sync-engine reconcile --list
kanban-sync-engine reconcile T-002
kanban-sync-engine reconcile T-002 --accept local
kanban-sync-engine reconcile T-002 --accept remote
```

Common flags:

- `--dry-run`
- `--force`
- `--config <path>`
- `--tasks-file <path>`

## 4) Recommended daily flow

1. Before editing: `kanban-sync-engine pull`
2. Edit `TASKS.md` and/or `tasks/T-XXX.md`
3. Check divergence: `kanban-sync-engine status`
4. Publish updates: `kanban-sync-engine push`

Safety rule:

- Always run `pull` before `push`.

## 5) Initial bootstrap

### Local -> GitHub

When you already have `TASKS.md` ready and want to create issues/project data:

```bash
kanban-sync-engine bootstrap --from local --dry-run --confirm
kanban-sync-engine bootstrap --from local --confirm
```

### GitHub -> Local

When project/issues already exist and you want to materialize them locally:

```bash
kanban-sync-engine bootstrap --from github --dry-run
kanban-sync-engine bootstrap --from github
```

## 6) Conflict reconciliation (local detail vs remote)

`push` uses optimistic locking and compares:

- BASE: last successful pull
- LOCAL: current detail file (`tasks/T-XXX.md`)
- REMOTE: current issue body

If LOCAL and REMOTE changed at the same time, push is blocked and a conflict file is generated.

Step by step:

1. List conflicts:

```bash
kanban-sync-engine reconcile --list
```

2. Generate/update conflict file for a task:

```bash
kanban-sync-engine reconcile T-002
```

3. Resolve:

- keep local:

```bash
kanban-sync-engine reconcile T-002 --accept local
```

- keep remote:

```bash
kanban-sync-engine reconcile T-002 --accept remote
```

4. Publish:

```bash
kanban-sync-engine push
```

## 7) GitHub Project v2 and status mapping

To map `backlog/doing/review/done/paused` without status loss, create a custom project field:

```bash
gh project field-create <project-number> --owner <owner> --name Pipeline --data-type SINGLE_SELECT --single-select-options "Backlog,Doing,Review,Done,Paused"
```

Then configure in `kanban-sync-engine.config.json`:

- `projectId`
- `statusFieldId` (Pipeline field ID)
- `startDateFieldId` (Project date field for roadmap start)
- `dueDateFieldId` (Project date field for roadmap target)
- `completedDateFieldId` (optional Project date field for completion)
- `statusMap` with 1:1 mapping

Status workflow configuration:

- `allowedStatuses` (optional)
  - omitted: defaults to `backlog,doing,review,done,paused`
  - provided: only listed statuses are valid in `TASKS.md`
- `completionStatuses` (optional)
  - omitted: defaults to `done`
  - must be subset of `allowedStatuses`
- `bootstrap.defaultStatusForImportedIssues` must also be in `allowedStatuses`

Validation checks performed at runtime:

- invalid statuses in `TASKS.md`
- missing status keys in `statusMap`
- invalid `completionStatuses`

Example (custom full replacement):

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
  },
  "bootstrap": {
    "defaultStatusForImportedIssues": "inbox"
  }
}
```

Example (partial custom + extra status):

```json
{
  "allowedStatuses": ["backlog", "doing", "review", "done", "paused", "design"],
  "completionStatuses": ["done"],
  "statusMap": {
    "backlog": "Backlog",
    "doing": "Doing",
    "review": "Review",
    "done": "Done",
    "paused": "Paused",
    "design": "Design"
  }
}
```

Roadmap note:

- GitHub Roadmap bars are rendered from Project date fields.
- Values present only in issue body (`start`/`due`) do not create roadmap bars.

Optional but recommended: link the project to the repository:

```bash
gh project link <project-number> --owner <owner> --repo <repo>
```

## 8) Merge/sync policy

- Remote wins: `status`, labels (`priority/workload/tags`), `milestone`
- Local wins: `detail`, `defaultExpanded`
- `push` writes the full issue body with metadata + detail content

Use `--force` only when you intentionally want to bypass safety protections.
