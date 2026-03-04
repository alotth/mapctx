# kanban-sync-engine (alpha)

Standalone npm package + CLI to sync local `TASKS.md` with GitHub Issues and GitHub Projects (v2).

Status: alpha (early adoption). APIs, config keys, and sync behavior may change between minor releases.

Detailed operational guide: `DOCUMENTATION.md`.

## Install

```bash
npm install kanban-sync-engine
```

Release/maintainer process: see `MAINTAINERS.md`.

## Use as library (extension/plugin)

```ts
import { pullCommand, pushCommand, statusCommand } from 'kanban-sync-engine';

statusCommand({ configPath: 'kanban-sync-engine.dev.json' });
```

## Goals

- Provide a reusable sync engine for multiple clients:
  - VS Code extension (`markdown-kanban-roadmap`)
  - OpenCode plugin
  - direct CLI usage
- Keep local markdown editable while avoiding status drift across branches/agents.
- Support a strict sync flow: pull before push.

## Source of truth

After sync starts, GitHub Issues + Projects are the source of truth.

- Local edits are allowed in `TASKS.md`.
- Sync flow must always run `pull` before `push`.

## CLI commands

- `kanban-sync-engine status`
- `kanban-sync-engine pull`
- `kanban-sync-engine push`
- `kanban-sync-engine reconcile <task-id>`
- `kanban-sync-engine reconcile --list`

Optional flags:

- `--dry-run`
- `--force`
- `--accept <local|remote>`
- `--config <path>`
- `--tasks-file <path>`

## Sync conflict policy

- Remote wins:
  - `status`
  - labels (including priority/workload/tag labels)
  - milestone
- Local wins:
  - `detail`
  - `defaultExpanded`

Note: `detail` uses reconciliation safeguards. If both local and remote changed after last pull, push is blocked until resolved.

## Task model requirements (V2)

In `TASKS.md`, each task should include:

- `id`
- `status`
- `priority`
- `workload`
- `touch`
- `dependsOn`
- `start`
- `due`
- `completed` (use `null` until done)
- `externalId` (provider-neutral mapping key)
- `updated`
- `detail`

`externalId` format recommendation:

- `<provider>:<entity>:<id>`
- examples:
  - `github:issue:203`
  - `jira:issue:PLAT-442`

Optional multi-provider links:

- `externalLinks` can be used when a task is mirrored across systems.
- Keep `externalLinks` optional to avoid noise in single-provider projects.
- Example values:
  - `github:issue:203`
  - `linear:issue:ENG-42`

Recommendation:

- Keep one primary identity in `externalId`.
- Use `externalLinks` only when additional mappings are required.

## GitHub mapping

- Task <-> Issue (1:1)
- `status` <-> Project v2 Status field
- `tags` / `priority` / `workload` <-> Issue labels
- `milestone` <-> GitHub milestone
- `externalId` stores issue identity in a backend-agnostic way

## Status workflows (default + custom)

By default, `kanban-sync-engine` uses:

- `allowedStatuses`: `backlog, doing, review, done, paused`
- `completionStatuses`: `done`

You can customize this in config:

- `allowedStatuses` (optional): full list of accepted local statuses.
  - If omitted, defaults are used.
  - If provided, only these statuses are valid.
- `completionStatuses` (optional): statuses treated as completed.
  - If omitted, defaults to `["done"]`.
  - Must be a subset of `allowedStatuses`.

Important alignment rule:

- `statusMap` must include every status in `allowedStatuses`.
- Your GitHub Project field options (for example `Pipeline`) must match values in `statusMap`.

Default-style config example:

```json
{
  "allowedStatuses": ["backlog", "doing", "review", "done", "paused"],
  "completionStatuses": ["done"],
  "statusMap": {
    "backlog": "Backlog",
    "doing": "Doing",
    "review": "Review",
    "done": "Done",
    "paused": "Paused"
  }
}
```

Fully custom workflow example (no default statuses):

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

Recommended for full status parity:

