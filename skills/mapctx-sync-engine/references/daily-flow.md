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
command -v mapcs
```

If not installed, prefer non-invasive execution first:

```bash
npx --yes --package @mapctx/sync-engine mapcs status
```

Global install is optional and should require explicit user confirmation:

```bash
npm install -g @mapctx/sync-engine
mapcs status
```

## Session Start

```bash
mapcs status
```

If remote has changes or state is stale:

```bash
mapcs pull
mapcs status
```

## Before Publishing

```bash
mapcs status
mapcs pull
mapcs push
mapcs status
```

Safety rule: always run `pull` before `push` in the same session.

## Safe Preview

```bash
mapcs pull --dry-run
mapcs push --dry-run
```

## Common Flags

- `--config <path>`
- `--tasks-file <path>`
- `--dry-run`
- `--force`
- `--json`
