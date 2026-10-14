# Board triage before the GitHub mirror

**Date:** 2026-10-14
**Task:** T-149 (epic E-018)
**Status:** proposal only — **no board state was changed by this task**
**Why now:** the operator will mirror this board into GitHub Issues/Projects on the
**public** repo `alotth/mapctx` (T-151 sanitization, T-152 mirror, T-153 real run).
A task that is parked with no decision becomes published noise, so every stalled
row needs a disposition first.

Read-only inputs: `mapctx board/task show/task acceptance show` (CLI prebuilt from
`main`), the SQLite store opened read-only on a copy, `git log`/working tree of
`e-017/integration`, `docs/reviews/`, and the independent-review artifacts held in
the Traycer epic (outside this repo).

## Counts by proposal

| Proposal | Rows |
| --- | --- |
| Approve with existing evidence | 23 |
| Work remaining before approval | 4 |
| Cancel (superseded; 3 of them fold into T-150/T-152) | 7 |
| Archive (will not proceed) | 15 |
| Close as dependent epic | 1 |
| Keep as is | 3 |
| **Total rows triaged** | **53** |

Board state at the end of this task: 172 tasks — 83 done, 29 review, 36 backlog,
19 paused, 4 doing, 1 archived. The review column held 27 when triage started; T-133
and T-139 entered it during this task and belong to the live E-017/E-018 flow, so they
await the orchestrator's own review and integration rather than triage. The triaged
set is the 27 original review rows, the 19 paused rows, the 3 test rows and the 4 open
epics not already covered by the paused table.

Publication flags: **3 rows must not be published**, **4 rows need sanitization**,
the other 46 are publishable as they stand.

## The finding that explains most of the review column

15 of the 27 triaged review tasks are not in review because someone found a defect.
They were `done`, and a single bulk `task reopen` moved them back in **2.5 seconds**:

```
2026-09-23T00:46:09.288Z .. 00:46:11.554Z   actor codex   source task-reopen
T-049 T-057 T-058 T-065 T-067 T-068 T-069 T-070 T-071 T-072 T-073 T-074 T-075 T-078 T-083
```

No reason is recorded on those events (`task reopen` takes none). The two events
immediately before are `domains` backfills on T-083 and T-087, so the surrounding
activity is a board-maintenance pass, not a quality audit. At that date `task reopen`
accepted a `done` task only — reopening `cancelled`/`archived` arrived days later with
T-090 — so all 15 had been closed beforehand, and the matching
`chore(board): T-0xx approved to done` commits are still in this branch's history.

T-090 and T-092 were reopened separately on 2026-09-27 while T-090's **own** feature
(`archived` as a terminal status, plus the widened `task reopen`) was being exercised
against the live board: T-092 took seven planning transitions across `cancelled`,
`review` and `archived` inside four minutes, and T-090 itself went
in-progress → archived → in-progress → archived → review. That is feature testing, not
a verdict on the work.

**Consequence for triage:** for this cohort, `review` carries no information about
delivery quality. Each row below is judged against the code and docs in the integrated
tree, not against its planning state.

## Two evidence sources that must not be mistaken for verification

**1. The `history-scan` receipts are invalidated.** 21 of the 27 triaged review tasks
carry a receipt produced by `mapctx history scan`, recognisable by a span of weeks or
months and a single changed file. All 29 such receipts on this board were journalled
`invalid` by the T-116 project-attribution audit on 2026-10-04: they aggregate sessions
belonging to a different local project. The originals stay queryable, but they are not
evidence of this board's work. Six review tasks — T-049, T-058, T-076, T-077, T-084,
T-096 — have **no other receipt at all**, so for those the delivery evidence is the
code, the commits and the review artifacts, never the receipt. (T-069 and the five
October tasks T-111–T-114, T-136 were never touched by the scan.)