- Create a custom Project single-select field (for example `Pipeline`) with options:
  - `Backlog`
  - `Doing`
  - `Review`
  - `Done`
  - `Paused`
- Use that field ID in `statusFieldId` instead of the default `Status` field.
- This avoids status collapse when the default field only has `Todo/In Progress/Done`.

Recommended for Roadmap bars:

- Create Project `DATE` fields for start/due (and optionally completed).
- Set `startDateFieldId`, `dueDateFieldId`, and optionally `completedDateFieldId` in config.
- `push` maps task `start`, `due`, and `completed` to those date fields.
- Roadmap uses Project date fields, so issue body lines like `- start:` / `- due:` are not enough by themselves.

Link project to repository (optional but recommended):

- `gh project link <project-number> --owner <owner> --repo <repo>`
- Example: `gh project link 1 --owner alotth --repo markdown-kanban-roadmap`

## GitHub API references

Primary Projects v2 doc:

- https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects

For `kanban-sync-engine`, use both API surfaces:

- Issues data (title, labels, milestone, body, state): GitHub REST API
- Project item status (Projects v2 fields/options): GitHub GraphQL API

`gh` usage model:

- `gh api repos/<owner>/<repo>/issues` for issue payloads
- `gh api graphql -f query='...'` for Projects v2 item/field values
- `gh project field-create <project-number> --owner <owner> --name Pipeline --data-type SINGLE_SELECT --single-select-options "Backlog,Doing,Review,Done,Paused"`

## Provider data placement

- Do not store provider payload blobs in `TASKS.md` or `tasks/T-XXX.md`.
- Keep markdown files clean and human-readable.
- If needed, keep provider-specific sync state in a local cache file (for example `.kanban-sync-engine/state.json`).

## Reconciliation model

`kanban-sync-engine` stores sync baselines in `.kanban-sync-engine/state.json` after successful `pull`.

For each linked task, `push` compares:

- BASE: detail at last pull
- LOCAL: current detail file
- REMOTE: current issue body

If both LOCAL and REMOTE changed since BASE, `push` is blocked and writes:

- `.kanban-sync-engine/conflicts/<task-id>.reconcile.md`

Resolve the conflict locally and run `push` again.

Helper command:

- `kanban-sync-engine reconcile <task-id>`: generate/update reconcile file
- `kanban-sync-engine reconcile <task-id> --accept local`: keep local detail and mark resolved
- `kanban-sync-engine reconcile <task-id> --accept remote`: replace local detail with remote and mark resolved
- `kanban-sync-engine reconcile --list`: list pending reconcile conflict files

## Initial workflow

1. Run migration from existing `TASKS.md`.
2. Create Issues and Project items.
3. Write back `externalId` for mapped tasks.
4. Normal flow: `pull` -> edit -> `push`.

## Bootstrap flows (both directions)

`kanban-sync-engine` must support two bootstrap modes for new projects.

### 1) Local-first bootstrap (`TASKS.md` -> GitHub)

Use when local tasks already exist and GitHub project is empty/new.

Expected behavior:

1. Validate local file format.
2. Create GitHub Issues for tasks without `externalId`.
3. Add created issues to Project v2.
4. Set Project status from local `status` using `statusMap`.
5. Write back `externalId` values.

Safety requirements:

- Support `--dry-run`.
- Require explicit confirmation flag for write operations.
- Be idempotent (skip tasks already linked by `externalId`).

### 2) Remote-first bootstrap (GitHub -> `TASKS.md`)

Use when the GitHub project/issues already exist and local file is new or outdated.

Expected behavior:

1. Read Issues + Project items from GitHub.
2. Build or update local task blocks.
3. Preserve local-only fields when matching by `externalId`.
4. Create missing local detail files when configured.
5. Keep deterministic output ordering.

Safety requirements:

- Support `--dry-run`.
- Do not delete unknown local tasks by default.
- Expose conflict report before applying destructive changes.

### Proposed CLI additions

