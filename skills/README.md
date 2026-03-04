# MapCtx Skills

This directory contains reusable skill packs for AI-assisted workflows.

## Available Skills

- `kanban-tasks`: maintain single-list `TASKS.md` (V2 status model)
- `kanban-sync-engine`: run safe TASKS <-> GitHub sync operations
- `tasks-md-v1`: maintain legacy section-based boards

## Intended Use

- OpenCode users
- Claude-compatible agent workflows
- Cursor users with custom agent/task instructions

## Notes

- Skills are versioned with the monorepo.
- When task format contracts change, update both skill docs and package docs in the same PR.
