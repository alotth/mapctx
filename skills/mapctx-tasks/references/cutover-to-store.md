# Cutover: markdown → store authority

How to migrate a project from the `markdown` regime (editable `TASKS.md`) to the
`store` regime (live state in the external store, `TASKS.md` as generated
snapshot). Contract: ADR 0003 §Authority and cutover, ADR 0004 (cutover refuses
lossy imports). The agent runs the commands and surfaces divergences; every
reconciliation choice is human, never silent.

## Preconditions

- Board is valid single-list format (this skill's contract) and
  `mapctx validate --json` exits clean.
- The user explicitly asked to migrate to the store. Cutover is never a
  side effect of a routine board edit.

## Flow

1. **Validate the Markdown first.** Fix contract errors in `TASKS.md` /
   `tasks/*.md` while Markdown is still the authority — this is the cheapest
   place to fix them.

2. **Dry-run:**
   ```sh
   mapctx import --dry-run --json
   ```
   Read the report with the user. Two refusal classes, both fail closed
   (ADR 0004):
   - `unrepresentable-field-value` — an out-of-enum value (e.g. `workload:
     Medium`; the enum value is `Normal`) is recorded in `droppedFields`, not
     discarded. Fix it in the Markdown and re-run.
   - `prerequisites-dependson-mismatch` — detail-file `prerequisites` disagree
     with board `dependsOn`. `mapctx validate` may only warn; the cutover
     refuses to proceed through a known disagreement. Reconcile each pair
     explicitly: pick the winning side (detail-file intent has precedence by
     convention), fix both surfaces to agree, re-run.

3. **Commit the cutover:**
   ```sh
   mapctx import --commit --json
   git add -A && git commit   # checkpoint: store + generated TASKS.md + authority flip
   ```
   One transaction: writes `~/.mapctx/projects/<id>/mapctx.db`, generates the
   first deterministic `TASKS.md`, flips `plansAuthority` to `store` in
   `mapctx.toml`. The flip in `git log` IS the cutover event. If a legacy
   `mapcs.config.json` exists, its GitHub binding moves into `mapctx.toml` and
   the old file is deleted in the same commit — both files present after
   cutover is an error, not a preference.

4. **Post-cutover behavior** (already covered by the `store` regime branch of
   `SKILL.md`):
   - `TASKS.md` and structured field blocks are generated, read-only;
     `description:` prose stays Git-authored.
   - All board changes via `mapctx task ...`; drift is healed by
     `mapctx reconcile <task-id>`, never by hand.
   - Snapshots regenerate at end-of-wave / end-of-epic (`mapctx export`);
     committing them is the rollback checkpoint.
   - A worktree/clone without a local store under `store` authority fails
     closed — remedy is `mapctx store init` (rehydrates from the last
     committed checkpoint), never a silent fallback to Markdown.

## Exit hatch

Rolling back is a lossless round-trip only for the `persist`/`derive` field
set: store → generated `TASKS.md`/`tasks/*.md` → store. The event log, usage/
cost events, dispatch detail, and estimate history have no Markdown shape and
are not covered; a downgrade flips `plansAuthority` back to `markdown` without
deleting the store directory.
