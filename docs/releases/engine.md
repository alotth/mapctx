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
   npm run pack:smoke --workspace @mapctx/sync-engine
   ```

3. Create and push tag:

   ```bash
   git tag sync-v0.1.3
   git push origin sync-v0.1.3
   ```

## npm Trusted Publisher

Publishing uses npm Trusted Publishing/OIDC from GitHub Actions instead of an npm token.

Configure `@mapctx/sync-engine` on npm with:

- publisher: GitHub Actions
- organization/user: `alotth`
- repository: `mapctx`
- workflow filename: `release-sync-engine.yml`
- allowed action: `npm publish`

`@mapctx/core` remains a private workspace package and is bundled into the `@mapctx/sync-engine` tarball via `bundleDependencies`.