**2. Neither `pending` nor `approved` is a verdict on this cohort.** The 109
`acceptance.imported` events were written on 2026-10-05 by the T-120 adoption pass,
and the import does not merely create criteria — it pins each observed Markdown `[x]`
as `state: "approved"` with `source: "import-observed"`, `approvedBy` set to the
importing actor and **no evidence attached**. Every approved criterion on every task
triaged here is of that kind: T-049 (17 of 18), T-058 (4 of 5), T-094 (4/4), T-112
(6/6), T-113 (6/6), T-114 (4/4) and E-014 (4/4) were all stamped by
`traycer-t120-adoption` at 2026-10-05T08:15, zero evidence fields. The real
`acceptance.approved` events on this board (73 of them) belong to T-120 and to the
E-017/E-018 tasks the operator closed on 2026-10-09, 10-10 and 10-14 — all already
`done`.

So on this cohort `pending` usually means "nobody approved anything after the bulk
reopen", and `approved` means "a checkbox was observed in Markdown". Neither settles
whether the work is good. Every row below was therefore judged against code, commits
and review artifacts, and **every "approve" proposal still needs a real
`task acceptance approve` by the operator** — including the rows whose criteria already
read as approved.

## Review column (27 rows)

`evidence` cites what was actually checked. Commit SHAs are on `e-017/integration`
unless stated. "Traycer artifact" means an independent-review artifact held in the
epic outside this repo.

