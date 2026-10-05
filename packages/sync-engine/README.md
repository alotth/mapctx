# @mapctx/sync-engine 0.3.0

Store-backed MapCtx CLI and standalone Kanban/roadmap workspace. Node 22.13+ required (24 recommended).

```sh
npm install -g @mapctx/sync-engine@0.3.0
mapctx workspace /path/to/project
mapctx validate
mapctx plan --json
```

Canonical execution: `task start` → `dispatch receipt` → current-revision Acceptance approvals → `task finish`. Validate reads the DB/config; explicit `--snapshots` checks mirrors. Routine mutations do not regenerate local files. See [root guide](../../README.md) and `mapctx --help` for store commands.

VS Code/OpenCode UI adapters are archived in `legacy/integrations-pre-0.3.0`. Workspace assets now live in `src/workspace-ui`; the browser host remains supported. OpenCode history ingestion and `mapcs` legacy sync compatibility remain available.

The sections below document **legacy Markdown/GitHub sync**, not store-authority task editing.

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
