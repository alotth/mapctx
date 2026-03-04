# Example Tasks Model

This folder demonstrates a low-conflict, AI-friendly tasks model ready for a shared sync engine.

## Design goals

- Keep `TASKS.md` highly dynamic and lightweight.
- Minimize merge conflicts by reducing multi-line edits per task.
- Keep enough global data for parallel planning with low token cost.
- Store rich context in `tasks/T-XXX.md` detail files.
- Keep external mapping generic so sync can support multiple platforms.

## Core rules

1. Move a task by editing only `status:`.
2. Add new tasks at the end of `## Tasks`.
3. Keep fixed field order for every task block.
4. Use `touch` as coarse components (not per-file paths).
5. Put long descriptions and detailed test plans in detail files.
6. Keep `completed` always present. Use `null` until the task is done.
7. Keep `externalId` always present. Use `null` when not linked yet.

## TASKS.md field contract

Use this fixed order in every task block:

1. `id`
2. `status`
3. `priority`
4. `workload`
5. `touch`
6. `dependsOn`
7. `start`
8. `due`
9. `completed` (`null` or date)
10. `externalId` (`null` or `<provider>:<entity>:<id>`)
11. `externalLinks` (optional array for multi-provider mapping)
12. `updated`
13. `detail`

## External mapping strategy

- Use `externalId` as neutral mapping key.
- For GitHub Issues use: `github:issue:<number>`.
- This keeps the model open for other backends later (for example `jira:issue:<key>`).
- Use `externalLinks` only when the same task is synced to multiple platforms.
- Keep `externalLinks` optional to keep diffs small in most projects.

Provider data note:

- Avoid storing provider payload blobs in markdown files.
- Keep provider-specific sync state in local cache/state files managed by the sync engine.

## GitHub payload examples to design sync

Issue payload shape (REST):

```json
{
  "number": 203,
  "title": "Build local conflict and parallelization analyzer",
  "state": "open",
  "labels": [{ "name": "priority:medium" }, { "name": "workload:hard" }],
  "milestone": { "title": "v2-intelligence" },
  "body": "..."
}
```

Project v2 item payload shape (GraphQL):

```json
{
  "itemId": "PVTI_xxx",
  "content": { "number": 203 },
  "status": "Review"
}
```

Recommended mapping:

- `externalId` <-> issue number
- `status` <-> project status field
- `priority/workload/tags` <-> labels
- `milestone` <-> issue milestone
