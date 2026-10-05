# T-122: CI fixture identity retry

The 0.3.1 tag run [37355129462](https://github.com/alotth/mapctx/actions/runs/37355129462) built every maintained package, then failed two history CLI fixtures because the runner had no Git author identity. Publication did not run.

The workflow now provides four Git author/committer environment variables only in the test step. The affected public CLI tests pass with global/system Git configuration disabled. Independent focal review passed; no assertions were weakened.

The immutable `sync-v0.3.1` tag remains at `06c3713f339b2600137db76a1fc006bae8aba25f`. The workflow will be dispatched from main after this CI-only fix. All package sources and package metadata remain byte-identical to the tag; the workflow/audit commit differs and will be recorded in the publication report.

Three ephemeral fixture lease values in tests-retry.log were redacted after attempt-2 receipt/tag. That immutable receipt pins the original historical bytes; the current asset manifest pins the sanitized log. No actual project credentials or receipt were changed.

See [independent review](independent-review-ci-fixture.md), [fixture verification](assets/fixture-env.log), and [failed CI](assets/ci-fixture-failure.log). Publication remains pending.
