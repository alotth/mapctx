# Daily Flow

Use this as the default safe command flow.

## Prerequisites

```bash
gh auth status
gh auth refresh -h github.com -s repo,read:project,project
```

## Tool Availability

Check if the CLI is installed:

```bash
command -v kanban-sync-engine
```

If not installed, prefer non-invasive execution first:

```bash
npx -y kanban-sync-engine@latest status
```

Global install is optional and should require explicit user confirmation:

```bash
npm install -g kanban-sync-engine
kanban-sync-engine status
```

## Session Start

```bash
kanban-sync-engine status
```

If remote has changes or state is stale:

```bash
kanban-sync-engine pull
kanban-sync-engine status
```

## Before Publishing

```bash
kanban-sync-engine status
kanban-sync-engine pull
kanban-sync-engine push
kanban-sync-engine status
```

Safety rule: always run `pull` before `push` in the same session.

## Safe Preview

```bash
kanban-sync-engine pull --dry-run
kanban-sync-engine push --dry-run
```

## Common Flags

- `--config <path>`
- `--tasks-file <path>`
- `--dry-run`
- `--force`
- `--json`
