---
name: mapctx-traycer
description: Attach MapCtx planning to Traycer tickets, dispatch planned waves, and ingest receipts without making Traycer planning authority.
---

# MapCtx ↔ Traycer

MapCtx owns planning. Traycer executes. Ticket Markdown is projection, never source of truth.

## MapCtx-first flow

1. Read plan and task context from MapCtx:

   ```sh
   mapctx plan --json
   mapctx task context <task-id> --budget <tokens> --json
   ```

2. Use `@mapctx/adapter-traycer` pure functions to map each planned task to a validated `DispatchEnvelope`, then render a ticket projection. Keep only Traycer-closed frontmatter: `kind`, `title`, `status`.
3. Write projection under epic artifact directory. This creates a reviewable Markdown artifact, **not** a live Traycer ticket.
4. Human/operator attaches or recreates projection in Traycer UI. This is required: adapter cannot create Yjs docs, assign live agents, or sync Traycer board state.
5. For each executable task in wave, claim through MapCtx CLI, then register the dispatch before any work starts:

   ```sh
   mapctx task claim <task-id> --actor traycer --holder '{"provider":"traycer","epic":"<epic-id>"}' --json
   mapctx dispatch create <task-id> [--executor kind] --json
   ```

   `dispatch create` prints the `dispatchId`/attempt to feed the receipt step. Use `--dispatch-id` with the same id to append attempt max+1 on a retry instead of creating a fresh dispatch.

6. Move the task to doing before any work starts — the receipt projection requires it (`completed` lands in `review` only from `in-progress`):

   ```sh
   mapctx task move <task-id> --status doing --json
   ```

   Execute the ticket in the assigned worktree. The work is bounded by the claim's lease; renew or release it through `mapctx task renew`/`mapctx task release` with the saved `claimId`/`leaseToken`. Adapter does not spawn agents.
7. Save normalized `RunReceipt` JSON and submit it through the CLI against the dispatch created in step 5:

   ```sh
   mapctx dispatch receipt <dispatch-id> --receipt <receipt.json> --actor traycer --json
   mapctx dispatch receipt <dispatch-id> --read --json
   ```

   Duplicate, stale, unknown, or mismatched receipts must remain rejected. Do not bypass CLI or open SQLite from skill code.

## Traycer-first flow

1. Parse ticket with `importTraycerTicket`.
2. Record returned Traycer `ExternalRef` and MapCtx task ID when present. Never use Traycer ID as MapCtx identity.
3. Mark ticket `unplanned`. Missing `domains`, `paths`, `dependencies`, and `acceptance` must be enriched in MapCtx before task enters `mapctx plan` or any wave.
4. After enrichment, map canonical MapCtx task to `DispatchEnvelope`; retain external artifact/epic refs as links.

## Artifact and transcript rules

- Use `ExternalRef(provider: "traycer")` for epic/artifact/dispatch identity links.
- Promote approved docs explicitly; do not treat ticket projection as approved spec.
- Never put rich MapCtx fields in Traycer frontmatter. Body may point to MapCtx context, but MapCtx remains canonical.
- Never copy Traycer transcript/session content into MapCtx. Store IDs, URIs, receipt evidence, and hashes only.
- Resource claims are advisory. Worktree merge remains correctness backstop.

## Human boundary

Filesystem materialization approximates ticket creation. It does not perform real Traycer dispatch: no Yjs document, live assignment, agent lifecycle, or Traycer-to-MapCtx sync. Report this boundary in run evidence instead of claiming automation succeeded.