| id | state | proposal | reason | evidence checked | publish? |
| --- | --- | --- | --- | --- | --- |
| T-049 | review | approve | External store shipped and is the live authority of this very board. Of 18 criteria, 17 read approved (by import — see above) and 1 is `pending`: the automatic `export` at wave-end/epic-end. That one is **reversed by the current direction** — T-154 makes export opt-in, so an automatic trigger is no longer wanted. It needs `task acceptance revise`, not more work. | `3367ef6`; store is the live authority (`plansAuthority = "store"`, 172 tasks read from it here); `mapctx export --reason`, `store repair`, `store init` all in CLI help; criterion text and the author's own "**Partial**" note in `task acceptance show T-049` | yes |
| T-057 | review | approve | All five criteria have concrete delivery. Follow-up, not a blocker: the `mapcs` deprecation shipped before 0.3.0 and the bin is still published at 0.3.1, so the promised "one release cycle" has elapsed and removal is due. | `packages/sync-engine/src/cli.ts:50,80` (deprecation notice); `skills/mapctx-traycer` exists; `skills/README.md:32` drops the runner/evaluator/transcript/session ownership claim; `packages/sync-engine/src/github.ts:179-202` (pagination); `config.ts:141` `resolveGithubSourceMode`; `docs/gh-jq-vs-mcp.md`; `packages/sync-engine/package.json:17` still exposes `mapcs` | yes |
| T-058 | review | approve | Walking skeleton proved the dispatch path. Its one `pending` criterion ("`RunReceipt` returns and updates store status") was honestly reported as not passing and tracked as **T-060, which is done** — the gap is closed by a later task, not open. | `b96337e` (`packages/adapter-traycer`); `task show T-060` = done; `t058-walking-skeleton` Traycer artifact; receipts are persisted today — 135 `run.receipt-recorded` events, `run_receipt_projection` populated | **sanitize** |
| T-065 | review | approve | Workload-aware, unit-honest prior delivered as data with its derivation written down. One criterion (`expert-guess → historical-baseline` transition) is covered by code and tests but has never been exercised live — the store holds **0** `estimate_snapshot` rows. Worth saying out loud at approval; not worth reopening. | `packages/forecast/src/prior.ts:1-30` (table declared as data, derivation documented); `estimate.ts:27` workload prior; `estimate.ts:104` `estimationErrorByPlannedWorkload`; `format.ts`; `726ca50`, `455221e`; store: `estimate_snapshot_projection` = 0 rows | yes |
| T-067 | review | **work remaining** | README documents `plansAuthority` and the cutover, but the summary also promised the write path and `task create`, `task move`, `task update` and `dispatch create` are absent from it. Small doc delta, then approve. | `README.md:19` (plansAuthority); README mentions `task start/finish/search/acceptance` and `dispatch receipt` only — grep for `task create`/`task move`/`task update`/`dispatch create` returns nothing | yes |
| T-068 | review | approve | Both skills were aligned to the CLI write path. | `skills/mapctx-tasks/SKILL.md` and `skills/mapctx-traycer/SKILL.md` both cover `task create/move/update/claim/finish/reopen`; `mapctx-traycer` additionally covers `task start` and `dispatch create/receipt`; `0b2f2e5` | yes |
| T-069 | review | approve | The pre-cutover framing the task was filed against is gone from the docs site. | `docs/index.html` has zero occurrences of `TASKS.md`, "source of truth" or `mapcs`, and its headings read "One live authority"; `9d606c8`, `455221e` | yes |
| T-070 | review | approve | Budget shipped with money/time, consumption and rollup. `value_estimated`/`value_realized` were **decided out of scope**, recorded in the task's own prose on 2026-09-08, so their absence is the decision, not a gap. | `mapctx budget set/status/history`, `account add/bind`, `plan-period record` in CLI help; `5ab6d33`, `340936d`; resolution recorded in `tasks/T-070.md` description; `budget_projection` = 0 rows (unused, not missing) | yes |
| T-071 | review | approve | Planned-vs-discovered re-attribution shipped, and the skill teaches the mid-flight re-classification. | `cb1c23d`, `852ea96`; `packages/forecast/src/estimate.ts:82-104`; `packages/store/.../workload-delta`; `t071-workload-delta` Traycer artifact | yes |
| T-072 | review | approve | Six P1 integrity findings fixed and merged; adversarial review artifact exists. | `18723b5`, `26cd649`, `178d5a2`; `pr1-adversarial-review`, `t072-independent-integrity-review`, `t072-integrity-decisions` Traycer artifacts | **sanitize** |
| T-073 | review | approve | Ten P2 findings closed with a follow-up round on the review of the fix itself. | `0902712`, `dd66135`, `53ee886`; `t073-review` Traycer artifact | **sanitize** |
| T-074 | review | approve | Release shipped and then superseded: the task asked for the vNext publish, and the repo is past it at 0.3.1 with a CI publish workflow. | `8ecfbcb`, `6d3b828`, `ef0b4cf`; `packages/sync-engine/package.json` = 0.3.1; `docs/releases/`; `ea6a52e` records the verified 0.3.1 publication | yes |
| T-075 | review | approve | P3 hardening on top of T-073 landed. | `692bcb2`, `3c974c3`, `43f7a95`; `t075-review` Traycer artifact | yes |
| T-076 | review | approve | `mapctx push` reads store projections and never `TASKS.md` — the R13 goal is met. The "fail closed on drift" half was **replaced by a better mechanism**: mirrors are not consulted at all, so there is nothing to drift against. State that at approval rather than treating it as an unmet promise. | `f8dfafd`; CLI help for `push`: "reads canonical task projections from the SQLite store (never TASKS.md) … local mirrors are not consulted (there is no snapshot-drift gate)" | yes |
| T-077 | review | **work remaining** | Not delivered. The field exists end to end in the schema and the forecast reader, but nothing populates it: **0 of 203** dispatches in the live store carry an `executor_model`, including the dispatch this very task created. Also mis-parented — this is forecast/telemetry work, not GitHub push (E-013). | store: `SELECT count(*) FROM dispatch_projection WHERE executor_model IS NOT NULL` = 0, total 203; `dispatch_projection.executor_model` column exists; `packages/forecast/src/store.ts`, `model-tier.ts` read it; `mapctx dispatch create`/`task start` expose no model flag; no commit in any branch names T-077 | yes |
| T-078 | review | approve | Long-range timeline with the three scales shipped. | `packages/sync-engine/src/workspace-ui/workspaceV2.js:818` `roadmap-scale-toggle` (aria-label "Timeline scale"), `:1376`, `:1429`, `:1585` `renderScaleTicks` for day/week/month | yes |
| T-083 | review | approve | `task search` shipped and is the duplicate-check entry point the agent rules depend on. | `mapctx task search --query` in CLI help with the documented ranking; `packages/sync-engine/src/mapctx-cli.ts` + `mapctx-cli.test.ts` | yes |
| T-084 | review | **work remaining** | Nothing was built. Its only receipt is an invalidated `history-scan` one, and the financial view does not exist. It is also effectively blocked: the T-135 spike proved there is no cost data to display. Keep it in E-015 and do not approve. | `workspaceV2.js` contains **zero** occurrences of `budget`; 8 criteria pending; no commit in any branch names T-084; store: `cost_event_projection` = 0, `budget_projection` = 0 | yes |
| T-090 | review | approve | `archived` shipped as a terminal status across protocol, store, CLI, parser and UI. Its `review` state is an artefact of the feature being tested on the live board (see above). | `2bcd0b7`; `archived` documented in `task move`/`task reopen` CLI help; `workspaceV2.js` handles `archived` at `:85,:237,:240,:277,:312,:1318`; T-092 is the live `archived` row | yes |
| T-094 | review | approve | Store-backed kanban shipped: the board dataset this triage read came through that path. Its 4 criteria read approved, by import only. | `f8dfafd`; `mapctx board` help documents the store path under store authority; `mapctx board --json` returns 172 store tasks under `plansAuthority = "store"` | yes |
| T-095 | review | approve | Bare `mapctx` opens the workspace and the stale-target healing shipped. | CLI help: "mapctx (no command) Opens the workspace UI … Focuses the running UI if it is already up"; the stale `mapctx-t102-roadmap` target removal is recorded in T-112's approved criteria | yes |
| T-096 | review | **work remaining** | Partial at best, and the part that matters is missing. Usage ingestion exists but has produced **7** rows, and the derived shadow cost — the task's actual point — produced **0**. The T-135 spike reached the same conclusion independently. | store: `usage_event_projection` = 7, `cost_event_projection` = 0; `docs/engineering/github-projects-spike.md` ("cost real/estimated = 0 because the store has no cost data"); acceptance absent; no commit names T-096 | yes |
| T-111 | review | approve | Wave header period and progress bar shipped with the accessible label and the no-dates fallback. | `workspaceV2.js:1734` (`'sem datas'` fallback), `:1788` `renderWaveRangeBar`, `:1795-1797` progressbar with `aria-valuenow` and label | yes |
| T-112 | review | approve | Synthetic scheduling for history-less done tasks shipped, including the dashed/approximate distinction its criteria describe. | `packages/sync-engine/src/gantt.ts`, `gantt.test.ts`, `workspace-ui/workspaceV2.js` and `test/workspaceV2.roadmap.test.cjs` all carry `synthetic-schedule`; criteria read 6/6 approved by import | yes |
| T-113 | review | approve | Both halves shipped and are checkable line by line: per-target counts read from the store behind an mtime cache with a null (never false-zero) fallback, and the epic-group period bar. | `workspace-server.ts:498-520` `targetCountCache` keyed on `TASKS.md` mtime, `:67` `taskCount: number \| null`; `workspaceV2.js:499` renders `unknown task count` when null, `:1765` `epicRangeForTasks`, `:1806` `group-range-bar` with `role="progressbar"` and aria label; criteria read 6/6 approved by import | **sanitize** |
| T-114 | review | approve | The previous stale-review audit did its job honestly, and the board still shows it: the four epics it audited are `done`, and the five paused tasks it refused to fake-cancel are still `backlog` under E-016. This task is the precedent T-149 follows. | `tasks/T-114.md` carries the audit prose (51 lines), including the refusal to cancel real scope to flatter a metric; E-001/E-002/E-004/E-005 = done; T-016/T-017/T-021/T-031/T-034 = backlog; criteria read 4/4 approved by import | yes |
| T-136 | review | approve | `task update --description/--description-file` shipped with tests, and this triage used the feature. **Lineage flag:** it was committed to `main` (`54321e7`, now `main`'s head) and is **not** in `e-017/integration`. The pending criteria predate that commit. | `main` head `54321e7`; the prebuilt CLI from `main` (built 2026-10-13) exposes `--description/--description-file` in `task update` help with the "any planning state including done/archived" semantics; no T-136 commit is an ancestor of `e-017/integration` | yes |

### Not triaged, accounted for

| id | state | why not triaged |
| --- | --- | --- |
| T-133 | review | Entered review during T-149. Live E-017 work (planner violation dedupe) awaiting the orchestrator's review and integration. |
| T-139 | review | Entered review during T-149. Live E-018 work (`TaskProvider` + `LocalStoreProvider`) and the prerequisite of T-150/T-151 — awaiting review and integration. |

## Paused column (19 rows)

No paused task has a single run receipt. Sixteen of the nineteen carry 2–3 `history-scan`
dispatches with zero receipts; E-003, E-006 and T-045 have no dispatch at all. There is
no hidden work to rescue here — these are dispositions, not audits.

`cancel` is used where the work was aborted because something concrete replaced it;
`archive` where the need is gone or was met outside MapCtx and nothing replaces it.
That matches the CLI's own definitions ("cancelled means the work was aborted; archived
means it will not proceed").

| id | state | proposal | reason | evidence checked | publish? |
| --- | --- | --- | --- | --- | --- |
| T-001 | paused | archive | Its subject no longer exists. The task hardens the OpenCode plugin build/install flow, and `packages/opencode-plugin/` — its only `filesAffected` entry — was deleted when the 0.3.0 CLI shipped. | `git log --diff-filter=D -- 'packages/opencode-plugin/*'` → `6002f19`; `packages/` now holds adapter-traycer, core, forecast, planner, protocol, store, sync-engine; 0 receipts | yes |
| T-002 | paused | cancel | Premise contradicts the current architecture. It stores the task log timeline in GitHub issue comments; under ADR 0003/0005 the append-only journal is the store's and is explicitly **not** mirrored — the mirror carries issues, Status and derived fields only. | `tasks/T-002.md` acceptance ("GitHub comments publish idempotently"); ADR 0003; T-152 summary (issues, sub-issues, blocked-by, Status, derived fields — no comment stream); 0 receipts | yes |
| T-003 | paused | cancel | Already delivered elsewhere. `iteration` and `assignees` are live fields of the task projection and patchable today, which is all the task asked for. | `mapctx task update` whitelist in CLI help includes `assignees,iteration,milestone`; `mapctx board --json` emits `assignees` per task; 0 receipts | yes |
| T-004 | paused | cancel — **folds into T-150** | Same scope, newer owner. Reading sub-issue progress over the Projects GraphQL API is exactly T-150's adapter, which also reads `blocked by` and Project fields and must pass T-139's contract suite. | `task show T-150` summary; `docs/engineering/github-projects-spike.md` already exercised the dependency/sub-issue read path; 0 receipts | yes |
| T-005 | paused | cancel | Superseded. It adds migration docs and regression coverage for the `iteration`/`assignees` pair; the store's field set is now covered by T-049's lossless round-trip property tests plus golden fixtures, and the migration story is ADR 0003/0004. | T-049 approved criteria on round-trip losslessness; `docs/adr/0003`, `0004`; 0 receipts | yes |
| T-043 | paused | cancel | Half done by the cutover, half owned by T-153. The Project date field IDs are already configured, and the config file this task names was deleted at cutover. Live validation on a real Project is T-153's job, under explicit operator approval of the dry run. | `mapctx.toml [github]` carries `startDateFieldId`, `dueDateFieldId`, `completedDateFieldId` (and `verified = false`); `mapcs.config.json` is gone — T-049's criterion deletes it in the cutover commit; `task show T-153`; 0 receipts | yes |
| T-045 | paused | cancel — **folds into T-152** | Same scope, newer owner, plus an open design question. T-152 writes derived fields in batch; whether `workload`/`domains` become provider fields is the ADR 0005 open question, so it is a decision, not a task. | `task show T-152` summary; ADR 0005 open question on workload/domains; `docs/engineering/github-projects-spike.md` measured the 36-custom-field ceiling; 0 receipts | yes |
| T-046 | paused | cancel — **folds into T-152** | Its regression coverage belongs to the mirror that will own the write path. Keeping a separate test task for a sync path that T-155 retires is pure overhead. | `task show T-152`, `task show T-155`; 0 receipts | yes |
| E-003 | paused | archive | The need was met outside MapCtx. An isolated generator/evaluator loop is exactly how this epic's own work is now executed — an implementing child agent plus an independent reviewer agent with no shared context — provided by the harness, not by MapCtx skills. Nothing in MapCtx should re-implement it. | The E-017 flow in practice: separate reviewer agents per task, verdicts in per-attempt review artifacts, `docs/reviews/`; `skills/mapctx-ralph-tasks/` (the epic's target) is untouched since the pause; 0 receipts | yes |
| T-022 | paused | archive | Child of E-003: the generator→evaluator handoff bundle. Superseded by the same harness capability. | parent E-003; 0 receipts | yes |
| T-023 | paused | archive | Child of E-003 and the blocker of T-024/T-025/T-026/T-038/T-040. Superseded with its parent. | parent E-003; `blocking` list in `task show T-023`; 0 receipts | yes |
| T-024 | paused | archive | Child of E-003: optional parallel evaluator mode. Superseded with its parent. | parent E-003; 0 receipts | yes |
| T-025 | paused | archive | Child of E-003: verdict model and status transitions. MapCtx already has a stricter mechanism — the store's acceptance criteria and the `done` gate. | parent E-003; `mapctx task acceptance`, `task finish` gate in CLI help; 0 receipts | yes |
| T-026 | paused | archive | Child of E-003: regression coverage for a flow that will not be built. | parent E-003; 0 receipts | yes |
| E-006 | paused | archive | Partly delivered, remainder superseded. Two of its five children are already `done` (T-036, T-039); of the rest, waves are now `mapctx plan` and status reporting is `mapctx board` plus the workspace UI. Archiving records that it will not proceed without touching the delivered children. | `task_projection` children: T-036 done, T-039 done, T-037/T-038/T-040 paused; `mapctx plan` produces dependency waves; 0 receipts | yes |
| T-037 | paused | archive | `mapctx-sprint-status` is covered by shipped surfaces: counts and blockers from `mapctx board --json` and the workspace UI, next runnable tasks from `mapctx plan`. | CLI help for `board`/`plan`; `workspaceV2` kanban and roadmap; 0 receipts | yes |
| T-038 | paused | archive | `mapctx-next` depends on T-023, which is archived here, and its "next action" inference is what `mapctx plan` waves already answer. | `prerequisites: T-023,T-037`; `mapctx plan`; 0 receipts | yes |
| T-040 | paused | archive | Wave execution was delivered by the planner, not by this task: `mapctx plan` emits dependency waves with serialization and advisories, hardened twice since (T-125, T-132). | `mapctx plan --json`; `packages/planner`; T-125 and T-132 both done; 0 receipts | yes |
| E-007 | paused | archive | Explicitly a "future" exploration whose first criterion is "user need is revalidated". It never was, in five months, and it is the only `impact: low` epic on the board. On a public board it advertises a roadmap item nobody intends to build. | `task show E-007` (`impact: low`, `role: future`, criteria unapproved); no commit or receipt references it | yes |

