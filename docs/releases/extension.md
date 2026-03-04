# Extension Release

Release target: Visual Studio Marketplace + Open VSX.

## Trigger

- Git tag: `ext-vX.Y.Z`
- Workflow: `.github/workflows/main.yml`

## Steps

1. Update extension version in `packages/vscode-extension/package.json`.
2. Run local checks:

   ```bash
   npm ci
   npm run package
   ```

3. Create and push tag:

   ```bash
   git tag ext-v2.0.5
   git push origin ext-v2.0.5
   ```

## Required Secrets

- `VS_MARKETPLACE_TOKEN`
- `OPEN_VSX_TOKEN`
