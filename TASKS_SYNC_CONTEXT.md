## Sync Engine - Context Brief

### Goal
Build a standalone npm package + CLI sync engine to keep a local `TASKS.md` (Markdown Kanban format) in sync with GitHub Issues and GitHub Projects (Projects v2). The package will be used by multiple clients:
- VS Code extension (markdown-kanban-roadmap)
- OpenCode plugin (separate repo)
- CLI for developers

### Source of truth
GitHub Issues + Projects are the source of truth after sync.
`TASKS.md` is editable locally and can be pushed to GitHub, but sync must always pull before push.

### Key requirements
- Use Node.js (TypeScript preferred).
- Publish to npm (public package).
- Provide both CLI and programmatic API.
- Use `gh` CLI internally for auth + API calls (REST + GraphQL for Projects v2).
- Support manual + hook usage (pull/push commands).
- Keep `TASKS.md` format compatible with Markdown Kanban rules.
- Must work across branches and multiple agents without diverging status.

### TASKS.md format
The file follows Markdown Kanban sections:
- Backlog
- Doing
- Review
- Done
- Paused
- Notas (or Notes)

Tasks are formatted like:
```
### Task Title

  - id: T-001
  - tags: [tag1, tag2]
  - priority: high|medium|low
  - workload: Easy|Normal|Hard|Extreme
  - milestone: sprint-26-1_1
  - start: YYYY-MM-DD
  - due: YYYY-MM-DD
  - updated: YYYY-MM-DD
  - completed: YYYY-MM-DD
  - detail: ./tasks/T-001.md
  - defaultExpanded: true|false
```

### Mapping (recommended)
- Task <-> Issue (1:1)
- Section <-> Project Status field
- tags/priority/workload -> Issue labels
- milestone -> GitHub milestone
- Additional fields (detail, defaultExpanded) are local-only
- Add a stable mapping field in TASKS.md:
  - `issue: <number>` (recommended)

### Sync rules
- Always `pull` before `push`.
- If conflicts:
  - Remote wins for status + labels.
  - Local wins for local-only fields (detail, defaultExpanded).
- Provide `dry-run` and `status` commands.

### CLI commands
- `sync pull`
- `sync push`
- `sync status`

### Config
Use a config file (example name: `sync.config.json`) in repo root with:
- owner, repo
- projectId
- statusFieldId
- status mapping (Backlog/Doing/Review/Done/Paused)
- tasksFile path (default: ./TASKS.md)

### Integration targets
- VS Code extension should expose commands: Sync Tasks / Pull / Push
- OpenCode plugin should call `sync pull` on session start and `sync push` when TASKS.md changes

### Initial workflow
1) Migration: create Issues/Project items from existing TASKS.md
2) Update TASKS.md with `issue: <number>` for mapping
3) Normal workflow: pull -> edit -> push

### Notes
- Prefer ASCII content; avoid special characters unless required.
- Keep the parser compatible with existing example format.