## Test rows (3)

| id | state | proposal | reason | evidence checked | publish? |
| --- | --- | --- | --- | --- | --- |
| T-103 | backlog | archive | CLI smoke-test leftover: title "Test Task", no workload, no effort, no acceptance, no dependency, no dispatch. Not claimable as it stands (executable tasks need workload and effort). | `task show T-103`; created 2026-10-01; store: no dispatch rows | **no** |
| T-104 | backlog | archive | Same, "Test Task 2" — and with no `updatedOn` at all. | `task show T-104`; no dispatch rows | **no** |
| T-105 | backlog | archive | Same, "Test Task 3". | `task show T-105`; no dispatch rows | **no** |

Archiving is not enough on its own: `mapctx.toml [github.statusMap]` maps `archived`
to an "Archived" column, so an archived task is still a published task. These three
need to be out of the mirror's scope as well — see decision 7.

## Open epics (4 remaining)

E-003, E-006 and E-007 are in the paused table above.

| id | state | proposal | reason | evidence checked | publish? |
| --- | --- | --- | --- | --- | --- |
| E-013 | backlog | close as dependent | Both children are triaged here: T-076 is approvable and T-077 was never delivered and does not belong to a GitHub-push epic. Re-parent T-077 to the forecast/telemetry line, approve T-076, and E-013 has nothing left. | children T-076 (review), T-077 (review); T-076 and T-077 rows above | yes |
| E-014 | doing | keep as is | Correctly open: six of its 13 children are still open (T-110, T-117 backlog; T-111–T-114 review). **Flag:** its 4 criteria read as fully approved and every one of them cites T-099–T-102 only — the children added later are not mentioned, and the approvals came from the import pass. Closing this epic on those criteria would close it with six open children on checkbox observations. Revise the criteria before any `finish`. | `task acceptance show E-014` = 4/4, all citing T-099/T-100/T-101/T-102, all stamped `traycer-t120-adoption` 2026-10-05, no evidence; children: T-099/100/101/102/116/118/119 done, T-110/T-117 backlog, T-111/112/113/114 review | yes |
| E-015 | backlog | keep as is | Correctly open and honestly blocked, not stalled. All four criteria are pending and every child is unfinished (T-084 and T-096 reopened for work here, T-097/T-098 backlog). The blocker is upstream: there is no cost data to report on. | `task acceptance show E-015` 0/4; store: `cost_event_projection` = 0, `usage_event_projection` = 7; `docs/engineering/github-projects-spike.md` | yes |
| E-016 | backlog | keep as is | The parking lot for the surviving v3 carryover — the same five tasks T-114's audit refused to fake-cancel, filed the same day as that audit, plus T-115. It is doing its job: six backlog children and no false progress. | children T-016, T-017, T-021, T-031, T-034, T-115, all backlog; E-016 and T-114 both last touched 2026-10-02; `tasks/T-114.md` names those five tasks | yes |

