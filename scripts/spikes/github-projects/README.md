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
| `lib/pure.test.mjs` | Unit tests for the pure logic (error classification, id parsing, status mapping, edge handling) |
| `measurements/*.json` | Raw captured output of each run (the numbers quoted in the doc) |
| `fixtures/store-usage-events.json` | The store's seven real usage rows, for the cost path |

## Tests

No network, no `gh`, no store. Not wired into `npm test`, which builds and tests
`packages/` only:

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

### Regenerating the usage fixture

Read-only, from a **copy** of the store, never from `~/.mapctx` directly:

```sh
cp ~/.mapctx/projects/<project-id>/mapctx.db /tmp/store-copy.db
sqlite3 -json "file:/tmp/store-copy.db?mode=ro" "
  select u.usage_event_id as usageEventId, u.dispatch_id as dispatchId, u.provider, u.model,
         u.input_tokens as inputTokens, u.cache_tokens as cacheTokens, u.output_tokens as outputTokens,
         u.source, u.coverage, d.task_id as taskId
  from usage_event_projection u
  left join dispatch_projection d on d.dispatch_id = u.dispatch_id
  group by u.usage_event_id order by u.usage_event_id;" \
  > scripts/spikes/github-projects/fixtures/store-usage-events.json
```
