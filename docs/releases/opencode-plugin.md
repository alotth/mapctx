# OpenCode Plugin Release

Release target: npm package from `packages/opencode-plugin`.

## Trigger

- Git tag: `plugin-vX.Y.Z`
- Workflow: `.github/workflows/release-opencode-plugin.yml`

## Notes

- Current package is marked `private: true` and publish step is skipped.
- Remove `private: true` and set final package name before first public release.

## Pre-release Checks

```bash
npm ci
npm run build:opencode-plugin
```

## Example Tag

```bash
git tag plugin-v0.0.1
git push origin plugin-v0.0.1
```

## Required Secrets

- `NPM_TOKEN`
