# Sync Engine Release

Release target: npm package `@mapctx/sync-engine`.

## Trigger

- Git tag: `sync-vX.Y.Z`
- Workflow: `.github/workflows/release-sync-engine.yml`

## Steps

1. Update `packages/sync-engine/package.json` version.
2. Run local checks:

   ```bash
   npm ci
   npm run build:sync-engine
   npm run test --workspace @mapctx/sync-engine
   npm run pack:check --workspace @mapctx/sync-engine
   ```

3. Create and push tag:

   ```bash
   git tag sync-v0.0.1
   git push origin sync-v0.0.1
   ```

## Required Secrets

- `NPM_TOKEN`
