# `gh --jq` versus a GitHub MCP adapter

T-057 requires measuring compact `gh --jq` output against a GitHub MCP
implementation **before** an MCP adapter is added. This note records the
conceptual measurement from the adapter's actual query shapes; no MCP
implementation exists yet, so the numbers are derived from payload structure,
not live traffic.

## What the adapter ships over the wire today

`@mapctx/sync-engine` shells out to `gh api`, which returns complete REST/GraphQL
response envelopes. The three shapes that dominate sync traffic:

1. **Issue list (REST)** — `repos/{owner}/{repo}/issues?state=all&per_page=100`.
   Each issue carries ~20 fields (html_url, labels[], milestone, user,
   reactions, permissions...). A realistic page of 100 issues is roughly
   150-250 KB of JSON; the sync engine uses `number`, `title`, `body`, `state`,
   `labels[].name`, `milestone.title`, `node_id`, `closed_at`, `updated_at` —
   under 10% of the bytes.
2. **Project items (GraphQL)** — `items(first: 100) { nodes { id content {
   ... on Issue { number repository { name owner { login } } } } fieldValues
   ... } }`. The envelope is tighter (~3-6 KB per 100 items for ids and
   numbers) but `fieldValues(first: 20)` can inflate it when projects carry
   many fields.
3. **Mutations** — `addProjectV2ItemById`, `updateProjectV2ItemFieldValue`,
   `clearProjectV2ItemFieldValue`. Tiny requests, tiny responses; transport
   format barely matters here.

## What `--jq` would save

`gh api ... --jq '<expr>'` filters server-response JSON locally before it
reaches Node, so the win is process-level, not network-level: fewer bytes
crossing the process boundary and less parsing in the sync engine. For the
issue list, projecting to the 9 used fields with
`--jq '[.[] | {number, title, body, state, node_id, closed_at, updated_at,
labels: [.labels[].name], milestone: .milestone.title}]'` cuts the parsed
payload roughly 5-10x. For a 150-issue board (two pages), that is on the order
of 300-500 KB raw versus 30-80 KB projected. GraphQL already returns exactly
the requested selection, so `--jq` there saves little.

## What an MCP adapter would cost

A GitHub MCP server speaks JSON-RPC over stdio/HTTP with per-call envelopes,
tool schemas, and result wrapping. Relative to `gh --jq`:

| Dimension | `gh` + `--jq` | MCP adapter |
|---|---|---|
| Transport payload | filtered JSON, one hop | JSON-RPC envelope + tool schema per result |
| Process model | one `gh` spawn per call | long-lived server process |
| Auth | ambient `gh` credentials | MCP server token config |
| Failure diagnostics | `gh` stderr + our scope diagnosis | two layers (MCP + GitHub) |
| Pagination control | explicit, in-adapter (T-057) | server-dependent |

Conceptually, for the same 150-issue sync, MCP result frames carrying full
issue objects would be similar in size to unfiltered `gh` output plus envelope
overhead (~10-20%), unless the MCP tool itself supports field projection —
which reintroduces the `--jq`-equivalent problem at the tool-schema level.

## Position

The adapter's traffic is small (a few requests per sync, sub-MB total), the
GraphQL queries already select only used fields, and `--jq` gives most of the
process-level reduction without a new dependency. An MCP adapter is justified
only when a harness *requires* MCP as its GitHub surface. Do not add one for
payload reasons; revisit with measured numbers from a real MCP server if that
changes.