## Old sync tasks vs. the new adapter

The nine rows the roadmap flagged as potentially obsolete, mapped to what replaces them.

| Old row | State | Replaced by | What actually replaces it | Proposal |
| --- | --- | --- | --- | --- |
| T-001 | paused | — (nothing) | Target package deleted at 0.3.0; no successor is planned. | archive |
| T-002 | paused | — (by decision) | The journal stays in the store; the mirror never carries a comment stream (ADR 0003/0005). | cancel |
| T-003 | paused | shipped already | `iteration`/`assignees` are live task-projection fields. | cancel |
| T-004 | paused | **T-150** | Read adapter behind `TaskProvider`: issues, sub-issues, `blocked by`, Project fields, Status. | cancel |
| T-005 | paused | **T-049** + ADR 0003/0004 | Round-trip losslessness tests and the documented migration/cutover. | cancel |
| T-043 | paused | config + **T-153** | Date field IDs already in `mapctx.toml`; the live run with an approved dry run is T-153. | cancel |
| T-045 | paused | **T-152** (+ ADR decision) | Batched derived-field writer; whether `workload`/`domains` ship as provider fields is the open ADR 0005 question. | cancel |
| T-046 | paused | **T-152** | Tests belong to the mirror that owns the write path. | cancel |
| E-013 / T-076 | backlog / review | **T-152**, then **T-155** | T-076 already closed the last Markdown reader (`push` reads the store only). `mapctx github mirror` supersedes `push` as the write path, and T-155 flips authority. | approve T-076; close E-013 |

