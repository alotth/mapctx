# Validate Flow

Use this flow to check contract health before planning.

## Command Templates

Preferred (local binary):

```bash
mapctx validate [--config ./mapcs.config.json] [--tasks-file <tasks-path>] [--json]
```

Config-less board check:

```bash
mapctx validate --tasks-file ./TASKS.md [--json]
```

Fallback (npx):

```bash
npx --yes --package @mapctx/sync-engine mapctx validate [--config ./mapcs.config.json] [--tasks-file <tasks-path>] [--json]
```

## Interpretation

- `PASS` with warnings: planning can proceed, but include warning summary.
- `FAIL`: stop planning and report top blocking errors.
- Missing config alone is not a blocker when a `TASKS.md` path is available.
- Missing config plus missing/unknown tasks file means config setup belongs to `mapctx-sync-engine` (`mapctx init`). This can be local-only; GitHub linking is optional until sync.

## Typical Blocking Classes

- missing required keys or key order drift
- invalid statuses
- missing detail files
- invalid `domains` keys
- dependency cycles
