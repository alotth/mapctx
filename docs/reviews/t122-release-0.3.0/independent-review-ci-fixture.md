---
kind: review
title: T-122 CI fixture environment focal re-review
---

# T-122 CI fixture environment focal re-review

## Verdict

**PASS — no actionable findings.** Reviewed the release workflow-only retry patch.

## Checks

- Failed CI log identifies exactly two history CLI tests that run `mapctx import --commit`; both fail because fixture commits lack an author identity (`fatal: empty ident name`).
- Workflow adds the four required `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables only to the `Build and test maintained packages` step running `npm test`. It does not alter global/system Git config, the separate publish step, or runtime/package files.
- Both affected tests pass in an isolated build when Git global and system config are disabled and the same four fixture identity variables are supplied (`2 passed, 0 failed`). Existing test code still exercises the real import/commit path; no assertion or test behavior was weakened.
- `git diff --check` passes. No production source, package metadata, lockfile, or release tag changes are part of this patch.

## Limits

Only the two failed history CLI tests were rerun, as requested. Full suite was not rerun.