T-044 (`done`) is the prerequisite of T-045/T-046 and stays as it is — its delivery is
real, it is simply superseded as a write path.

One consequence worth stating before the mirror runs: after T-152 lands, `mapctx push`
and `mapctx github mirror` are two write paths into the same Project. Retiring `push`
is T-155's business, but nothing on the board says so yet.

## What must not be published, and what needs sanitizing

Sensitive content is **named by category only** below — nothing sensitive is reproduced
in this document. The sweep itself is T-151's scope; this is the triage input to it.

**Do not publish (3):** T-103, T-104, T-105 — test rows with no content. Archiving them
does not remove them from the mirror, because `archived` has a mapped column.

**Sanitize before publishing (4):**

| id | What is in the description | Why it matters |
| --- | --- | --- |
| T-058 | An absolute path on the operator's machine, embedded in a Markdown link, carrying an internal epic identifier | Discloses the local filesystem layout and an internal id, and the link is dead for every public reader |
| T-072 | Same pattern: a machine-local absolute path plus an internal epic identifier | Same |
| T-073 | Same pattern | Same |
| T-113 | The name of a **different organization/project** of the operator's, in the prose **and inside an approved acceptance criterion** | A third party's name has no business on this board's public issues. The prose is Git-authored and editable with `task update --description`; the criterion is store-owned, so changing it needs `mapctx task acceptance revise` plus re-approval — a board change, hence decision 6 |