- `kanban-sync-engine bootstrap --from local`
- `kanban-sync-engine bootstrap --from github`
- `kanban-sync-engine bootstrap --from local --dry-run`
- `kanban-sync-engine bootstrap --from github --dry-run`

After bootstrap, normal operation remains:

- `pull` before editing session
- `push` after local edits

## Bootstrap decision matrix

Use this matrix to choose the correct bootstrap mode.

| Scenario | Recommended mode | Why |
|---|---|---|
| New repo with complete local `TASKS.md` and empty GitHub project | `bootstrap --from local` | Local tasks already define scope and sequencing |
| Existing GitHub Issues/Project with missing or stale local file | `bootstrap --from github` | Remote is already authoritative |
| Both sides exist but never linked (`externalId` mostly null) | `bootstrap --from github --dry-run` first, then choose | Safer to inspect proposed matches before writing |
| Team starts with markdown planning, then publishes to GitHub | `bootstrap --from local` | Preserves local planning intent |
| Team already manages execution in GitHub boards | `bootstrap --from github` | Avoids re-creating cards/issues incorrectly |

## Command behavior breakdown

### `kanban-sync-engine bootstrap --from local`

- Reads local tasks and validates required fields.
- Creates missing Issues for tasks where `externalId` is `null`.
- Adds Issues to Project v2 and sets mapped status.
- Writes `externalId` back to `TASKS.md`.
- Never deletes remote items.

### `kanban-sync-engine bootstrap --from github`

- Reads Issues + Project v2 status values.
- Creates/updates local tasks with deterministic field order.
- Preserves local-only fields (`detail`, `defaultExpanded`) when matching existing `externalId`.
- Does not delete unknown local tasks unless explicitly enabled later.

### `kanban-sync-engine pull`

- Fetches remote updates and applies remote-wins fields.
- If date field IDs are configured, also pulls Project dates into local `start`, `due`, and `completed`.
- Keeps local-only fields.
- Updates `updated` and `completed` as needed.

### `kanban-sync-engine push`

- Requires prior `pull` success in same session.
- Sends local changes to remote for syncable fields.
- Skips local-only fields.
- Overwrites full issue body with synced markdown content from `TASKS.md` + detail file.
- Uses optimistic lock via `.kanban-sync-engine/state.json` to prevent silent overwrite.
- If remote changed since last pull:
  - when local detail also changed, push is blocked and a reconcile file is generated
  - when only remote changed, push is blocked and asks for a fresh pull
- `--force` bypasses this protection and should be used only intentionally.

### `kanban-sync-engine status`

- Shows divergence summary:
  - local-only changes
  - remote-only changes
  - field-level conflicts
  - unlinked tasks (`externalId: null`)

## Notes

- Use Node.js + TypeScript.
- Use `gh` CLI for auth and API calls (REST + GraphQL).
- Keep parser compatibility with Markdown Kanban format.

## GitHub auth scopes

To sync with Issues and Projects v2, your `gh` token needs:

- `repo`
- `read:project`
- `project`

If project commands fail with scope errors, refresh auth:

- `gh auth refresh -h github.com -s repo,read:project,project`

If you authenticated via browser, `gh` uses an OAuth token in your keychain.
You may need to complete a device-login confirmation when refreshing scopes:

1. Run `gh auth refresh -h github.com -s repo,read:project,project`
2. Copy the one-time code shown in terminal
3. Open `https://github.com/login/device`
4. Paste code and approve requested scopes
5. Re-run `gh auth status` and `gh project list --owner <owner> --format json`

Manage token scopes in GitHub settings:

- https://github.com/settings/tokens
- OAuth app approvals: https://github.com/settings/applications

Quick check:

- `gh auth status`

## Dev quickstart

From `kanban-sync-engine/`:

1. `npm install`
2. `npm run build`
3. `node dist/cli.js status --config kanban-sync-engine.dev.json`
4. `node dist/cli.js pull --dry-run --config kanban-sync-engine.dev.json`
5. `node dist/cli.js push --dry-run --config kanban-sync-engine.dev.json`
