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
mapctx task start T-123 --json      # atomic claim + dispatch
mapctx dispatch receipt <dispatch-id> --receipt /tmp/receipt.json --json
mapctx task acceptance show T-123 --json
mapctx task acceptance approve T-123 --index 0 --expect-revision 1 --evidence uri=proof://review --json
mapctx task finish T-123 --json     # canonical done gate + final checkpoint
```

Renew/release the returned lease through `task renew/release`; keep its token private. Approve each current Acceptance criterion explicitly. `task acceptance revise --from-file ... --expect-revision ...` creates a new pending revision. For existing projects, `mapctx acceptance import` previews a batch; `--commit` records observed checkboxes (`[x]` approved, `[ ]` pending), skips existing revisions and never infers approval from done.

Routine mutations do not regenerate mirrors. Use `task finish` or explicit `mapctx export --reason manual|wave-end|epic-end` at final boundaries. Wave/epic labels do not automate orchestration. Export preserves authored Acceptance notes; ambiguous reassociation or malformed fences refuse publication.

## Adoption, recovery and GitHub

```sh
mapctx import --dry-run
mapctx import --commit             # explicit Markdown → store cutover
mapctx store init                  # recover from committed checkpoint
mapctx store repair                # replay preserved journal; gaps refuse
mapctx push --dry-run               # store-backed GitHub projection
```

Back up `~/.mapctx/projects/<id>/` (DB, journals and metadata); Git checkpoints are not complete event-history backups. Recover historical nodes only through reviewed, hash-pinned attestations. `mapcs` remains deprecated compatibility for legacy Markdown/GitHub sync; removal is outside this release.

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
