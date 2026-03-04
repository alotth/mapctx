# Maintainers Guide

Internal release process for `kanban-sync-engine`.

## Prerequisites

- npm package name available (or use scoped name)
- `NPM_TOKEN` configured in GitHub repository secrets

## Manual publish (local)

```bash
npm ci
npm run build
npm run pack:check
npm publish --access public
```

## GitHub Actions publish

- workflow file: `.github/workflows/publish.yml`
- trigger by tag push: `vX.Y.Z` (example: `v0.1.0`)
- or run manually through `workflow_dispatch`

## Standard release flow

```bash
npm version patch -m "chore(release): %s"
git push origin main --follow-tags
```
