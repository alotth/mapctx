# Maintainers

Canonical release/upgrade procedure: [CLI release runbook](../../docs/releases/engine.md).

Use Node 24, `npm ci`, `npm test`, packed-install smoke, reviewed commit and matching `sync-vX.Y.Z` tag. GitHub Actions retains the existing repository NPM_TOKEN publication path with provenance permissions. Do not run root `npm version`: the root is private and unversioned. Only public sync-engine gets the release bump; private workspace libraries are bundled.

VS Code/OpenCode editor adapters are preserved in `legacy/integrations-pre-0.3.0`, with no active release workflows on main.
