# Field Types and Contract (V2)

Use this reference to keep deterministic structure for `TASKS.md` and detail files.

## Canonical Field Order (`TASKS.md`)

Use exactly this order in every task block:

`id`, `status`, `type`, `parent`, `subIssueProgress`, `priority`, `workload`, `touch`, `dependsOn`, `start`, `due`, `completed`, `externalId`, `updated`, `detail`.

## `TASKS.md` Field Types and Meanings

- `id` (`string`, required): unique ID `T-XXX` (example: `T-001`).
- `status` (`string`, required): default set is `backlog | doing | review | done | paused`; custom project statuses are allowed when explicitly defined.
- `type` (`enum | null`, required key): `epic | feature | task | bug | chore | null`.
- `parent` (`string | null`, required key): parent task ID (for hierarchy), usually an epic ID, or `null`.
- `subIssueProgress` (`string | null`, required key): aggregated progress text for children (for example `3/8`), or `null`.
- `priority` (`enum | null`, required key): `high | medium | low | null`.
- `workload` (`enum | null`, required key): `Easy | Normal | Hard | Extreme | null`.
- `touch` (`string[] | null`, required key): coarse component names for conflict checks.
- `dependsOn` (`string[] | null`, required key): list of prerequisite task IDs.
- `start` (`date string | null`, required key): `YYYY-MM-DD` or `null`.
- `due` (`date string | null`, required key): `YYYY-MM-DD` or `null`.
- `completed` (`date string | null`, required key): completion date or `null`.
- `externalId` (`string | null`, required key): cross-system mapping key (`github:issue:123`) or `null`.
- `updated` (`date string`, required): last edit date in `YYYY-MM-DD`.
- `detail` (`string | null`, required key): `./tasks/T-XXX.md` or `null`.

## Null and List Policy (`TASKS.md`)

- Keep every canonical key present, even when value is unknown.
- Use literal `null` (without quotes) for unknown/unset values.
- Prefer `[]` over `null` when empty list meaning is explicit.

## Detail File Conventions (`./tasks/T-XXX.md`)

- `# T-XXX` (`heading`, required): must match task `id`.
- `role` (`string | null`, recommended): owner profile/domain.
- `impact` (`enum | null`, recommended): `high | medium | low | null`.
- `estimatedEffort` (`string | null`, recommended): estimate like `3d`, `5h`, or `null`.
- `prerequisites` (`string[]`, recommended): prerequisite task IDs, keep `[]` when none.
- `blocking` (`string[]`, recommended): blocked task IDs, keep `[]` when none.
- `filesAffected` (`string[]`, recommended): expected file paths/components.
- `testsRequired` (`string[]`, recommended): checks/commands to run.
- `description` (`string | null`, recommended): one-line objective or `null`.
- `acceptance` (`markdown checklist`, optional): criteria with `- [ ]` / `- [x]`.
- `steps` (`markdown checklist`, optional): implementation checklist with `- [ ]` / `- [x]`.
- ```` ```md ... ``` ```` (`markdown block`, optional): extra context.

## Minimal Task Block Example

```markdown
### [T-001] Task title

  - id: T-001
  - status: backlog
  - type: null
  - parent: null
  - subIssueProgress: null
  - priority: null
  - workload: null
  - touch: []
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-02-20
  - detail: null
```
