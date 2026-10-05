# MapCtx 0.3.1 publication

## Published and verified

[Workflow 37356050833](https://github.com/alotth/mapctx/actions/runs/37356050833) completed successfully on 2026-10-05. Linux Node 24 build/full tests, package contents and packed-install smoke passed. npm accepted `@mapctx/sync-engine@0.3.1` at 18:28:49 UTC, with a signed [provenance statement](https://search.sigstore.dev/?logIndex=3092918689). Registry subsequently confirmed version 0.3.1 and latest=0.3.1. A fresh installation from the published registry tarball passed CLI, store, Acceptance, checkpoint and HTTP asset smoke.

Release tag `sync-v0.3.1`: `06c3713f339b2600137db76a1fc006bae8aba25f`. Publication workflow commit: `0bdea8c1471cd52370fadaa27318e9173618ca18`. Package sources, scripts and metadata are byte-identical between these commits; the latter contains only CI fixture identity and audit-log corrections. The provenance correctly refers to the workflow commit. Neither release tag was rewritten. 0.3.0 was never published.

Maintained surfaces: CLI + standalone web UI. Retired VS Code/OpenCode integrations remain at historical branch `legacy/integrations-pre-0.3.0`, commit `c6c3efa9a9b3132a6f3ee4c7f6f1f5f8da51e773`. Migrations, event replay, historical session ingestion, skills, Traycer adapter and mapcs compatibility remain.

Local verification: 483/483 tests, packed Node 24 and minimum Node 22.13 smoke; three independent review passes. Canonical validate: zero errors and three pre-existing bulk-date warnings. GitHub release [sync-v0.3.1](https://github.com/alotth/mapctx/releases/tag/sync-v0.3.1) is public. Final task-end checkpoint follows canonical approval of all five criteria; its generated snapshots are committed separately from the immutable release tag.

Evidence: [successful CI](assets/publication-ci.log), [run result](assets/publication-run.json), [CI review](independent-review-ci-fixture.md), [original preparation](index.md), [dependency retry](retry.md), [CI fixture retry](ci-fixture-retry.md).

## Registry verification

- Registry gitHead: `0bdea8c1471cd52370fadaa27318e9173618ca18`, matching the successful publication run.
- Tarball SHA-1: `9eeec40b53c6b11ac02e2c73268179567b7f714e`.
- Integrity and attestation URL: [registry metadata](assets/npm-publication.json).
- [Published-package clean-install smoke](assets/registry-smoke.log) passed against the registry package, independently of local workspace dependencies.
- [GitHub release metadata](assets/github-release.json), [npm latest](assets/npm-tags.json).
