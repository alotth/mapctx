# MapCtx — planning and delivery intelligence

MapCtx turns task intent into dependency/resource-aware plans, records execution receipts, and compares planned effort with delivery history. CLI and standalone browser workspace are the active interfaces in **0.3.1**.

## Install and open

Requires Node.js **22.13+** (Node 24 recommended for built-in SQLite).

```sh
npm install -g @mapctx/sync-engine@0.3.1
mapctx --help
mapctx workspace /path/to/project
```

`mapctx` without arguments also opens the workspace. Kanban, roadmap, Gantt, history and budget views ship with the CLI; no editor extension is required.

## Authority and daily flow

`mapctx.toml` declares `plansAuthority = "markdown" | "store"`. Under store authority, the external per-project store is canonical, shared across worktrees. `TASKS.md` and structured task fields are generated mirrors; task description prose remains Git-authored.

```sh
mapctx validate                    # canonical DB/config, read-only
mapctx validate --snapshots        # explicit local mirror check
mapctx plan --json
mapctx task search --query "work" --json
mapctx task create --title "Harden X" --type task --workload Normal --effort 4h --json
mapctx task start T-123 --json      # atomic claim + dispatch
mapctx dispatch create T-123 --dispatch-id <dispatch-id> --json   # retry: attempt max+1
mapctx dispatch receipt <dispatch-id> --receipt /tmp/receipt.json --json
mapctx task move T-123 --status review --json
mapctx task update T-123 --set workload=Hard --depends-on T-120,T-121 --json
mapctx task update T-123 --description-file intent.md --json
mapctx task acceptance show T-123 --json
mapctx task acceptance approve T-123 --index 0 --expect-revision 1 --evidence uri=proof://review --json
mapctx task finish T-123 --json     # canonical done gate + final checkpoint
mapctx task finish T-123 --no-snapshot --json   # same gate, no mirrors, no checkpoint
```

Under store authority these commands are the only writers of board state. `task create` auto-assigns the next free id for its type prefix; an executable task without `--workload` and `--effort` is warned and cannot be claimed. `task move` applies one legal planning hop per call, and `--status done` requires every current Acceptance criterion to be approved. `task update` patches whitelisted structured fields with `--set`, rewrites dependency edges with `--depends-on`/`--blocking`, and rewrites the Git-authored `description:` prose with `--description`/`--description-file` in any planning state, `done` and `archived` included. `task reopen <id> --status review` is the only way out of a terminal state. `dispatch create --dispatch-id <id>` appends attempt max+1 to an existing dispatch instead of opening a fresh one. Hand-editing `TASKS.md` or the structured fields of `tasks/<ID>.md` is drift; `mapctx reconcile <task-id>` is the exit path, never a manual fix.

Renew/release the returned lease through `task renew/release`; keep its token private. Approve each current Acceptance criterion explicitly. `task acceptance revise --from-file ... --expect-revision ...` creates a new pending revision. For existing projects, `mapctx acceptance import` previews a batch; `--commit` records observed checkboxes (`[x]` approved, `[ ]` pending), skips existing revisions and never infers approval from done.

Routine mutations do not regenerate mirrors. Use `task finish` or explicit `mapctx export --reason manual|wave-end|epic-end` at final boundaries.

`task finish --no-snapshot` applies the same done gate but writes nothing — no `TASKS.md`, no `tasks/*.md`, no `checkpoint.exported` event — for a checkout shared with other agents, where regenerating every mirror would mix generated files into uncommitted work. It is a **durability trade**: the committed checkpoint is what `mapctx store init` recovers from, so each skipped snapshot widens the window in which a lost store also loses that closure. The window is not per task — a checkpoint carries the `filesHash` of the whole mirror set, so one later `mapctx export` (or one default `finish`) captures every previously skipped task at once. Publish and commit at wave-end or epic-end. Wave/epic labels do not automate orchestration. Export preserves authored Acceptance notes; ambiguous reassociation or malformed fences refuse publication.

## Adoption, recovery and GitHub

```sh
mapctx import --dry-run
mapctx import --commit                 # explicit Markdown → store cutover
mapctx store backup                    # consistent copy + verifiable manifest
mapctx store backups                   # list this project's archives
mapctx store verify-backup <dir>       # re-hash every file against the manifest
mapctx store restore <dir> [--force]   # replace the store from an archive
mapctx store repair                    # replay preserved journal; gaps refuse
mapctx store init [--from-git <ref>]   # last-resort rebuild from a checkpoint
mapctx push --dry-run                  # store-backed GitHub projection
```

**Backups.** `mapctx store backup` is the real recovery path: it copies the database
(`VACUUM INTO`, so the WAL is folded in and writers are not blocked), the event journal,
identity and attestations, and writes a manifest with the schema version, the event count
and a sha256 per file. The database is snapshotted *before* the journal on purpose —
writes are journal-first, so anything appended mid-backup lands in the journal half and
replays on restore; the reverse order would produce an archive that verifies and cannot be
restored. Archives default to `~/.mapctx/backups/<projectId>/`.

`mapctx store restore` verifies the archive, replaces the store under the maintenance lock,
and replays journal entries newer than the snapshot. It refuses a tampered archive, a schema
version newer than the binary, and an existing store unless you pass `--force` (which moves
the current store aside rather than deleting it).

A schema migration and `mapctx store repair` each take an automatic snapshot first, so a
failed upgrade leaves a rollback point. Retention keeps the last few **automatic** snapshots
only — an archive you took yourself is never pruned.

**Privacy.** A backup taken before a `mapctx redact` still contains the original value, and
restoring it undoes that redaction; `redact --commit` warns when older archives exist, and
each manifest records `redactionCount` so you can tell an archive that predates a redaction
from one that follows it.

`mapctx store init` is the floor, not a backup: it rebuilds from a TASKS.md checkpoint and
every event older than it is gone. Pass `--from-git <ref>` to read the *committed* checkpoint
instead of the working copy; the result states which source it used either way. Recover
historical nodes only through reviewed, hash-pinned attestations. `mapcs` remains deprecated
compatibility for legacy Markdown/GitHub sync; removal is outside this release.

## Repository

- `packages/sync-engine`: public CLI, GitHub projection, web host/assets/tests
- `packages/core`, `protocol`, `store`, `planner`, `forecast`: shared private libraries bundled with CLI
- `packages/adapter-traycer`: executor ticket/envelope adapter
- `skills`, `rules`: agent workflows and policy
- `docs`: methodology, ADRs, reviews and release runbooks

VS Code and OpenCode **editor/plugin integrations are retired from main**. Their current sources, tooling and release runbooks remain in [`legacy/integrations-pre-0.3.0`](https://github.com/alotth/mapctx/tree/legacy/integrations-pre-0.3.0), commit `c6c3efa`. No `OLD` folder. Existing Marketplace installs are not uninstalled by this change. OpenCode session-history ingestion remains supported; retiring its UI plugin does not retire the harness.

## Develop and release

```sh
npm ci
npm run build
npm test
npm run dev:workspace-v2 -- --no-open
npm run pack:smoke --workspace @mapctx/sync-engine
```

See [CONTRIBUTING](CONTRIBUTING.md), [project context](docs/PROJECT.md), [methodology](docs/methodology.md), [skills](skills/README.md) and [release runbook](docs/releases/engine.md). `sync-vX.Y.Z` is the active release tag.
