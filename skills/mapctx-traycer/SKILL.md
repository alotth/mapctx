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
5. For each executable task in wave, claim through MapCtx CLI:

   ```sh
   mapctx task claim <task-id> --actor traycer --holder '{"provider":"traycer","epic":"<epic-id>"}' --json
   ```

6. Human/Traycer runtime creates its dispatch attempt and executes ticket in assigned worktree. Adapter does not spawn agents or create live attempts.
7. Save normalized `RunReceipt` JSON. Submit through existing CLI:

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
