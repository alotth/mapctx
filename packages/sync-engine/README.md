# @mapctx/sync-engine (alpha)

Standalone npm package + CLI to sync local `TASKS.md` with GitHub Issues and GitHub Projects (v2).

Status: alpha. APIs, config keys, and sync behavior may change before `1.0.0`.

**Note on workspace-server.ts:** The local workspace-server is frozen as of [T-059](../../tasks/T-059.md). It receives build-green fixes only and is revisited at external-adoption gate. It remains the sole host for workspaceV2 (used by planned Gantt) and should not be removed.

Detailed operational guide: `DOCUMENTATION.md`.

## Install

```bash
npm install @mapctx/sync-engine
```

Run with npx:

```bash
npx --yes --package @mapctx/sync-engine mapcs status
```

Release/maintainer process: see `MAINTAINERS.md`.

## Use as library

```ts
import { planCommand, pullCommand, pushCommand, statusCommand, validateCommand } from '@mapctx/sync-engine';

statusCommand({ configPath: 'mapcs.dev.json' });
validateCommand({ configPath: 'mapcs.dev.json' });
planCommand({ configPath: 'mapcs.dev.json' });
```

## CLI commands

- `mapcs init`
- `mapcs status`
- `mapcs validate`
- `mapcs plan`
- `mapcs pull`
- `mapcs push`
- `mapcs bootstrap --from <local|github>`
- `mapcs reconcile <task-id>`
- `mapcs reconcile --list`

Common flags:

- `--dry-run`
- `--force`
- `--json`
- `--mermaid` (for `mapcs plan`)
- `--accept <local|remote>`
- `--config <path>`
- `--tasks-file <path>`

## Important files

- Main config: `mapcs.config.json`
- Config template: `mapcs.config.example.json`
- Local sync state: `.mapcs/state.json`
- Conflict artifacts: `.mapcs/conflicts/<task-id>.reconcile.md`

`mapcs validate` and `mapcs plan` are read-only and can run without `mapcs.config.json` when `./TASKS.md` exists or `--tasks-file <path>` is provided. Sync commands (`status`, `pull`, `push`, `bootstrap`, `reconcile`) still require config.

## First-time setup

Create a starter config in the current repo:

```bash
mapcs init
```

This does not require linking the project to GitHub. Without an inferred GitHub remote, `owner` defaults to `local` and the config is still useful for local board settings such as `tasksFile`, statuses, and completion rules.

If you want a non-default tasks file path:

```bash
mapcs init --tasks-file ./planning/TASKS.md
```

If `mapcs.config.json` already exists, re-run with `--force` to overwrite it. Fill in GitHub owner/repo/project fields only when you want to run GitHub sync commands.

## ID generation

When importing remote issues (`bootstrap --from github`), new local IDs can follow a preferred prefix:

```json
{
  "idGeneration": {
    "preferredPrefix": "E"
  }
}
```

If omitted, the engine infers the dominant existing prefix (e.g. `T`, `E`, `EPIC`) and continues that sequence.

## Daily flow

```bash
mapcs pull
mapcs status
mapcs push
```

Safety rule: always run `pull` before `push` in the same session.

## Bootstrap

Local-first (`TASKS.md` -> GitHub):

```bash
mapcs bootstrap --from local --dry-run --confirm
mapcs bootstrap --from local --confirm
```

Remote-first (GitHub -> `TASKS.md`):

```bash
mapcs bootstrap --from github --dry-run
mapcs bootstrap --from github
```

## Reconciliation

```bash
mapcs reconcile --list
mapcs reconcile T-002
mapcs reconcile T-002 --accept local
mapcs reconcile T-002 --accept remote
mapcs push
```

## GitHub auth scopes

To sync Issues and Projects v2, your `gh` token needs:

- `repo`
- `read:project`
- `project`

Refresh scopes:

```bash
gh auth refresh -h github.com -s repo,read:project,project
gh auth status
```

## Dev quickstart

From `packages/sync-engine/`:

```bash
npm install
npm run build
node dist/cli.js status --config mapcs.dev.json
node dist/cli.js pull --dry-run --config mapcs.dev.json
node dist/cli.js push --dry-run --config mapcs.dev.json
```
