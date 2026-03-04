# Contributing to MapCtx

Thanks for contributing.

## Repository Layout

- `packages/vscode-extension/`: VS Code/Cursor extension (`mapctx`)
- `packages/opencode-plugin/`: OpenCode plugin assets
- `packages/sync-engine/`: GitHub sync engine
- `packages/core/`: shared parser/model utilities
- `skills/`: reusable AI skills for OpenCode/Claude/Cursor users

## Local Development

```bash
npm ci
npm run compile
npm run build:sync-engine
npm run build:opencode-plugin
```

Package local VSIX:

```bash
cd packages/vscode-extension
npx @vscode/vsce package --out ../../mapctx-local.vsix
```

## Task Board Policy

- `TASKS.md` and `tasks/` are first-party dogfooding artifacts used by maintainers.
- External contributors should prefer Issues/PRs for feature requests and fixes.
- If your PR needs task-board updates, keep them minimal and directly tied to your code change.

## Sync Policy

- Run sync commands with `--dry-run` first.
- Do not run write sync operations against the maintainer project unless explicitly asked in the PR thread.

## Pull Requests

- Keep PRs focused and small when possible.
- Update docs when behavior or commands change.
- Use existing tag strategy for releases (`ext-v*`, `sync-v*`, `plugin-v*`).
