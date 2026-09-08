# Global Rules

- This project runs under `plansAuthority: store` (`mapctx.toml`, ADR 0003/0004). `TASKS.md` and the structured field blocks of `tasks/<ID>.md` are generated, read-only snapshots — never edit them directly. Board changes go through the `mapctx` CLI (`task move/update`, `dispatch create/receipt`); a drifted snapshot is fixed via `mapctx reconcile <task-id>`, never by hand.
- The `description:` prose blocks of `tasks/<ID>.md` are git-authored durable intent and may be edited.
- When work flows through a Traycer epic, load the `mapctx-traycer` skill before claiming/dispatching: `mapctx task claim`, `mapctx dispatch create`, `mapctx dispatch receipt`. Traycer ticket projections are never the source of truth.
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
