# Portable Thread Substrate

> **Superseded by ADR 0003.** Kept as historical/current-release documentation.
> MapCtx vNext does not own transcripts or session continuation; harnesses own
> them, while MapCtx ingests normalized run events/receipts and artifact refs.

This document defines the first MapCtx contract for portable task conversations and execution continuity.

The goal is to let a task move through execution, review, replanning, and resumed execution without being tied to one runtime's native session model.

## Position

The thread substrate is not a new task store.

- `TASKS.md` owns board state.
- `tasks/<ID>.md` owns task-local scope, acceptance, decisions, and implementation notes.
- `.mapctx/threads/<ID>/` owns portable conversation context and run evidence.

Use the substrate when a task needs durable conversation continuity across Codex, Claude, OpenCode, Cursor, or a future runner.

## Directory Layout

```text
.mapctx/
  threads/
    T-123/
      thread.md
      summary.md
      meta.json
      runs/
        run-2026-05-08T13-40-00Z.json
```

`runs/` is local runtime evidence by default. The text files above it are the portable collaboration layer.

## Task Detail Link

Task detail files should link to the thread substrate only when a task actually has portable execution context.

```md
## Execution Context

- thread: ../.mapctx/threads/T-123/thread.md
- summary: ../.mapctx/threads/T-123/summary.md
- meta: ../.mapctx/threads/T-123/meta.json
- latestRun: ../.mapctx/threads/T-123/runs/run-2026-05-08T13-40-00Z.json
```

Do not put these links in `TASKS.md`; the board should stay compact and low-conflict.

## `thread.md`

`thread.md` is append-only human-readable history. It should be easy to inspect and safe to paste into another runtime when needed.

Recommended format:

```md
# Thread T-123

## Messages

### 2026-05-08T13:10:00Z - user

Review feedback: the sync path works, but null remote dates still need a regression test.

### 2026-05-08T13:14:00Z - agent

Acknowledged. I will update the date reconciliation path and add a mixed precedence regression.
```

Keep messages concise when possible. Large raw tool dumps should go into run artifacts, not the portable thread.

## `summary.md`

`summary.md` is the primary resume input. It should be short enough to load by default and specific enough for a different runtime to continue the work.

Recommended sections:

```md
# Working Summary - T-123

## Current Goal

Finish date reconciliation follow-up from review.

## Current State

Task is in `review`. The first implementation run completed, but review found one missing null-clearing regression.

## Decisions

- Keep `TASKS.md` as the source of status.
- Store execution context under `.mapctx/threads/T-123/`.

## Review Feedback

- Add coverage for remote date clearing.
- Rerun sync-engine tests.

## Next Action

Patch reconciliation, add the regression, then resume the task run with the standard implementer profile.

## Important Files

- `packages/sync-engine/src/sync.ts`
- `packages/sync-engine/src/status-workflows.test.ts`
```

Update this file after review conversations, scope corrections, failed runs, and completed runs.

## `meta.json`

`meta.json` is compact structured state for UI and runner selection. It should avoid secrets and avoid local-only paths unless the project intentionally keeps it uncommitted.

Recommended shape:

```json
{
  "taskId": "T-123",
  "schemaVersion": 1,
  "status": "review",
  "primaryThread": "thread.md",
  "workingSummary": "summary.md",
  "preferredRuntime": "codex",
  "lastRuntime": "claude",
  "lastAgentProfile": "standard-implementer",
  "lastModel": "gpt-5.5",
  "lastRunId": "run-2026-05-08T13-40-00Z",
  "updatedAt": "2026-05-08T13:40:00Z"
}
```

`status` mirrors the task status for convenience only. `TASKS.md` remains canonical.

## Run Records

Run records capture evidence from one execution attempt. They are intentionally separate from the portable summary.

Minimum useful shape:

```json
{
  "runId": "run-2026-05-08T13-40-00Z",
  "taskId": "T-123",
  "threadPath": "../thread.md",
  "summaryPath": "../summary.md",
  "runtime": "codex",
  "agentProfile": "standard-implementer",
  "model": "gpt-5.5",
  "status": "completed",
  "startedAt": "2026-05-08T13:40:00Z",
  "endedAt": "2026-05-08T14:05:00Z",
  "tokenUsage": {
    "input": null,
    "output": null,
    "total": null
  },
  "costUsd": null,
  "result": "Moved task to review after implementation and tests."
}
```

Future runners may add event logs, workspace paths, branches, PR links, screenshots, or tool-call traces.

## Programmatic API

Node runtimes should use `@mapctx/core/thread` instead of parsing these files directly in UI code.

```ts
import {
  appendThreadMessage,
  createThreadRun,
  ensureThreadContext,
  readThreadContext,
  updateThreadRun,
  updateThreadSummary
} from "@mapctx/core/thread";
```

Initial task execution:

```ts
const context = ensureThreadContext(repoRoot, "T-123", {
  status: "doing",
  preferredRuntime: "codex"
});

const run = createThreadRun(repoRoot, "T-123", {
  runtime: "codex",
  agentProfile: "standard-implementer",
  model: "gpt-5.5",
  status: "queued"
});
```

Review and resume:

```ts
appendThreadMessage(repoRoot, "T-123", "user", "Review found one missing regression.");
updateThreadSummary(repoRoot, "T-123", nextSummary);

createThreadRun(repoRoot, "T-123", {
  runtime: "claude",
  agentProfile: "review-fix",
  model: "claude-opus-4.1",
  status: "queued"
});
```

Frontend-facing state:

```ts
const viewModel = readThreadContext(repoRoot, "T-123", {
  includeThread: true,
  includeRuns: true
});
```

The browser should receive a normalized view model from an extension host, local server, or CLI process. It should not read `.mapctx` files directly.

## Lifecycle

1. When a task first needs durable execution context, create `.mapctx/threads/<ID>/`.
2. Link the substrate from `tasks/<ID>.md` under `## Execution Context`.
3. Before starting a run, load `tasks/<ID>.md`, `summary.md`, and optionally recent `thread.md`.
4. During review or replanning, append conversation notes to `thread.md` and keep `summary.md` current.
5. When resuming execution, create a new run record that points back to the same thread.
6. After the run, update `summary.md`, `meta.json`, and task detail implementation notes if the task scope changed.

## Concurrency

V1 assumes one active writer per task thread. A future runner should add a lock before automated concurrent writes:

```text
.mapctx/locks/threads/T-123.lock
```

If a lock exists, another runtime may read the thread but should not append or update `summary.md` without operator confirmation.

## Git Policy

Recommended `.gitignore` behavior:

```gitignore
.mapctx/threads/*/runs/
.mapctx/threads/*/events/
.mapctx/locks/
.mapctx/tmp/
.mapctx/state.json
```

This keeps bulky and transient runtime evidence local while allowing teams to version selected portable thread files.

Before committing thread files, check for secrets, private credentials, local machine paths, or large tool outputs.

## UI Implications

A future MapCtx UI should read:

- task status and dependencies from `TASKS.md`
- task scope and acceptance from `tasks/<ID>.md`
- conversation state from `summary.md` and `thread.md`
- current/previous execution attempts from `runs/*.json`

This supports a task detail screen with `Task`, `Discussion`, and `Runs` views without forcing a central database in the first version.

Browser UI code should consume a normalized API from an extension host, local server, or CLI process. File-backed helpers live under `@mapctx/core/thread` and are intended for Node runtimes, not direct browser imports.
