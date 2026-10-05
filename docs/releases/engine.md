# CLI / web release

Public npm package: `@mapctx/sync-engine`. Version 0.3.0 bundles core, protocol, store, planner, forecast and standalone workspace assets. Node 22.13+ required (24 recommended).

## Verification

```sh
npm ci
npm test
npm run pack:check --workspace @mapctx/sync-engine
npm run pack:smoke --workspace @mapctx/sync-engine
```

Smoke verifies a clean tarball installation, canonical store/Acceptance/checkpoint operations and served web assets, without relying on a repository checkout.

## Publish

Commit reviewed changes, then push `main` and `sync-v0.3.0`. `.github/workflows/release-sync-engine.yml` checks tag/version agreement, runs tests and packaged-install smoke before `npm publish --provenance --access public`. Manual workflow dispatch also verifies package/version; already published versions cannot be overwritten.

The workflow retains the existing repository `NPM_TOKEN` publishing path and provenance permissions. npm Trusted Publishing/OIDC is an alternative only after configuring that publisher on npm; it is not assumed configured by this release. Missing credentials fail the workflow. Private library packages are bundled, not separately published.

## Upgrade existing projects

Back up project store DB + journals + metadata before upgrade. Operational `validate` is read-only and reports required maintenance rather than silently migrating. Writable store operations apply additive migrations; preserve existing event history.

For Acceptance adoption, run `mapctx acceptance import` first, review the batch, then `--commit`. It registers observed checkboxes, skips existing revisions, does not close tasks and does not approve pending criteria. Final `mapctx export` publishes mirrors.

Editor/plugin code is preserved at `legacy/integrations-pre-0.3.0` (`c6c3efa`); no OLD folder or editor-release workflow remains on main.