`~/.mapctx`, `~/.claude` and similar tool paths appear in T-049, T-070 and T-096 and are
**not** flagged: they are generic, documented in the public README, and reveal nothing
about this machine.

**Outside this triage, same defect, for T-151's sweep.** The same pattern (machine-local
absolute paths and/or internal identifiers in the description) appears on 15 further
tasks: T-064, T-066, T-106, T-107, T-108, T-119, T-121, T-123, T-124, T-125, T-126,
T-127, T-128, T-129, T-138 — and on E-017. T-121 and T-125 additionally carry the
third-party name flagged on T-113, as does E-017. T-151's own description carries the
pattern it exists to remove.

**Already public, and not fixable by sanitizing the board.** `docs/reviews/` is committed
in this repo and carries internal dispatch identifiers, and the invalidation reasons
recorded by the T-116 audit name another local project path. The T-135 author reported
the same thing. Sanitizing task descriptions does not reach committed history — that is
a separate decision (decision 8), not a gap in T-151.

## Decisions the operator has to make

Everything above is a proposal. None of it is applied. These eight cannot be settled from
evidence, because they are judgement calls, contract changes, or both.

1. **Was the 2026-09-23 bulk reopen intentional?** The triage of 15 rows rests on reading
   it as board maintenance rather than a quality finding. If those tasks were reopened for
   a reason that was never written down, the 15 "approve" proposals are void and that
   reason has to be recorded first.
