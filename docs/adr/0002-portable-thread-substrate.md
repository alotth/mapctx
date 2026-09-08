# ADR-0002: Portable Thread Substrate

- Status: Superseded by ADR 0003
- Date: 2026-05-08

> Historical decision. Harnesses now own sessions/transcripts. MapCtx vNext
> stores normalized dispatch/events/receipts externally and promotes only durable
> decisions or evidence references to Git.

## Context

MapCtx is moving from task planning toward observable execution. A future runner or UI needs to show which agent is working on a task, what happened during review, and how work can resume after a long replanning conversation.

Runtime-native thread IDs are useful but not portable. Codex, Claude, Cursor, OpenCode, and future adapters may all expose different session models. If MapCtx stores execution continuity only inside one runtime, review and replanning become hard to resume from another tool.

The existing source-of-truth decision still stands: `TASKS.md` and `tasks/<ID>.md` own task state. Any execution context layer must compose with those files rather than replacing them.

## Decision

MapCtx will use a portable, repository-local thread substrate under `.mapctx/threads/<task-id>/`.

The substrate is text-first and vendor-neutral:

- `thread.md` stores the append-only human-readable conversation history for a task.
- `summary.md` stores the current working summary used to resume execution.
- `meta.json` stores compact structured metadata for UI and runtime routing.
- `runs/` stores per-run execution records, logs, token usage, and cost data.

Task detail files may link to the active thread substrate, but task status, priority, dependencies, acceptance, and execution decisions remain in `TASKS.md` and `tasks/<ID>.md`.

## Consequences

### Positive

- Agent conversations can resume across runtimes without depending on a vendor thread ID.
- Review and replanning can happen in a durable text artifact before a new run starts.
- A future UI can show task discussion, summaries, active runs, and cost history from local files.
- The model stays compatible with Git workflows and plain-text inspection.

### Tradeoffs

- The substrate introduces another artifact family that must be kept clearly non-canonical for task state.
- `summary.md` must be maintained as the operational resume context; raw transcript alone is too large and noisy.
- Concurrent writers need a locking policy before automated multi-agent writes are enabled.
- Sensitive data redaction must be handled before teams decide to commit thread artifacts.

## Required Boundaries

- `TASKS.md` remains canonical for board state.
- `tasks/<ID>.md` remains canonical for task-local scope, acceptance, decisions, and implementation notes.
- `.mapctx/threads/<task-id>/summary.md` is canonical only for resuming a conversation or run.
- `.mapctx/threads/<task-id>/runs/` is runtime evidence, not planning state.
- No runtime-specific transcript schema may become required for portability.

## Versioning Policy

The recommended default is:

- commit `summary.md` when the summary is useful for future collaborators
- commit `thread.md` only when the team wants full task discussion auditability
- commit `meta.json` when it contains no local-only paths or sensitive values
- do not commit `runs/`, raw event streams, locks, or transient runtime state

Projects may tighten this policy, but MapCtx tooling should treat the portable text files as optional-to-version and the run artifacts as local by default.

## Rejected Alternatives

### Store only runtime thread IDs

Rejected because it locks task continuity to one agent runtime and makes cross-tool resumption brittle.

### Store only raw transcripts

Rejected because long transcripts are poor resume inputs. A maintained working summary is required.

### Move task execution state into `.mapctx`

Rejected because it would duplicate the existing source of truth and weaken sync behavior.

## Follow-On Implications

- Add a thread-substrate reference document with file contracts and lifecycle rules.
- Future runner work should create/update thread files before adding UI assumptions.
- Future UI work should read task state from `TASKS.md` and execution context from `.mapctx/threads/`.
- Future cost tracking should attach to run records instead of task fields unless a summarized cost field is explicitly added later.
