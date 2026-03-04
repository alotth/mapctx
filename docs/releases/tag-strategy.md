# Tag Strategy

This repository uses tag prefixes to route release pipelines in monorepo mode.

## Tag Prefixes

- `ext-vX.Y.Z`: release VS Code extension workflow.
- `sync-vX.Y.Z`: release npm package `@mapctx/sync-engine`.
- `plugin-vX.Y.Z`: release OpenCode plugin package workflow.

## Why Prefixes

- Avoid accidental cross-release triggers.
- Keep extension and npm package releases independent.
- Allow separate cadence for each artifact.

## Examples

```bash
git tag ext-v2.1.0
git push origin ext-v2.1.0

git tag sync-v0.1.3
git push origin sync-v0.1.3

git tag plugin-v0.1.0
git push origin plugin-v0.1.0
```
