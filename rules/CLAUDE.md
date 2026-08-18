# Global Rules

- If the repository contains a `TASKS.md` file, ask once per session whether to use the Markdown Kanban standard and load the `mapctx-tasks` skill.
- If the user agrees, call `skill("mapctx-tasks")` before creating or editing `TASKS.md` or any `./tasks/T-XXX.md` detail files.
- If the user declines, do not ask again during the same session.
- Do not load the skill for unrelated work.
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
