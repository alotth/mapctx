# Migrating from `mapcs` to `mapctx`

MapCtx vNext has one CLI and a deliberately small skill portfolio. This guide
covers everything that changes for CLI users and skill authors.

## CLI

`mapctx` is the canonical CLI (ADR 0003, decision 8). `mapcs` remains as a
**deprecated alias for one release cycle**, then it is removed.

| Now | After the deprecation window |
|---|---|
| `mapcs <command>` works and prints a deprecation warning on stderr | command not found |
| `mapctx <command>` canonical | unchanged |

The warning goes to **stderr only**, so scripts capturing stdout keep working
unchanged. To migrate cleanly:

```bash
# before
mapcs status --json
# after
mapctx validate --json     # board validation (also covers pre-cutover plan/validate)
```

Command-surface notes:

- Board planning/validation moves to `mapctx validate` / `mapctx plan` /
  `mapctx gantt`; store-backed task work is `mapctx task ...`,
  `mapctx import/export`, `mapctx dispatch ...`.
- The legacy GitHub sync surface (`status`, `pull`, `push`, `bootstrap`,
  `reconcile`) still lives on the `mapcs` alias during the deprecation window.
  It migrates to `mapctx` in a later release of the same major cycle; pin your
  scripts to `mapcs` only if you must, and expect the rename.
- `npx --yes --package @mapctx/sync-engine mapctx <command>` replaces the
  equivalent `mapcs` npx invocation.
- The sync config file stays `mapcs.config.json` for compatibility; new configs
  add `github.sourceMode` explicitly.

## Skills

The supported portfolio is four core skills; everything else is harness-owned
or retired (see `skills/README.md`, ADR 0003 "Superseded runtime surfaces"):

| Skill | Change |
|---|---|
| `mapctx-tasks` | teaches `mapctx task/context` APIs |
| `mapctx-plan-engine` | teaches `mapctx validate` / `mapctx plan` |
| `mapctx-sync-engine` | teaches the sync surface and explicit `github.sourceMode` |
| `mapctx-traycer` | Traycer adapter skill (epics, tickets, waves, receipts) |

Retired/harness-owned: `mapctx-enrich-task`, `mapctx-correct-course`
(consolidated; directory removal is follow-up work), `mapctx-ralph-tasks`
(execution loops belong to the harness). MapCtx core does not own runners,
evaluators, transcripts, or sessions; those are executor/harness surfaces per
ADR 0003.

## GitHub source mode

Sync configs now declare authority explicitly:

```json
{
  "github": {
    "sourceMode": "projection"
  }
}
```

- `"projection"` (default): GitHub is a one-way export of local state. `pull`,
  `bootstrap --from github`, and `reconcile --accept remote` remain available
  as explicit imports and are announced as such on every run.
- `"canonical"`: reserved for a future GitHub-authoritative mode. It is **not
  implemented**; every sync command fails closed with a clear error rather
  than silently treating GitHub as the source of truth.

Other source-mode hardening in the same release:

- The GitHub adapter paginates issue lists and Projects v2 item lists (first
  page was previously capped at 100).
- Missing-token-scope failures are diagnosed by name — e.g. Projects v2
  requires `read:project`, with the exact `gh auth refresh` remedy — instead of
  surfacing as generic 4xx auth errors.
- `push --dry-run --json` reports a machine-readable summary
  (`created`/`updated`/`conflicts`) and never writes to GitHub.
