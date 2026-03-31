# Field Types and Contract

Use this reference to keep deterministic structure for `TASKS.md` and detail files.

## Canonical Field Order (`TASKS.md`)

Use exactly this order in every task block:

Required keys:

`id`, `status`, `type`, `parent`, `subIssueProgress`, `priority`, `workload`, `tags`, `domains`, `dependsOn`, `start`, `due`, `completed`, `externalId`, `updated`, `detail`.

Optional extension keys (append after required keys, in this order when used):

`iteration`, `assignees`, `externalLinks`, `milestone`.

## `## Work Domains` Contract (`TASKS.md`)

- Keep a top-level `## Work Domains` section before `## Tasks`.
- Each component entry uses format `- <KEY>: <description>`.
- `<KEY>` should be stable, uppercase-friendly, and short (for example `SYNC`, `WEBVIEW`, `DOCS`).
- Treat this section as the source of truth for valid `domains` values.
- Do not reorder or rewrite descriptions unless user explicitly asks.

## `TASKS.md` Field Types and Meanings

- `id` (`string`, required): unique ID using `T-XXX` or `E-XXX`.
  - Use `E-XXX` when `type: epic`.
  - Use `T-XXX` for all other types (`feature`, `task`, `bug`, `chore`, or `null`).
- `status` (`string`, required): default set is `backlog | doing | review | done | paused`; custom project statuses are allowed when explicitly defined.
- `type` (`enum | null`, required key): `epic | feature | task | bug | chore | null`.
- `parent` (`string | null`, required key): parent task ID, or `null`.
  - Use parent task ID for subtasks.
  - Use `null` when task is not a subtask.
- `subIssueProgress` (`string | null`, required key): aggregated progress text for children (for example `3/8`), or `null`.
  - Use primarily for epics.
  - Use `null` for non-epic tasks unless project explicitly uses this field.
- `priority` (`enum | null`, required key): `high | medium | low | null`.
- `workload` (`enum | null`, required key): `Easy | Normal | Hard | Extreme | null`.
- `tags` (`string[] | null`, required key): labels for planning/search/filtering.
- `domains` (`string[] | null`, required key): coarse work-domain keys for conflict checks.
  - Values should reference keys declared in `## Work Domains`.
  - Prefer `[]` over `null` when task scope is unknown but domain model exists.
- `touch` (`string[] | null`, deprecated alias): legacy key accepted only for backward compatibility.
- `dependsOn` (`string[] | null`, required key): list of prerequisite task IDs.
- `start` (`date string | null`, required key): `YYYY-MM-DD` or `null`.
- `due` (`date string | null`, required key): `YYYY-MM-DD` or `null`.
- `completed` (`date string | null`, required key): completion date or `null`.
- `externalId` (`string | null`, required key): cross-system mapping key (`github:issue:123`) or `null`.
- `updated` (`date string`, required): last edit date in `YYYY-MM-DD`.
- `detail` (`string | null`, required key): `./tasks/<ID>.md` or `null`.

Optional extension keys:

- `iteration` (`string | null`, optional): timebox/cycle identifier (for example `2026-W11`, `Sprint 12`, `Q2-2026`).
- `assignees` (`string[] | null`, optional): assignee handles/logins (for GitHub, prefer login names).
- `externalLinks` (`string[] | null`, optional): multi-provider references when one task maps to more than one external system.
- `milestone` (`string | null`, optional): delivery marker/release grouping when project uses milestone semantics.

## Null and List Policy (`TASKS.md`)

- Keep every required canonical key present, even when value is unknown.
- Use literal `null` (without quotes) for unknown/unset values.
- Prefer `[]` over `null` when empty list meaning is explicit.
- If `## Work Domains` exists, keep `domains` aligned to declared domain keys.

## Detail File Conventions (`./tasks/<ID>.md`)

- `# <ID>` (`heading`, required): must match task `id` (`T-XXX` or `E-XXX`).
- `role` (`string | null`, recommended): owner profile/domain.
- `impact` (`enum | null`, recommended): `high | medium | low | null`.
- `estimatedEffort` (`string | null`, recommended): estimate like `3d`, `5h`, or `null`.
- `prerequisites` (`string[]`, recommended): prerequisite task IDs, keep `[]` when none.
- `blocking` (`string[]`, recommended): blocked task IDs, keep `[]` when none.
- `filesAffected` (`string[]`, recommended): expected file paths/components.
- `testsRequired` (`string[]`, recommended): checks/commands to run.
- `summary` (`string | null`, recommended): one-line objective or `null`.
- `description` (`markdown block scalar`, recommended): full task context in Markdown, using `- description: |` and indented multiline content.

Rules:

- Keep `description` as the last metadata key in detail files.
- Place acceptance criteria, implementation steps, notes, and checklists inside `description` Markdown headings.
- Do not use separate `acceptance`, `steps`, `objective`, or fenced ```` ```md ... ``` ```` sections.

## Minimal Task Block Example

```markdown
### [T-001] Task title

  - id: T-001
  - status: backlog
  - type: task
  - parent: null
  - subIssueProgress: null
  - priority: null
  - workload: null
  - tags: []
  - domains: []
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-03-06
  - detail: null
```
