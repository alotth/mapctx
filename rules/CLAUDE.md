# Global Rules

- This project runs under `plansAuthority: store` (`mapctx.toml`, ADR 0003/0004). `TASKS.md` and the structured field blocks of `tasks/<ID>.md` are generated, read-only snapshots — never edit them directly. Board changes go through the `mapctx` CLI (`task move/reopen/update`, `dispatch create/receipt`); a drifted snapshot is fixed via `mapctx reconcile <task-id>`, never by hand.
- `done` and `archived` are terminal for normal planning moves. If either state was applied prematurely and existing work only needs review, reopen it with `mapctx task reopen <task-id> --status review --actor <name>`; this clears `completedOn` and records an audit event. Do not edit snapshots or create a replacement task to undo a terminal state.
- Reopen changes planning state, not the historical execution attempt. If `mapctx task show <task-id> --json` reports `executionState: completed` while planning is non-terminal (`review`/`doing`), admit a new attempt with `mapctx dispatch create <task-id> --dispatch-id <dispatch-id>` (or a fresh dispatch); the prior receipt remains queryable and stale receipts remain rejected. `done`/`cancelled`/`archived` planning states still refuse dispatch.
- The `description:` prose blocks of `tasks/<ID>.md` are git-authored durable intent and may be edited.
- When work flows through a Traycer epic, load the `mapctx-traycer` skill before claiming/dispatching: `mapctx task claim`, `mapctx dispatch create`, `mapctx dispatch receipt`. Traycer ticket projections are never the source of truth.
- Before execution, inspect `mapctx plan --json` and search related tasks. Reuse a task that covers the request; if requested scope is clear and uncovered, create a focused task automatically, then claim and dispatch it. Ask only for material ambiguity, conflicting product intent, or destructive scope.
- Keep `RunReceipt` JSON outside committed tree. Commit only complete durable artifacts Traycer produced, with required assets, in the relevant `docs/` location; link them from the matching task. Never commit pointer-only JSON or depend on Traycer access for repo usability.
- For JavaScript/TypeScript tooling commands, prefer running via login shell using `zsh -lic` so PATH and shell profile are loaded.
- Prefer local project CLIs via `npx` (for example: `npx prisma`, `npx next`, `npx eslint`, `npx vitest`) instead of assuming global installs.
- When a command fails with `command not found`, retry once with `zsh -lic` and `npx` (when applicable) before concluding the tool is unavailable.

## Execution Discipline

- Before implementing, state material assumptions when they affect the result. If multiple reasonable interpretations exist, surface them instead of picking silently.
- Prefer the simplest solution that fully solves the request. Avoid speculative abstractions, configurability, or future-proofing that was not asked for.
- Make surgical changes. Do not refactor, reformat, or clean up adjacent code unless it is required by the requested change.
- Clean up only what your change made obsolete. If you notice unrelated dead code or design issues, mention them without changing them unless asked.
- For non-trivial work, define success with a concrete verification path such as tests, commands, or observable behavior. For trivial work, skip ceremony and execute directly.
- Use subagents only when complexity justifies them. Default to a single agent for `lite` and most `standard` work; reserve planner/reviewer/evaluator subagents for `strict`, high-risk, or clearly cross-domain tasks.
