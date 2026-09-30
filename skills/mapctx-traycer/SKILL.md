---
name: mapctx-traycer
description: Attach MapCtx planning to Traycer tickets, dispatch planned waves, and ingest receipts without making Traycer planning authority.
---

# MapCtx ↔ Traycer

MapCtx owns planning. Traycer executes. Ticket Markdown is projection, never source of truth.

## Hard gate (precondition)

No real work starts without a task. Before any code/file change, deliverable, or new scope planning, inspect the current plan and search related tasks (`mapctx plan --json`, `mapctx task search --query "..." --json`). Claim an existing T-### when it clearly covers the requested scope. When the requested scope is clear but uncovered, create a focused task automatically with summary, acceptance, and affected paths; the operator's explicit work request is approval to record that work. Ask only for material ambiguity, conflicting product intent, or destructive scope. Never execute unclaimed work. Conversation, read-only analysis, and quick diagnostics need no ticket. A Traycer ticket mirrors the T-###; it never substitutes the claim. Every child-agent brief embeds the T-### and the claim-before-work order.

## Execution routing

Use the current session as an orchestrator when the active planner wave contains
more than one executable leaf task. The orchestrator coordinates claims,
dispatches, child-agent assignment, wave ordering, failures, and receipts; it
does not implement those tasks itself.

Create one child agent per executable task. Every child brief must include the
MapCtx task ID, bounded task context, worktree, claim-before-work order, and
receipt requirements. A child claims and dispatches its own task before editing.

For a single task, reuse the current session only when its context is relevant
and it has sufficient context headroom. Start a fresh child agent when the
session already contains another task or project, context is near exhaustion,
the runtime reports compaction risk, or isolated execution is required. Pass a
bounded MapCtx handoff, never the full transcript.

Use planner waves and resource claims as the routing authority. Do not run
dependent or serialized tasks in parallel, and do not dispatch container epics
as executor work.

This is a routing policy, not live agent automation. Traycer owns agent/session
lifecycle and worktrees; MapCtx remains authoritative for task state, claims,
dispatches, and receipts.

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

6. Claiming starts work: `task claim` carries the planning state to doing automatically (backlog goes through ready, one legal hop per event; paused/blocked/review stay put — unpausing is a human decision). No manual `task move --status doing` is needed before work.

   Correction after premature completion/archive: `done` and `archived` are terminal for normal planning moves, but existing work can be returned to review with `mapctx task reopen <task-id> --status review --actor traycer`. This clears `completedOn`, records an auditable `task-reopen` event, and regenerates snapshots. Do not hand-edit `TASKS.md`, use `reconcile` for intended workflow changes, or create a replacement task merely to undo a terminal state.

   Reopen changes planning state only; it does not rewrite the completed execution attempt. When planning is non-terminal (`review`/`doing`) and `executionState` is `completed`, admit a new attempt with `mapctx dispatch create <task-id> --dispatch-id <dispatch-id>` (or a fresh dispatch). This journals `completed -> unclaimed` for the new attempt, preserves the prior receipt, and keeps late receipts stale. `done`/`cancelled`/`archived` planning states still refuse dispatch.

   Execute the ticket in the assigned worktree. The work is bounded by the claim's lease; renew or release it through `mapctx task renew`/`mapctx task release` with the saved `claimId`/`leaseToken`. Adapter does not spawn agents.
7. Save normalized `RunReceipt` JSON outside the committed tree and submit it through the CLI against the dispatch created in step 5:

   ```sh
   mapctx dispatch receipt <dispatch-id> --receipt <receipt.json> --actor traycer --json
   mapctx dispatch receipt <dispatch-id> --read --json
   ```

   Duplicate, stale, unknown, or mismatched receipts must remain rejected. Do not bypass CLI or open SQLite from skill code.
   Never commit the `RunReceipt` JSON or a pointer-only artifact. When Traycer
   produces a durable artifact worth retaining, copy its complete content and
   required assets into the repository's relevant `docs/` location, then link
   that copied artifact from the matching task. The repo must remain usable
   without Traycer access.
   Before closing `review` as `done`, mark every criterion under `## Acceptance` as `[x]`; `mapctx task move ... --status done`
   rejects missing, unchecked, or prose-only acceptance criteria.

### Difficulty discovered mid-flight

When work reveals the task is harder (or easier) than planned, re-classify immediately -- do not let a
long actual pollute the pool of the wrong difficulty:

```sh
mapctx task update <task-id> --set workload=Hard --json
```

Pools are read from the current workload value, so the actual lands in the discovered pool. The
planned-vs-discovered delta is the estimation-quality signal (T-071); skipping the re-classification
destroys it and biases every future Easy forecast.

### Retroactive attestation (work that happened outside the flow)

When an agent completed a task without claiming or dispatching (flow error, or work done in an earlier
session/orchestration), the board can still record it honestly -- never by fabricating state transitions:

1. `mapctx task claim <task-id>` now (claim carries it to doing; the transitions record when the *board learned*).
2. `mapctx dispatch create <task-id>`.
3. Submit the receipt with the agent's **true** historical times in `startedAt`/`endedAt` -- the receipt keeps
   when the work actually happened, the planning transitions keep when it was recorded. The completed receipt
   on a not-doing task is rejected with this same remedy in the error message.

The orchestrating agent must capture retroactively (from the session/harness, not from memory):

- task id, and any claim/dispatch ids used (or their explicit absence)
- work start = first session timestamp, work end = last session timestamp (per session; the orchestrator
  unions them, never `max - min` across sessions)
- which agent(s)/harness(es) executed, and the orchestrating session id
- real `changedFiles` (from `git diff`, not from memory)
- session/transcript references as receipt `evidence` (URIs/ids/hashes only -- never transcript content)

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
