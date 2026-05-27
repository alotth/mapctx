# Maintainers Guide

Internal release process for `@mapctx/sync-engine` (CLI commands `mapcs` and `mapctx`).

## Prerequisites

- npm package name available (or use scoped name)
- `NPM_TOKEN` configured in GitHub repository secrets

## Manual publish (local)

```bash
npm ci
npm run build:sync-engine
npm run pack:check --workspace @mapctx/sync-engine
npm run pack:smoke --workspace @mapctx/sync-engine
npm publish --workspace @mapctx/sync-engine --access public
```

`@mapctx/core` is private and bundled into the sync-engine tarball; do not publish it separately.

## GitHub Actions publish

- workflow file: `.github/workflows/release-sync-engine.yml`
- trigger by tag push: `sync-vX.Y.Z` (example: `sync-v0.0.1`)
- or run manually through `workflow_dispatch`

## Standard release flow

```bash
npm version patch -m "chore(release): %s"
git push origin main --follow-tags
```
