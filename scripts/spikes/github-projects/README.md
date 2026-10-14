# T-135 spike: GitHub Projects read/write harness

Measurement code for the E-018 provider-authority decision (ADR 0005,
option B with the local provider kept). Nothing here is production code and
nothing in `packages/` is touched. Results and analysis live in
[`docs/engineering/github-projects-spike.md`](../../../docs/engineering/github-projects-spike.md).

## Guarantees

- **The store is never opened by this code.** Every store read goes through the
  prebuilt CLI from `main` (`lib/store-input.mjs`, `lib/derive.mjs`). The
  worktree build must not touch `~/.mapctx`.
- **The bound repository is never written to.** `alotth/mapctx` is public; the
  spike reads its issues and writes only inside the private test Project.
- **Account.** All calls run as the `alotth` GitHub account, resolved per call
  with `gh auth token -u alotth`. The active `gh` account is never switched.

## Layout

| Path | What it is |
| --- | --- |
| `lib/gh.mjs` | GraphQL/REST transport with per-operation points, latency and `ProviderError` classification |
| `lib/provider.mjs` | The subset of `TaskProvider` a GitHub adapter would implement |
| `lib/derive.mjs` | Waves via `@mapctx/planner` on provider-shaped input; forecast/cost from the store snapshot |
| `lib/store-input.mjs` | Store reads, CLI-only |
| `lib/config.mjs` | Targets, corpus, the six derived field specs |
| `bin/setup-project.mjs` | Creates (idempotently) the private test Project, its six fields and one draft item per corpus task |
| `bin/read-provider.mjs` | Read path: project fields, project items, repository issues with real dependency and sub-issue edges |
| `bin/write-derived.mjs` | Computes and writes the six fields, verifies by read-back, probes idempotence and `clientMutationId` |
| `bin/measure-limits.mjs` | Page-size, idempotence, alias-batch, concurrency and field-count ceilings |
| `bin/make-roadmap-view.mjs` | Whether a Roadmap view can be built through the API |
| `bin/aggregate-metrics.mjs` | Re-derives every table the report publishes, from the committed captures |
| `lib/pure.test.mjs` | Unit tests for the pure logic (error classification, id parsing, status mapping, edge handling) |
| `measurements/*.json` | Raw captured output of each run (the numbers quoted in the doc) |
| `fixtures/store-usage-events.json` | Shape-preserving **synthetic** usage rows for the cost path (see below) |

## Tests

24 tests over the pure logic — error classification, id parsing, status mapping,
edge handling. No network, no `gh`, no store. **CI does not run them**: the root
script is `npm run build && npm run test --workspaces --if-present` and
`scripts/` is not a workspace, so this is the only way they execute:

```sh
TZ=UTC node --test scripts/spikes/github-projects/lib/pure.test.mjs
```

## Reproduce

Run from the repository root, after `npm ci && npm run build:sync-engine`.

```sh
S=scripts/spikes/github-projects/bin

node $S/setup-project.mjs       --owner alotth --repo mapctx --out measurements/01-setup.json
node $S/read-provider.mjs       --project-number 3 --first 2 \
                                --dep-repos mapctx,kanban-sync-engine,markdown-kanban-roadmap \
                                --out measurements/02-read.json
node $S/write-derived.mjs       --project-number 3 \
                                --usage-file scripts/spikes/github-projects/fixtures/store-usage-events.json \
                                --out measurements/03-write.json
node $S/measure-limits.mjs      --project-number 3 --max-field-probe 60 --out measurements/04-limits.json
node $S/make-roadmap-view.mjs   --project-number 3 --out measurements/05-view.json

# Re-derive the report's tables from the captures above (read-only, no network):
node $S/aggregate-metrics.mjs
```

Flags: `--owner`, `--repo`, `--dep-repos` (comma separated), `--project-number`,
`--project-title`, `--tasks T-1,T-2`, `--first`, `--usd-per-active-hour`,
`--usage-file`, `--max-field-probe`, `--cli`, `--account`, `--dry-run`, `--out`.

### Pointing the dependency read at seeded issues

The dependency and sub-issue read path is fully parameterised. Validating it
against non-empty edges needs no code change, only a repository that has them:

```sh
node $S/read-provider.mjs --owner <owner> --dep-repos <repo-with-seeded-edges> --project-number 3
```

### The usage fixture is synthetic

`fixtures/store-usage-events.json` holds **shape-preserving synthetic rows**
derived from the store's seven real `usage_event_projection` rows. The
`usageEventId` and `dispatchId` values are generated placeholders, not store
identifiers. Everything the cost path reads is preserved exactly: row count,
task binding, provider/model pair, the zero token counts, and
`source`/`coverage`. The file's own `note` field says the same.

**Never commit a raw store dump here.** This directory is published in a public
repository, and a dump carries internal identifiers — harmless only while the
rows happen to be empty. If you need real rows to check the cost path on your
own machine, dump them to a path **outside the repository** and point
`--usage-file` at that:

```sh
cp ~/.mapctx/projects/<project-id>/mapctx.db "$TMPDIR/store-copy.db"
sqlite3 -json "file:$TMPDIR/store-copy.db?mode=ro" "
  select u.usage_event_id as usageEventId, u.dispatch_id as dispatchId, u.provider, u.model,
         u.input_tokens as inputTokens, u.cache_tokens as cacheTokens, u.output_tokens as outputTokens,
         u.source, u.coverage, d.task_id as taskId
  from usage_event_projection u
  left join dispatch_projection d on d.dispatch_id = u.dispatch_id
  group by u.usage_event_id order by u.usage_event_id;" \
  > "$TMPDIR/store-usage-events.json"

node $S/write-derived.mjs --project-number 3 --usage-file "$TMPDIR/store-usage-events.json"
```

A bare array and the committed `{note, rows}` object are both accepted.
