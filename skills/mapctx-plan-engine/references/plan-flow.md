# Plan Flow

Use this flow to compute dependency waves after validation passes.

## Command Templates

Preferred (local binary):

```bash
mapctx plan [--config ./mapcs.config.json] [--tasks-file <tasks-path>] [--json] [--mermaid]
```

Config-less planning:

```bash
mapctx plan --tasks-file ./TASKS.md [--json] [--mermaid]
```

Fallback (npx):

```bash
npx --yes --package @mapctx/sync-engine mapctx plan [--config ./mapcs.config.json] [--tasks-file <tasks-path>] [--json] [--mermaid]
```

## Output to Capture

- total tasks
- active tasks
- wave count
- wave 1 task IDs
- cycle task IDs (if any)
- recommended next tasks

## Reporting Pattern

1. Confirm validation status from prior step.
2. Present waves compactly (first 2-3 waves inline).
3. Highlight blocked/cycle conditions.
4. End with one next operational action.

If config is absent and the user wants persistent project metadata, switch to `mapctx-sync-engine` and initialize config. That config can remain local-only; add GitHub fields only before sync work.