2. **What imported approvals are worth.** 45 criteria across the triaged rows read
   `approved` purely because `acceptance import` observed an `[x]` in Markdown — same
   actor, same minute, no evidence. Either accept that as sufficient and approve on it,
   or re-approve those rows deliberately with evidence. Publishing a board whose
   "approved" marks mean "a checkbox was once ticked" undercuts the one thing MapCtx
   claims over a plain tracker. The same question decides whether `acceptance import`
   should ever write `approved` rather than `pending`.
3. **T-049's obsolete criterion.** Approving T-049 requires `task acceptance revise` to
   retire the automatic-export criterion that T-154 reverses. Alternative: leave T-049
   open until T-154 lands, and approve both together.
4. **T-058 and T-076: approve on a changed mechanism.** Both have a criterion that was
   not met as written but was superseded — by T-060 (done) and by "mirrors are never
   consulted" respectively. Approving means accepting the substitution on the record, the
   same way T-135's partials were accepted.
5. **T-065's unexercised criterion.** The prior-to-baseline transition has code and tests
   but zero live evidence (0 estimate snapshots). Approve with the limitation noted, or
   hold T-065 until the board produces a calibration.
6. **T-113's acceptance criterion names a third party.** Rewording a store-owned,
   already-approved criterion means `task acceptance revise` plus re-approval. The
   alternative is excluding T-113 from the mirror.
7. **How does the mirror treat `archived` and `cancelled`?** `[github.statusMap]` maps
   `archived`; `cancelled` is unmapped. If the 15 archive proposals are applied and the
   mirror publishes archived rows, the public board gains 15 dead rows plus 3 test rows.
   T-152 needs an explicit scope rule, and it has none today.
8. **Already-committed internal identifiers in `docs/reviews/`.** Out of T-151's reach.
   Options: leave them (they are dispatch UUIDs and one foreign path, no credentials),
   redact the files going forward, or rewrite history. No task owns this.

Two further observations, outside this task's scope, that the operator should know:

- **T-136 lineage.** T-136 is on `main` (`54321e7`) and not on `e-017/integration`. The
  planned merge of `e-017/integration` into `main` will meet it there; the prebuilt CLI
  used for every read in this triage already includes it.
- **The live store is at migration 11.** `schema_migrations` records 11 applied on
  2026-10-13. The E-017 orchestration notes still warn that running an integration-built
  CLI would migrate the real store from v10 — that warning is out of date, and the
  reason the migration was applied is not recorded anywhere this task could read.
