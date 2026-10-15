#!/usr/bin/env node
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureWorkspaceRegistry,
  readWorkspaceRegistry,
  resolveWorkspaceTargetTasksFile,
  targetId,
  writeWorkspaceRegistry,
  type WorkspaceRegistry
} from '@mapctx/core/workspace';
import { generateTaskDetailFile, parseAcceptanceChecklist, parseBareAcceptanceChecklist, parseTaskDetailFile, parseTasksFile, readTaskDetailFile, replaceTaskDetailDescription } from '@mapctx/core';
import {
  ABSOLUTE_LEASE_CEILING_MS,
  buildExport,
  claimTask,
  startTask,
  diffTaskForReconcile,
  importCommit,
  importDryRun,
  isStoreMaterialized,
  moveTask,
  newDispatchId,
  createTask,
  reconcileAccept,
  reconcileDiscard,
  recoverStoreFromCheckpoint,
  releaseClaim,
  recordDispatchAttempt,
  recordRunReceipt,
  listClaimViolations,
  listDispatchAttempts,
  listRunEvents,
  recordRunEvent,
  listEstimateSnapshots,
  listInvalidatedReceiptKeys,
  listReceiptsForDispatch,
  listReceiptsForTask,
  renewClaim,
  reopenTask,
  resolveCoordinationSettings,
  resolveMapctxToml,
  resolveProjectStoreDir,
  repairStore,
  attestationContentSha256,
  commitNodeAttestation,
  draftNodeAttestation,
  redactEvidence,
  listRedactionCandidates,
  lintForPrivacy,
  REDACTABLE_ROOTS,
  isRedactableFieldPath,
  StoreHandle,
  queryTask,
  queryTaskFromMarkdown,
  queryTaskContext,
  queryTaskContextFromMarkdown,
  searchTasks,
  filterTaskSearchHits,
  getSingleProject,
  getTask,
  getTaskDetail,
  renderStoreDescription,
  toPlanningState,
  updateTask,
  listDependencies,
  listTasks,
  validateStoreRegime,
  type DisclosableClaimRecord,
  applyValidationGate,
  buildValidationBaseline,
  parseValidationBaseline,
  type ValidationBaselineFile,
  type ValidationGateIssue,
  type ValidationGateResult,
  checkStoreSnapshots,
  planAcceptanceImport,
  commitAcceptanceImport,
  parseAcceptanceRead,
  reviseAcceptance,
  approveAcceptanceCriteria,
  unapproveAcceptanceCriterion,
  getAcceptance,
  getLiveActiveClaim,
  checkTaskAcceptance,
  type CoordinationSettings,
  type MapctxTomlConfig
} from '@mapctx/store';
import { CHECKPOINT_REASONS, finishTask, publishCheckpoint, type CheckpointReason, type FinishSnapshotMode } from './checkpoint';
import { getValidationReport, printValidationReport } from './board-tools';
import { historyCorrectCommand, historyReconstructCommand, historyScanCommand } from './history-cli';
import { loadConfigOptionalForBoard } from './config';
import { accountAddCommand, accountBindCommand, accountListCommand, budgetHistoryCommand, budgetSetCommand, budgetStatusCommand, planPeriodRecordCommand } from './budget-cli';
import { buildGanttDataset, type GanttHistoryDate } from './gantt';
import { extractClaudeIntervals, type OtherSessionActivity, type Workload } from '@mapctx/forecast';
import { LIVENESS_RUN_EVENT_TYPES, isLivenessRunEventType, parseEstimatedEffortMs, planningStateSchema, prioritySchema, specModeSchema, taskTypeSchema, workloadSchema } from '@mapctx/protocol';
import { pushStoreCommand } from './push-store';
import { SyncOptions } from './types';
import { detectWorkspaceModel, deriveSubIssueProgress, toWorkspaceTaskView, toWorkspaceTaskViewFromStoreRecord } from './board-view';
import { parseWorkspaceServerArgs, startWorkspaceServer } from './workspace-server';

type MapctxOptions = SyncOptions & {
  commit?: boolean;
  actor?: string;
  claimId?: string;
  leaseToken?: string;
  /** T-142: the renew-only capability (`--renew-token`). */
  renewToken?: string;
  /** T-142: `task renew --dispatch <id>`, a lookup for the task's active claim. */
  dispatch?: string;
  lease?: string;
  holder?: string;
  reason?: CheckpointReason;
  reconcileMode?: 'accept' | 'discard';
  receiptPath?: string;
  claudeTranscriptPath?: string;
  otherSessionActivityPath?: string;
  idleThresholdMs?: number;
  reviewThresholdMs?: number;
  parkedThresholdMs?: number;
  timeZone?: string;
  readReceipt?: boolean;
  budget?: number;
  status?: string;
  setPairs?: string[];
  dependsOn?: string;
  blocking?: string;
  dispatchId?: string;
  id?: string;
  executor?: string;
  contextHash?: string;
  title?: string;
  type?: string;
  parent?: string;
  priority?: string;
  workload?: string;
  tags?: string;
  domains?: string;
  start?: string;
  due?: string;
  role?: string;
  impact?: string;
  effort?: string;
  summary?: string;
  description?: string;
  descriptionFile?: string;
  currency?: string;
  amount?: string;
  minutes?: number;
  note?: string;
  account?: string;
  query?: string;
  limit?: number;
  codexSessions?: string;
  opencodeDb?: string;
  claudeDir?: string;
  repo?: string;
  taskFilter?: string;
  approvePath?: string;
  emitApprovalPath?: string;
  includeInferred?: boolean;
  target?: string;
  correctionReason?: string;
  planName?: string;
  seats?: number;
  end?: string;
  project?: boolean;
  remove?: boolean;
  waitReason?: "review" | "decision" | "parked" | "blocked-external";
  /** T-119 store attest-orphan */
  approveHash?: string;
  attestationReason?: string;
  attestationReasonFile?: string;
  evidencePairs?: string[];
  snapshots?: boolean;
  fromFile?: string;
  expectRevision?: number;
  criterionId?: string;
  /** T-129: a comma list of zero-based positions, not a single index. */
  indices?: number[];
  /** T-129 acceptance palliative */
  acceptanceFile?: string;
  expectTitle?: string;
  all?: boolean;
  /** T-126 redact */
  nodeId?: string;
  /**
   * Shared by `redact` (a journal event's sequence, 1-based) and `run event`
   * (a run event's sequence within one attempt, 0-based per `runEventSchema`).
   * The parser therefore accepts any non-negative integer and each command
   * enforces its own floor -- `redact` by name, below.
   */
  sequence?: number;
  field?: string;
  /** T-143 run event */
  attempt?: number;
  payload?: string;
  /** T-127 validate gate */
  baselinePath?: string;
  writeBaselinePath?: string;
  /** T-128 finish snapshot mode */
  snapshot?: FinishSnapshotMode;
};

/**
 * T-127 (R4): the enumerated values. The reported friction was `--workload
 * Medium` being refused by a help text that never said what the four legal
 * values are.
 *
 * Rows marked `schema: true` are read off the protocol schema the validators
 * use, so they cannot drift. The rest have no schema to read and are written
 * by hand -- review A13 caught exactly that kind of drift here (`--reason`
 * was missing `task-end`), so the distinction is printed, not assumed.
 */
const ENUM_HELP: Array<{ flag: string; values: string; schema?: true }> = [
  { flag: '--workload', values: workloadSchema.options.join('|'), schema: true },
  { flag: '--priority', values: prioritySchema.options.join('|'), schema: true },
  { flag: '--type', values: taskTypeSchema.options.join('|'), schema: true },
  { flag: '--status (canonical)', values: planningStateSchema.options.join('|'), schema: true },
  { flag: '--set specMode', values: specModeSchema.options.join('|'), schema: true },
  { flag: '--status (board spelling)', values: 'backlog|ready-for-do|doing|review|done|paused|cancelled|archived' },
  { flag: '--set waitReason / --wait-reason', values: 'review|decision|parked|blocked-external (or null to clear)' },
  { flag: '--effort, --set detail.estimatedEffort', values: 'positive m|h|d|w duration (90m, 6h, 1d, 2w); agent ACTIVE time, 1d=8h, 1w=40h' },
  { flag: '--set predictedStart', values: 'null, or JSON {"start":"YYYY-MM-DD","method":"manual|heuristic|model","confidence":"low|medium|high"}' },
  { flag: 'run event --type', values: LIVENESS_RUN_EVENT_TYPES.join('|'), schema: true },
  { flag: '--executor', values: 'free text naming the runner (traycer, claude, codex, ...)' },
  { flag: '--reason (export)', values: CHECKPOINT_REASONS.join('|'), schema: true },
  {
    flag: 'list values (--tags, --domains, --depends-on, --blocking, --task, --set of a list field)',
    values: 'bare `a,b,c` or a JSON array `["a","b"]`. `[a,b]` is refused; a value that itself contains brackets needs the JSON spelling; no element may contain a comma or a split `{...}` group (the snapshots cannot represent it)'
  },
  { flag: '--index (acceptance approve)', values: 'zero-based position, or a list: 0,2,5 -- `--all` covers every pending criterion' },
  { flag: '--set externalLinks', values: 'list of URIs: https://host/... (http too), or provider:entity:id. javascript/data/file/vbscript/blob are refused' }
];

function printEnumHelp(): void {
  console.log('');
  console.log('Enumerated values:');
  // Column width comes from the labels that FIT it, so one long label does not
  // push every value 90 columns to the right; the long ones get their own line.
  const COLUMN_LIMIT = 38;
  const fitting = ENUM_HELP.map(entry => entry.flag.length).filter(length => length <= COLUMN_LIMIT);
  const width = fitting.length > 0 ? Math.max(...fitting) : COLUMN_LIMIT;
  for (const { flag, values, schema } of ENUM_HELP) {
    const marked = schema ? `${flag} *` : flag;
    if (marked.length > width) {
      console.log(`  ${marked}`);
      console.log(`  ${' '.repeat(width)}  ${values}`);
    } else {
      console.log(`  ${marked.padEnd(width)}  ${values}`);
    }
  }
  console.log('');
  console.log('  * read straight off the schema the validators use, so it cannot drift. Unmarked');
  console.log('    rows have no schema to read and are maintained by hand.');
  console.log('');
  console.log('Prose vs. generated state:');
  console.log('  Under plansAuthority=store, TASKS.md and the structured field blocks of');
  console.log('  tasks/<ID>.md are GENERATED snapshots: never hand-edit them, change them through');
  console.log('  this CLI and repair drift with `mapctx reconcile <task-id>`.');
  console.log('  The `description:` block of tasks/<ID>.md is the exception: it is Git-authored');
  console.log('  prose, owned by the repository and never by the store. `task create --description`');
  console.log('  / `--description-file` seeds it; `task update <id> --description` / `--description-file`');
  console.log('  rewrites only that block of tasks/<ID>.md, in any planning state (or edit the file by');
  console.log('  hand), and you commit it. There is no `--set description`: the store never holds prose.');
  console.log('  Everything written through this CLI lands in an append-only event log: keep');
  console.log('  secrets, tokens and personal data out of titles, summaries, descriptions,');
  console.log('  evidence and receipts. Declare `[privacy] patterns` in mapctx.toml to get warned,');
  console.log('  and see `mapctx redact` for destroying a value that already landed.');
  console.log('');
  console.log('Output channels (changed in 0.4.0):');
  console.log('  stdout carries RESULTS only. A refused command -- task move/update/create/start/');
  console.log('  claim/renew/release, dispatch create/receipt, acceptance revise/approve/unapprove,');
  console.log('  acceptance import --commit, redact, export, task finish -- exits non-zero and');
  console.log('  leaves stdout EMPTY. With --json its structured refusal is the first line of');
  console.log('  stderr, as one line of compact JSON, followed by the human `Error: ...` line;');
  console.log('  read stderr\'s first line, or split it on the "\\nError:" boundary. Without --json');
  console.log('  only the `Error:` line is printed, so a holder\'s lease token is not sprayed');
  console.log('  across a terminal.');
  console.log('  Gate REPORTS are the exception and still print to stdout even when they exit');
  console.log('  non-zero, because the document is what you asked for: `mapctx validate`,');
  console.log('  `mapctx import --dry-run`, `mapctx store repair`.');
  console.log('');
  console.log('Flag values:');
  console.log('  An UNKNOWN --flag is now an error instead of being silently ignored (0.4.0,');
  console.log('  unreleased): `--no-snapshots` used to be dropped, which turned a close into a');
  console.log('  publishing one. A boolean flag written with a value keeps T-127 behaviour and is');
  console.log('  ignored, except `--no-snapshot=...`, which is refused for the same reason.');
  console.log('  A flag written without its value is refused instead of swallowing the next');
  console.log('  argument. Only a token that is itself one of this CLI\'s flags counts as');
  console.log('  missing, so `--title "--foo is a flag"` and `--summary "- item"` pass. To pass');
  console.log('  a value that IS a flag name, use `--flag=value`, e.g. `--query=--json`.');
}

/**
 * Every flag the argument parser recognizes, split by whether it consumes a
 * value. Review B8: the first version of the missing-value check tested the
 * SHAPE of the next token (`/^--[A-Za-z]/`), which made a legitimate value
 * that merely starts with `--` impossible to pass -- and since there was no
 * `--flag=value` syntax either, there was no escape at all. `--title "--foo
 * is a flag"` used to work and stopped working.
 *
 * The test is pertinence now, not shape: only a token that IS one of these
 * flags counts as a missing value. `--actor --json` is still caught; `--title
 * "--foo is a flag"` passes again.
 *
 * `mapctx-cli.test.ts` asserts these two sets cover every `a === '--flag'`
 * literal in `parseArgs`, so adding a flag without listing it here fails the
 * suite instead of silently weakening the check.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--account', '--actor', '--amount', '--approve', '--approve-hash', '--attempt', '--baseline', '--because',
  '--blocking', '--budget', '--claim', '--claude-dir', '--claude-transcript', '--codex-sessions',
  '--config', '--context-hash', '--criterion-id', '--currency', '--depends-on', '--description',
  '--description-file', '--dispatch', '--dispatch-id', '--domains', '--due', '--effort',
  '--emit-approval-template', '--end', '--evidence', '--executor', '--expect-revision', '--field',
  '--acceptance-file', '--expect-title',
  '--file', '--from-file', '--holder', '--id', '--idle-threshold-ms', '--impact', '--index',
  '--lease', '--limit', '--minutes', '--node', '--note', '--opencode-db', '--other-session-activity',
  '--parent', '--parked-threshold-ms', '--payload', '--plan-name', '--priority', '--query', '--reason',
  '--reason-file', '--receipt', '--renew-token', '--repo', '--review-threshold-ms', '--role', '--seats',
  '--sequence', '--set', '--snapshot', '--start', '--status', '--summary', '--tags', '--target', '--task',
  '--tasks-file', '--time-zone', '--title', '--token', '--type', '--wait-reason', '--workload',
  '--write-baseline'
]);

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--accept', '--all', '--commit', '--discard', '--dry-run', '--help', '--include-inferred', '--json',
  '--no-snapshot', '--project', '--read', '--remove', '--snapshots', '-h'
]);

/**
 * Flags of `mapctx workspace` / `workspace:add`, which are parsed by
 * `parseWorkspaceServerArgs` rather than by the chain below -- but `parseArgs`
 * still sees the whole argv first, so the unknown-flag rule has to know them
 * or it would reject a legitimate invocation. `scripts/verify-sync-engine-
 * package.mjs` (the `pack:smoke` CI step, which is NOT part of `npm test`)
 * runs `mapctx workspace --no-open --port <n>`, so this is load-bearing.
 */
export const WORKSPACE_FLAGS: ReadonlySet<string> = new Set([
  '--add', '--host', '--no-open', '--open', '--org', '--org-name', '--org-path', '--port',
  '--registry', '--target'
]);

export const KNOWN_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS, ...WORKSPACE_FLAGS]);

/**
 * Flags where a stray `=value` must be an error rather than be ignored.
 *
 * T-127 decided that inline values do not apply to boolean flags, so
 * `--json=true` is accepted and ignored (and a test pins that). For most
 * booleans the mistake is self-revealing -- you asked for JSON and got human
 * text. `--no-snapshot` is the one where silence costs something: being
 * ignored means the command rewrites every mirror in a shared checkout, which
 * is the exact harm the flag exists to prevent (review F1).
 */
// Review F5: `--all=true` fell through to positional and vanished, leaving a
// refusal that said "requires --all" to a caller who had written --all. Same
// shape T-128 created this set for after `--no-snapshot=true` did real damage.
const VALUE_REJECTING_FLAGS: ReadonlySet<string> = new Set(['--no-snapshot', '--all']);

function printHelp(): void {
  console.log('mapctx CLI');
  console.log('');
  console.log('Commands:');
  console.log('  mapctx (no command)');
  console.log('    Opens the workspace UI (same as: mapctx workspace). Focuses the running UI if it is already up.');
  console.log('  mapctx workspace [path] [--add path] [--org id] [--org-name name] [--org-path path] [--target target-id] [--port n] [--no-open]');
  console.log('  mapctx workspace:add <path> [--org id] [--org-name name] [--org-path path]');
  console.log('  mapctx store init [--json]');
  console.log('    Materializes the local store. If plansAuthority=store but ~/.mapctx/projects/<id>/');
  console.log('    is missing entirely (lost machine, fresh clone, unrepairable corruption), this');
  console.log('    recovers from the last git-committed TASKS.md/tasks/*.md checkpoint into a fresh');
  console.log('    incarnation. Event history, claims, and cost/usage data strictly older than that');
  console.log('    checkpoint are permanently gone -- back up ~/.mapctx/projects/<id>/mapctx.db and');
  console.log('    commit checkpoints on your own cadence if you need more than that.');
  console.log('  mapctx store repair [--json]');
  console.log('  mapctx store attest-orphan <node-id> --reason "text" [--evidence key=value ...] [--json]');
  console.log('    Drafts a T-119 attestation pinning a DB-only node\'s complete event_log rows');
  console.log('    (journal-less, verifiable payload hashes only) and prints its content sha256.');
  console.log('    Writes nothing. Re-run with --approve-hash <sha256-from-the-draft> to write');
  console.log('    node-attestations.json, which lets `mapctx store repair` replay those rows and');
  console.log('    treat the node\'s absent prefix as a declared fact instead of a gap.');
  console.log('  mapctx run event <dispatch-id> --type ' + LIVENESS_RUN_EVENT_TYPES.join('|') + ' [--attempt n] [--sequence n]');
  console.log('    [--payload \'{"key":"value"}\'] [--actor name] [--json]');
  console.log('    Records one liveness event for a dispatch and, as a by-product, renews that');
  console.log('    lane\'s claim -- addressed by dispatch id, with no token. Emit one where you');
  console.log('    already pause (after a suite, between slices) instead of interrupting yourself');
  console.log('    to run task renew. --attempt defaults to the dispatch\'s latest attempt and is');
  console.log('    refused if you name an older one; --sequence defaults to the next unused one.');
  console.log('    The event is always recorded; whether it renewed is reported separately, and it');
  console.log('    does not renew on a stale attempt, after a receipt landed, past the 24h ceiling');
  console.log('    measured from the original claim, or when the claim is gone or expired.');
  console.log('    Liveness is not work: these events are excluded from active-time measurement.');
  console.log('  mapctx redact list [--task T-123] [--json]');
  console.log('    Lists events holding redactable evidence, without printing any value.');
  console.log('  mapctx redact --sequence <n> --field <payload.path> --reason "<why>" [--node <nodeId>] [--actor name] [--commit] [--json]');
  console.log('    Permanently destroys one evidence field\'s content in the journal, mapctx.db and');
  console.log('    the projections derived from it, recording an auditable evidence.redacted event');
  console.log('    (target, field paths, reason, actor, and the hash of the original payload).');
  console.log('    Redactable: acceptance.approved evidence, run.receipt-recorded receipt.evidence,');
  console.log('    history.evidence-recorded evidence.repoRoot/repoOrigin. Structural facts are not.');
  console.log('    DRY RUN BY DEFAULT (read-only); --commit applies and cannot be undone.');
  console.log('  [privacy] patterns = ["regex", ...] in mapctx.toml warns (never blocks) on');
  console.log('    task create/update, acceptance approve --evidence and dispatch receipt.');
  console.log('  mapctx import --dry-run [--json] [--tasks-file path]');
  console.log('  mapctx import --commit [--json] [--tasks-file path] [--config path] [--actor name]');
  console.log('  mapctx export [--reason manual|wave-end|epic-end] [--json]');
  console.log('  mapctx validate [--json] [--snapshots] [--task T-1,T-2] [--baseline <file> | --write-baseline <file>]');
  console.log('    Under store authority, default checks canonical store only. --snapshots explicitly checks local mirrors; failure returns non-zero.');
  console.log('    --task keeps only the issues attributed to those tasks. Board-scoped issues');
  console.log('    (dependency cycles, missing work domains) carry no task id, so a task filter');
  console.log('    cannot own them: they are counted as excluded, and any board-scoped ERROR is');
  console.log('    additionally warned about on stderr, because --task filters and --baseline gates.');
  console.log('    --baseline <file> accepts the issues recorded in that file: they stop counting,');
  console.log('    so only an issue the board did NOT already have fails the gate. Baseline entries');
  console.log('    that no longer match anything are reported as stale.');
  console.log('    --write-baseline <file> records the issues of the current run (honouring --task)');
  console.log('    and exits 0 without gating. --snapshots findings are never baselined.');
  console.log('  mapctx acceptance import [--commit] [--task T-1,T-2] [--json]');
  console.log('    Dry-run by default; --commit imports observed checkboxes atomically, pins source bytes, skips existing revisions.');
  console.log('    --task narrows the import to those tasks; an id that does not exist is refused');
  console.log('    rather than quietly importing a smaller set.');
  console.log('  mapctx task acceptance <show|revise|approve|unapprove> <task-id> [--from-file path]');
  console.log('    [--expect-revision n] [--expect-title "<title>"] [--criterion-id id | --index n[,n...] | --all]');
  console.log('    [--evidence key=value ...]');
  console.log('    revise: --from-file takes a `## Acceptance` section, or -- when the file has no');
  console.log('    heading at all -- a bare `- [ ]` checklist, which it reports on stderr. Every');
  console.log('    revision resets EVERY criterion to pending: re-approval is always explicit, and a');
  console.log('    revision never inherits an approval or its evidence. --expect-title refuses when');
  console.log('    the task is titled differently, which catches revising the wrong id (a revision');
  console.log('    check cannot: a fresh task satisfies --expect-revision 0 too).');
  console.log('    approve: --index takes a list and --all takes every still-pending criterion, both');
  console.log('    in ONE transaction under ONE --expect-revision with ONE --evidence set. A mid-batch');
  console.log('    refusal approves nothing. --all skips criteria that are already approved and says');
  console.log('    so; naming an index or id that is already approved is refused instead.');
  console.log('    A missing --expect-revision reports the revision the store currently holds.');
  console.log('  mapctx task finish <task-id> [--no-snapshot | --snapshot none|full] [--json]');
  console.log('    Moves through the canonical done gate (every current store Acceptance criterion');
  console.log('    approved), then publishes the final checkpoint; retry after a checkpoint failure');
  console.log('    is safe. --no-snapshot applies the SAME gate and stops there: no TASKS.md, no');
  console.log('    tasks/*.md, no checkpoint event -- for a shared checkout where regenerating every');
  console.log('    mirror would mix generated files into someone else\'s WIP. Publish later with');
  console.log('    `mapctx export` or a plain `mapctx task finish`.');
  console.log('    DURABILITY: the store lives in ~/.mapctx/projects/<id>/, outside the repo and');
  console.log('    untracked. The committed TASKS.md/tasks/*.md checkpoint is what `mapctx store');
  console.log('    init` recovers from, so every --no-snapshot close widens the window in which a');
  console.log('    lost store loses that closure. The window is NOT per task: a checkpoint carries');
  console.log('    the filesHash of the whole mirror set, so one later `mapctx export` (or one');
  console.log('    default `finish`) captures every skipped task at once. Publish at wave-end or');
  console.log('    epic-end, and commit it.');
  console.log('    --snapshot none is the same as --no-snapshot; --snapshot task is refused by name.');
  console.log('    Both only affect `task finish`; on any other command they parse and do nothing.');
  console.log('    `task move --status done` enforces the same acceptance gate and refuses with the');
  console.log('    same message; `finish` is the command to prefer, because it also re-verifies the');
  console.log('    gate when the task is already done and reports the checkpoint it published.');
  console.log('  mapctx task show <task-id> [--json]');
  console.log('  mapctx task context <task-id> --budget <n> [--json]');
  console.log('  mapctx task search --query "<text>" [--status <planning-state>] [--limit n] [--json]');
  console.log('    Duplicate-check helper: case/accent-insensitive AND match over title, tags, domains and');
  console.log('    summary from the task projection (title/tags/domains from TASKS.md pre-cutover). Title');
  console.log('    matches rank first; blank queries return no matches.');
  console.log('  mapctx plan [--json]');
  console.log('  mapctx gantt [--json]');
  console.log('  mapctx board [--json]');
  console.log('    Kanban board dataset (title/mode/tasks) for the workspace UI: TASKS.md');
  console.log('    pre-cutover, SQLite store under store authority (T-094).');
  console.log('  mapctx push [--dry-run] [--json] [--actor name]');
  console.log('    Store-backed GitHub projection (ADR 0003): reads canonical task projections from the SQLite');
  console.log('    store (never TASKS.md), checks store maintenance, remote conflicts and GitHub preconditions;');
  console.log('    local mirrors are not consulted (there is no snapshot-drift gate). Reconciles');
  console.log('    issues/status/dates in the GitHub repo+project bound in mapctx.toml [github].');
  console.log('    Requires the gh CLI authenticated.');
  console.log('  mapctx task claim <task-id> [--lease duration] [--json] [--actor name] [--holder json]');
  console.log('  mapctx task start <task-id> [--dispatch-id id] [--executor kind] [--context-hash hash] [--status claimed|running] [--lease duration] [--holder json] [--actor name] [--json]');
  console.log('    Atomically claims the task and creates a dispatch. Returns claimId, leaseToken, renewToken, dispatchId and attempt; preferred execution entry point.');
  console.log('    Lease duration is derived from the plan, not fixed: clamp(estimatedEffort x leaseFactor, defaultLease, maxLease),');
  console.log('    so an Easy/30m task and a Hard/2d task no longer get the same window. Defaults: leaseFactor 0.5, defaultLease 30m, maxLease 8h.');
  console.log('    `--lease <duration>` (30m, 4h, 1d, 1w) overrides both config and the derived value, and is NOT clamped -- it is an explicit choice.');
  console.log('    It is still bounded: above the 24h absolute ceiling it is refused, not shrunk. A lane held longer than a day is a stuck lane.');
  console.log('    A task with no parseable estimate (an epic) gets defaultLease whole. Tune with [coordination] in mapctx.toml:');
  console.log('      [coordination]  leaseFactor = 0.5  defaultLease = "30m"  maxLease = "8h"   (an invalid value or defaultLease > maxLease is refused on read)');
  console.log('  mapctx task renew <task-id> (--claim id | --dispatch id) (--token leaseToken | --renew-token renewToken) [--json] [--actor name]');
  console.log('    Exactly one address and one credential. `--claim` names the claim; `--dispatch` LOOKS IT UP (dispatch -> task -> that task\'s active claim),');
  console.log('    so an orchestrator that holds only the dispatch id can keep the lane alive. With --dispatch the task id is checked, not used to find the claim.');
  console.log('    Two capabilities per claim, both minted at claim time and scoped to the claimId: `leaseToken` renews AND releases, `renewToken` only renews.');
  console.log('    Hand `renewToken` to your orchestrator to keep your lease alive without granting it the power to take the lane away. Renewing with --token returns the full claim (the holder already has both tokens); renewing with --renew-token returns the claim with no token at all.');
  console.log('    A claim made before this existed has no renewToken (it is refused by name, not compared): renew those with --token.');
  console.log('    `--dispatch` is refused once the dispatch\'s latest attempt has a receipt -- that lane is finished; admit a new attempt first.');
  console.log('    Extends by the same derived duration as the claim (re-read from the plan, so a mid-flight re-classification applies), never a fixed 30m.');
  console.log('    `--lease` is refused here, not ignored: the renewal size comes from the plan. Known coupling: editing detail.estimatedEffort changes');
  console.log('    the next renewal of a live claim, and nothing requires the editor to be the holder -- lowering it pins renewals to defaultLease.');
  console.log('    That edit now warns on stderr when the task has a live claim, naming the claim id (never a token).');
  console.log('  mapctx task release <task-id> --claim id --token token [--json] [--actor name]');
  console.log('    Release takes the lease token only: a renewToken has no release path at all, which is what makes the split real.');
  console.log('  mapctx task create --title "<title>" [--id T-###] [--type epic|feature|task|bug|chore] [--parent id] [--status planning-state]');
  console.log('    [--priority high|medium|low] [--workload Easy|Normal|Hard|Extreme] [--tags a,b] [--domains d,e]');
  console.log('    [--depends-on a,b] [--blocking x,y]');
  console.log('    [--start date] [--due date] [--role r] [--impact i] [--effort e] [--summary s]');
  console.log('    `--effort` is agent active time: 1d=8 active hours, 1w=40 active hours. Executable tasks without workload or effort are warned and cannot be claimed.');
  console.log('    (--description text | --description-file path) [--acceptance-file path] [--json] [--actor name]');
  console.log('    Acceptance in the same command: --acceptance-file, or a `## Acceptance` section in');
  console.log('    the description, is recorded as revision 1 in the SAME transaction as the task, so');
  console.log('    a failure creates neither. --acceptance-file wins over the description section and');
  console.log('    says so; a checklist with no `## Acceptance` heading in the description is reported');
  console.log('    and NOT recorded, because a prose bullet list is not an acceptance declaration.');
  console.log('    Auto-assigns the next free id for the type prefix (E for epic, T otherwise). The');
  console.log('    description prose goes into the new detail file and stays Git-authored from then');
  console.log('    on: edit tasks/<ID>.md in Git and commit it, never through `task update`.');
  console.log('    See "Enumerated values" below for every enum and the list syntax.');
  console.log('  mapctx task move <task-id> --status <planning-state> [--json] [--actor name]');
  console.log('    For a task not yet done, `--status done` is the same gate as `task finish');
  console.log('    --no-snapshot`: shared code, identical refusal, neither regenerates mirrors.');
  console.log('    They diverge once the task IS done -- `done` is terminal with no self-edge, so');
  console.log('    `move --status done` then refuses `illegal-transition`, while `finish`');
  console.log('    re-verifies the gate and succeeds without moving.');
  console.log('    Legal transition under store authority (backlog|ready-for-do|doing|review|done|paused|cancelled|archived,');
  console.log('    or canonical backlog|ready|in-progress|review|done|paused|cancelled|archived). done stamps completedOn and');
  console.log('    releases any active claim; done also requires every current store Acceptance criterion to be approved.');
  console.log('    cancelled and archived release any active claim but do not stamp completedOn. cancelled means the');
  console.log('    work was aborted; archived means it will not proceed.');
  console.log('    Store-authority only: Markdown stays the editor pre-cutover.');
  console.log('  mapctx task reopen <task-id> --status review [--json] [--actor name]');
  console.log('    Reopens a done, cancelled, or archived task for review, clears completedOn, and records an audit event. Publish mirrors at an explicit checkpoint.');
  console.log('  mapctx task update <task-id> [--set key=value ...] [--depends-on a,b] [--blocking x,y]');
  console.log('    [--description text | --description-file path] [--json] [--actor name]');
  console.log('    Whitelisted fields only (title,type,parentTaskId,priority,workload,tags,domains,startDate,dueDate,');
  console.log('    predictedStart,externalId,externalLinks,specMode,assignees,iteration,milestone; detail.* for');
  console.log('    role,impact,estimatedEffort,filesAffected,testsRequired,summary,prerequisites,blocking;');
  console.log('    waitReason=review|decision|parked|blocked-external as a shorthand for detail.waitReason).');
  console.log('    List fields take `--set detail.filesAffected=a,b` or `--set detail.filesAffected=["a","b"]`;');
  console.log('    `[a,b]` is refused with the correct syntax instead of storing the brackets. `=null` clears.');
  console.log('    --set externalLinks=https://…,github:issue:42 validates every entry as a URI.');
  console.log('    --depends-on/--blocking replace both');
  console.log('    the dependency edges and the detail prerequisites/blocking so the two surfaces never diverge.');
  console.log('    The Git-authored `description:` prose of tasks/<ID>.md is NOT patchable here via --set.');
  console.log('    --description / --description-file rewrite only that block of the file (structured fields,');
  console.log('    an epic budget section and the store-owned ## Acceptance checklist are kept), in any');
  console.log('    planning state including done/archived. A one-line --description with literal \\n is');
  console.log('    unescaped to line breaks; --description-file is read verbatim. An empty or whitespace-only');
  console.log('    description is refused (empty-description). Commit the file change.');
  console.log('  mapctx dispatch create <task-id> [--dispatch-id id] [--status claimed|running] (default claimed) [--executor kind] [--context-hash hash] [--json] [--actor name]');
  console.log('    New dispatch (fresh id, attempt 1) or --dispatch-id to append attempt max+1 to an existing one.');
  console.log('    Prints the dispatchId/attempt to feed `mapctx dispatch receipt`.');
  console.log('  mapctx dispatch receipt <dispatch-id> --receipt path [--claude-transcript path] [--other-session-activity path] [--idle-threshold-ms n] [--review-threshold-ms n] [--parked-threshold-ms n] [--time-zone zone] [--json]');
  console.log('  mapctx dispatch receipt <dispatch-id> --read --json');
  console.log('  mapctx reconcile <task-id> [--accept | --discard] [--json] [--actor name]');
  console.log('  mapctx sync status [--json]');
  console.log('  mapctx account add <name> [--currency USD] [--note text] [--json] [--actor name]');
  console.log('    Records a paid-plan account ("Codex Pro") in the store. Budgets and plan periods');
  console.log('    reference accounts; projects declare which accounts they draw from via `bind`.');
  console.log('  mapctx account list [--json]');
  console.log('  mapctx account bind <account-id-or-name> [--remove] [--json] [--actor name]');
  console.log('  mapctx plan-period record --account <id-or-name> --amount <decimal> --start <date|datetime>');
  console.log('    --end <date|datetime> [--currency c] [--plan-name n] [--seats n] [--json] [--actor name]');
  console.log('    Records the plan payment on the ACCOUNT (T-070: accounts own plans, projects consume).');
  console.log('  mapctx budget set <epic-id> (--amount <decimal> | --minutes n) [--currency USD] [--start date]');
  console.log('    [--end date] [--note text] [--json] [--actor name]   (--project targets the whole project)');
  console.log('    Event-sourced: every set is a revision; history is kept, latest wins.');
  console.log('  mapctx budget status <epic-id> [--json]   (--project for the whole project)');
  console.log('    Planned/spent/remaining/spent% from the cost chain. Scopes with no cost data say');
  console.log('    "no cost data" -- never zeros that look measured.');
  console.log('  mapctx budget history <epic-id> [--json]');
  console.log('  mapctx history scan [--dry-run | --commit --approve <file>] [--emit-approval-template <path>] [--include-inferred] [--json] [--codex-sessions dir] [--opencode-db path] [--claude-dir dir] [--repo dir] [--task T-1,T-2]');
  console.log('    --emit-approval-template writes approval CANDIDATES (schemaVersion 2, source-hash pinned)');
  console.log('    from the dry-run. Degraded mixed-provenance sessions are EXCLUDED unless --include-inferred');
  console.log('    opts them in as explicit intendedTier "inferred" candidates. It is not an approval:');
  console.log('    prune, review, then pass to --commit --approve.');
  console.log('    Links local Codex/OpenCode/Claude sessions plus git to tasks by signal');
  console.log('    strength (T-101), scoped to this repository/worktree identity (T-116):');
  console.log('    sessions from other repositories and sessions with unverifiable cwd are');
  console.log('    listed but never linked. --dry-run reports tiers/intervals/confidence and');
  console.log('    writes nothing; --commit records approved links as historical evidence');
  console.log('    through the journal -- no claim/dispatch/receipt, no lifecycle mutation,');
  console.log('    works for done tasks too -- and refreshes the measured-date cache.');
  console.log('  mapctx history correct <task-id> --target receipt:<dispatchId>/<attempt> | evidence:<id> --because "<reason>" [--json]');
  console.log('    Journals an auditable correction: the original receipt/evidence stays');
  console.log('    queryable, but invalid evidence drops out of roadmap + calibration.');
  console.log('    Receipt targets must be exactly <canonical-uuid>/<positive-attempt>.');
  console.log('  mapctx history reconstruct [--json] [--task T-1,T-2]');
  console.log('    Rebuilds the approved history view after corrections, tiering tasks');
  console.log('    measured / inferred / declared / synthetic / no-history.');
  printEnumHelp();
}

function print(value: unknown, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

/**
 * T-127: a refused command used to print its structured refusal to STDOUT and
 * then exit non-zero, so a caller piping `--json` stdout into a parser read a
 * refusal as if it were a result. Carrying the payload on the error instead
 * keeps stdout a success-only channel: the single error document -- payload
 * included -- is written to stderr by the top-level handler, exactly once.
 *
 * Message stays first and unchanged, because existing callers match on it.
 */
export class CliRefusal extends Error {
  constructor(message: string, readonly payload: unknown) {
    super(message);
    this.name = 'CliRefusal';
  }
}

function refuse(payload: unknown, message: string): never {
  throw new CliRefusal(message, payload);
}

/**
 * Writes the one error document for a failed run, entirely on stderr.
 *
 * Under `--json`: exactly one line of compact JSON -- the structured refusal
 * payload when there is one, otherwise a minimal `{ok:false,error}` envelope
 * so `2>` always captures something parseable -- followed by the human
 * `Error:` line. A consumer reads the FIRST LINE of stderr; it does not have
 * to find the `\nError:` boundary (review A10), though that boundary still
 * works and is documented in `mapctx --help`.
 *
 * Without `--json` only the `Error:` sentence is printed, keeping T-126's
 * condition for `redact`.
 *
 * T-134 closed the reason this mattered most: a claim refusal used to embed
 * the holder's `leaseToken` (T-124 C0), so human mode not printing the
 * payload was the only thing keeping the credential off the terminal. The
 * token is now redacted at the source (`disclosableClaim` in store/claims.ts)
 * and no longer reaches a refusal payload at all, in either mode. This
 * condition is no longer load-bearing for that secret -- it stays because
 * stdout/stderr hygiene is worth having on its own, and because a future
 * payload could carry something else that should not be sprayed.
 */
export function writeCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  const payload = error instanceof CliRefusal ? error.payload : undefined;
  if (json) process.stderr.write(`${JSON.stringify(payload ?? { ok: false, error: message })}\n`);
  console.error(`Error: ${message}`);
}

function parseArgs(argv: string[]): {
  command: string;
  subcommand?: string;
  options: MapctxOptions;
  positional: string[];
  help: boolean;
} {
  const args = [...argv];
  const command = args.length > 0 ? args.shift()! : '';
  const options: MapctxOptions = {};
  const positional: string[] = [];
  let help = false;
  // Declared out here so `valueFor` below can advance the same counter.
  let i = 0;

  /**
   * `--flag=value` for value-taking flags (review B8). Rewritten up front into
   * the flag token plus a side table, so the 70 `valueFor` call sites and the
   * flag chain below stay exactly as they are. Boolean flags are left alone,
   * so `--json=true` is not silently reinterpreted, and `--set key=value` is
   * untouched because the `=` there belongs to the value, not the flag.
   */
  const inlineValues = new Map<number, string>();
  for (let index = 0; index < args.length; index++) {
    const match = /^(--[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(args[index]);
    if (match && VALUE_FLAGS.has(match[1])) {
      args[index] = match[1];
      inlineValues.set(index, match[2]);
    }
  }

  /**
   * Review A5: every value-taking flag used to do a bare `args[++i]`, so a
   * flag written without its value silently swallowed the next one. The
   * measured damage was not cosmetic: `--actor --json` journaled an event
   * attributed to the actor "--json" in an append-only log, `--title --json`
   * created a task called "--json", and `--tags --json` stored that list.
   *
   * Review B8: the check tests PERTINENCE, not shape. Only a token that is
   * actually one of this CLI's flags counts as a missing value, so a value
   * that merely looks flag-ish -- `--title "--foo is a flag"`, `--summary
   * "--no-snapshot x"`, `--because "--x"` -- passes, as it did before. A
   * single dash was never affected: `--summary "- item"` and negative numbers
   * pass, and so does the bare `--` terminator.
   *
   * For the remaining narrow case -- a legitimate value that IS one of these
   * flags, e.g. `--query "--json"` -- `--flag=value` is accepted below.
   */
  const valueFor = (flag: string): string => {
    const inlined = inlineValues.get(i);
    if (inlined !== undefined) return inlined;
    const next = args[++i];
    if (next === undefined) throw new Error(`${flag} is missing its value.`);
    if (KNOWN_FLAGS.has(next)) {
      throw new Error(`${flag} is missing its value (got ${JSON.stringify(next)}, which is another flag). To pass a value that is itself a flag name, write ${flag}=${next}.`);
    }
    return next;
  };

  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--commit') options.commit = true;
    else if (a === '--json') options.json = true;
    else if (a === '--snapshots') options.snapshots = true;
    else if (a === '--no-snapshot') options.snapshot = 'none';
    else if (a === '--snapshot') {
      // Review F1: `--snapshot=none` was one of four spellings that silently
      // published. It is a validated alias now, and any other value is
      // refused by name instead of being dropped.
      const value = valueFor(a);
      if (value === 'none') options.snapshot = 'none';
      else if (value === 'full') options.snapshot = 'full';
      else if (value === 'task') {
        throw new Error('--snapshot=task is not supported: a checkpoint carries the filesHash of the WHOLE mirror set, so publishing one task\'s file and journaling it as a checkpoint would misstate what was materialized. Use --no-snapshot and then `mapctx export` when the working tree is yours to rewrite.');
      } else {
        throw new Error(`--snapshot must be none or full; got ${JSON.stringify(value)}. --no-snapshot is the same as --snapshot=none.`);
      }
    }
    else if (a === '--from-file') options.fromFile = valueFor(a);
    else if (a === '--criterion-id') options.criterionId = valueFor(a);
    else if (a === '--index') {
      // T-129: a comma list, so one approve can cover several criteria. A
      // single index is still the common case and parses as a one-item list.
      options.indices = parseListInput('--index', valueFor(a)).map(part => {
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0) throw new Error(`--index must be non-negative integers, got: ${part}`);
        return value;
      });
      if (options.indices.length === 0) throw new Error('--index needs at least one zero-based position');
    }
    else if (a === '--acceptance-file') options.acceptanceFile = valueFor(a);
    else if (a === '--expect-title') options.expectTitle = valueFor(a);
    else if (a === '--all') options.all = true;
    else if (a === '--expect-revision') {
      const value = Number(valueFor(a));
      if (!Number.isInteger(value) || value < 0) throw new Error('--expect-revision must be a non-negative integer');
      options.expectRevision = value;
    }
    else if (a === '--accept') options.reconcileMode = 'accept';
    else if (a === '--discard') options.reconcileMode = 'discard';
    else if (a === '--config') options.configPath = valueFor(a);
    else if (a === '--tasks-file') options.tasksFileOverride = valueFor(a);
    else if (a === '--actor') options.actor = valueFor(a);
    else if (a === '--claim') options.claimId = valueFor(a);
    else if (a === '--token') options.leaseToken = valueFor(a);
    else if (a === '--renew-token') options.renewToken = valueFor(a);
    else if (a === '--dispatch') options.dispatch = valueFor(a);
    else if (a === '--lease') options.lease = valueFor(a);
    else if (a === '--holder') options.holder = valueFor(a);
    else if (a === '--receipt' || a === '--file') options.receiptPath = valueFor(a);
    else if (a === '--claude-transcript') options.claudeTranscriptPath = valueFor(a);
    else if (a === '--other-session-activity') options.otherSessionActivityPath = valueFor(a);
    else if (a === '--idle-threshold-ms') options.idleThresholdMs = Number(valueFor(a));
    else if (a === '--review-threshold-ms') options.reviewThresholdMs = Number(valueFor(a));
    else if (a === '--parked-threshold-ms') options.parkedThresholdMs = Number(valueFor(a));
    else if (a === '--time-zone') options.timeZone = valueFor(a);
    else if (a === '--read') options.readReceipt = true;
    else if (a === '--status') options.status = valueFor(a);
    else if (a === '--set') (options.setPairs ??= []).push(valueFor(a));
    else if (a === '--depends-on') options.dependsOn = valueFor(a);
    else if (a === '--blocking') options.blocking = valueFor(a);
    else if (a === '--dispatch-id') options.dispatchId = valueFor(a);
    else if (a === '--id') options.id = valueFor(a);
    else if (a === '--executor') options.executor = valueFor(a);
    else if (a === '--context-hash') options.contextHash = valueFor(a);
    else if (a === '--title') options.title = valueFor(a);
    else if (a === '--type') options.type = valueFor(a);
    else if (a === '--parent') options.parent = valueFor(a);
    else if (a === '--priority') options.priority = valueFor(a);
    else if (a === '--workload') options.workload = valueFor(a);
    else if (a === '--tags') options.tags = valueFor(a);
    else if (a === '--domains') options.domains = valueFor(a);
    else if (a === '--start') options.start = valueFor(a);
    else if (a === '--due') options.due = valueFor(a);
    else if (a === '--role') options.role = valueFor(a);
    else if (a === '--impact') options.impact = valueFor(a);
    else if (a === '--effort') options.effort = valueFor(a);
    else if (a === '--summary') options.summary = valueFor(a);
    else if (a === '--description') options.description = valueFor(a);
    else if (a === '--description-file') options.descriptionFile = valueFor(a);
    else if (a === '--currency') options.currency = valueFor(a);
    else if (a === '--amount') options.amount = valueFor(a);
    else if (a === '--minutes') {
      const value = Number(valueFor(a));
      if (!Number.isInteger(value) || value < 1) throw new Error('--minutes must be a positive integer');
      options.minutes = value;
    }
    else if (a === '--note') options.note = valueFor(a);
    else if (a === '--query') options.query = valueFor(a);
    else if (a === '--codex-sessions') options.codexSessions = valueFor(a);
    else if (a === '--opencode-db') options.opencodeDb = valueFor(a);
    else if (a === '--claude-dir') options.claudeDir = valueFor(a);
    else if (a === '--repo') options.repo = valueFor(a);
    else if (a === '--task') options.taskFilter = valueFor(a);
    else if (a === '--approve') options.approvePath = valueFor(a);
    else if (a === '--approve-hash') options.approveHash = valueFor(a);
    else if (a === '--reason') {
      const value = valueFor(a);
      if ((CHECKPOINT_REASONS as readonly string[]).includes(value)) options.reason = value as CheckpointReason;
      else options.attestationReason = value;
    }
    else if (a === '--reason-file') options.attestationReasonFile = valueFor(a);
    else if (a === '--evidence') (options.evidencePairs ??= []).push(valueFor(a));
    else if (a === '--emit-approval-template') options.emitApprovalPath = valueFor(a);
    else if (a === '--include-inferred') options.includeInferred = true;
    else if (a === '--target') options.target = valueFor(a);
    else if (a === '--node') options.nodeId = valueFor(a);
    else if (a === '--field') options.field = valueFor(a);
    else if (a === '--sequence') {
      const value = Number(valueFor(a));
      // Non-negative, not positive: a run event's first sequence is 0
      // (`runEventSchema` says non-negative). `redact`, whose journal
      // sequences start at 1, refuses 0 by name in its own command.
      if (!Number.isInteger(value) || value < 0) throw new Error('--sequence must be a non-negative integer');
      options.sequence = value;
    }
    else if (a === '--attempt') {
      const value = Number(valueFor(a));
      if (!Number.isInteger(value) || value < 1) throw new Error('--attempt must be a positive integer');
      options.attempt = value;
    }
    else if (a === '--payload') options.payload = valueFor(a);
    else if (a === '--baseline') options.baselinePath = valueFor(a);
    else if (a === '--write-baseline') options.writeBaselinePath = valueFor(a);
    else if (a === '--because') options.correctionReason = valueFor(a);
    else if (a === '--limit') {
      const value = Number(valueFor(a));
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit must be a positive integer');
      options.limit = value;
    }
    else if (a === '--account') options.account = valueFor(a);
    else if (a === '--plan-name') options.planName = valueFor(a);
    else if (a === '--seats') {
      const value = Number(valueFor(a));
      if (!Number.isInteger(value) || value < 1) throw new Error('--seats must be a positive integer');
      options.seats = value;
    }
    else if (a === '--end') options.end = valueFor(a);
    else if (a === '--project') options.project = true;
    else if (a === '--remove') options.remove = true;
    else if (a === '--budget') {
      const value = Number(valueFor(a));
      if (!Number.isInteger(value) || value < 1) throw new Error('--budget must be a positive integer');
      options.budget = value;
    }
    else if (a === '--wait-reason') {
      const value = valueFor(a);
      if (value === 'review' || value === 'decision' || value === 'parked' || value === 'blocked-external' || value === 'null' || value === '') {
        options.waitReason = value === 'null' || value === '' ? undefined : value as "review" | "decision" | "parked" | "blocked-external";
      } else {
        throw new Error(`Invalid --wait-reason value: ${value}`);
      }
    } else if (!a.startsWith('-')) {
      positional.push(a);
    } else if (a.startsWith('--') && a !== '--') {
      // Review F1 (HIGH): this loop used to end WITHOUT an else, so any
      // unrecognized `-...` token was dropped in silence. That turned four
      // plausible spellings of --no-snapshot -- `--no-snapshots` (one char
      // from the real `--snapshots`), `--snapshot=none`, `--snapshot none`,
      // `--no-snapshot=true` -- into a publishing finish that rewrote every
      // mirror into a shared checkout, exit 0, no warning: precisely the harm
      // the flag exists to prevent.
      //
      // Matching on the BASE name keeps T-127's decision that an inline value
      // does not apply to a boolean flag, so `--json=true` stays accepted and
      // ignored exactly as its test asserts.
      const base = a.split('=')[0];
      if (!KNOWN_FLAGS.has(base)) throw new Error(`Unknown flag: ${base}`);
      if (a.includes('=') && VALUE_REJECTING_FLAGS.has(base)) {
        // The alternative spelling is flag-specific: `--snapshot=none` is the
        // value form of --no-snapshot, and there is no value form of --all.
        const alternative = base === '--no-snapshot' ? ' Use it on its own, or --snapshot=none.' : ' Use it on its own.';
        throw new Error(`${base} takes no value.${alternative}`);
      }
    }
  }

  return { command, subcommand: positional[0], options, positional, help };
}

function defaultActor(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return os.userInfo().username || 'cli';
  } catch {
    return 'cli';
  }
}

function resolveTasksFilePath(cwd: string, options: MapctxOptions): string {
  if (options.tasksFileOverride) return path.resolve(cwd, options.tasksFileOverride);
  const { config, configPath, configExists } = loadConfigOptionalForBoard(options);
  return path.resolve(configExists ? path.dirname(configPath) : cwd, config.tasksFile);
}

function resolveStoreCheckpointPath(cwd: string, options: MapctxOptions, projectRoot: string): string {
  return options.tasksFileOverride
    ? path.resolve(cwd, options.tasksFileOverride)
    : path.join(projectRoot, 'TASKS.md');
}

function readHistoryDates(filePath: string): GanttHistoryDate[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { schemaVersion?: unknown; tasks?: unknown };
    // Schema 2 (T-116 review attempt 2): aggregate rows carry an explicit
    // tier. Schema 1 files stay readable with the measured default so an old
    // cache never crashes the roadmap, but a fresh write supersedes it.
    if ((payload.schemaVersion !== 1 && payload.schemaVersion !== 2) || !Array.isArray(payload.tasks)) return [];
    return payload.tasks.filter((item): item is GanttHistoryDate => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Partial<GanttHistoryDate>;
      return typeof value.taskId === 'string'
        && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
        && typeof value.endedAt === 'string' && Number.isFinite(Date.parse(value.endedAt))
        && typeof value.confidence === 'string'
        && (typeof value.source === 'string' || value.source === null);
    });
  } catch {
    return [];
  }
}

type OpenStoreResult = {
  toml: { config: MapctxTomlConfig; path: string; dir: string };
  storeDir: string;
  handle: StoreHandle;
};

/**
 * Fails closed per ADR 0003 "Authority and cutover": a project with
 * plansAuthority: store but no local mapctx.db is "not materialized", not
 * pre-cutover, and tooling must never silently fall back to treating
 * Markdown as authoritative.
 */
function openStoreOrFail(cwd: string, options: { mode?: 'write' | 'read' } = {}): OpenStoreResult {
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents. Run `mapctx import --commit` first.');
  }
  if (toml.config.plansAuthority !== 'store') {
    throw new Error(`plansAuthority is "${toml.config.plansAuthority}", not "store"; this project has not cut over. See mapctx.toml.`);
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  if (!isStoreMaterialized(storeDir)) {
    throw new Error(`Store not materialized at ${storeDir}. Run \`mapctx store init\`.`);
  }
  // R14: query commands observe the store through a read-only handle -- they
  // cannot migrate, reindex, or write metadata. Pending maintenance is
  // surfaced as an explicit condition instead of being healed silently.
  if (options.mode === 'read') {
    const handle = StoreHandle.openReadOnly(storeDir);
    const maintenance = handle.maintenanceNeeded();
    if (maintenance) {
      handle.close();
      throw new Error(`Store maintenance needed, refusing to read stale state: ${maintenance}`);
    }
    // T-126 review ALTA-1: an unverifiable redaction (target entry missing)
    // is reported, not refused. Blocking every read on it turned one lost
    // journal file into a store nobody could even diagnose. Warnings go to
    // stderr so `--json` stdout stays a clean document.
    for (const advisory of handle.maintenanceAdvisory()) console.error(`Warning: ${advisory}`);
    return { toml, storeDir, handle };
  }
  return { toml, storeDir, handle: StoreHandle.open(storeDir) };
}

function storeInitCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents. Run `mapctx import --commit` first.');
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  const alreadyMaterialized = isStoreMaterialized(storeDir);

  if (alreadyMaterialized) {
    const handle = StoreHandle.open(storeDir);
    handle.close();
    print({ projectId: toml.config.projectId, storeDir, alreadyMaterialized: true, recovered: false, plansAuthority: toml.config.plansAuthority }, options.json);
    return;
  }

  if (toml.config.plansAuthority === 'store') {
    // Total loss of ~/.mapctx/projects/<id>/ (ADR 0003 corruption tier 3): the
    // last git-committed TASKS.md/tasks/*.md checkpoint is the only recovery
    // path. This starts a fresh incarnation at the same projectId; event
    // history strictly older than this checkpoint is permanently gone.
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    const recovered = recoverStoreFromCheckpoint({
      tasksFilePath,
      tasksRoot: cwd,
      projectId: toml.config.projectId,
      storeDir,
      actor: defaultActor(options.actor)
    });
    print(
      {
        projectId: recovered.projectId,
        storeDir: recovered.storeDir,
        alreadyMaterialized: false,
        recovered: true,
        taskCount: recovered.taskCount,
        incarnationId: recovered.incarnationId,
        warning: 'Recovered from the last git-committed checkpoint. Event history, claims, and cost/usage data strictly older than this checkpoint are permanently gone.'
      },
      options.json
    );
    return;
  }

  const handle = StoreHandle.open(storeDir);
  handle.close();
  print({ projectId: toml.config.projectId, storeDir, alreadyMaterialized: false, recovered: false, plansAuthority: toml.config.plansAuthority }, options.json);
}

function storeRepairCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents.');
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  const result = repairStore(storeDir);
  // A gap report is the deliverable of this command, not a refusal of it: the
  // diagnosis (which node, which sequence, the named remedy) stays on stdout
  // and the non-zero exit is the gate. T-127 moved REFUSALS to stderr, not
  // the reports whose whole value is the document they print.
  print(result, options.json);
  if (result.status === 'gap') {
    throw new Error(`Repair aborted: ${result.gaps.length} journal gap(s) found. mapctx.db was left untouched.`);
  }
}

/**
 * T-119: draft (default) or approve+write (--approve-hash) an attestation for
 * one DB-only node. Draft mode is read-only; approve mode recomputes the
 * draft under the maintenance lock and refuses unless the token matches, so
 * the written attestation is exactly what was reviewed.
 */
/**
 * Parses `--evidence key=value` pairs into a plain record. The key must be
 * nonempty; everything after the FIRST '=' is the value, so values may
 * themselves contain '='. Built with Object.fromEntries so ARBITRARY
 * nonempty keys -- including `__proto__`, `constructor`, `toString` --
 * become own data properties and survive JSON/event/show exactly, instead
 * of silently disappearing through prototype setters. Refuses before
 * callers mutate anything.
 */
export function parseEvidencePairs(pairs: string[] | undefined): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--evidence expects key=value, got: ${pair}`);
    entries.push([pair.slice(0, eq), pair.slice(eq + 1)]);
  }
  return Object.fromEntries(entries);
}

function storeAttestOrphanCommand(nodeId: string | undefined, options: MapctxOptions): void {
  if (!nodeId || (!options.attestationReason && !options.attestationReasonFile)) {
    throw new Error('Usage: mapctx store attest-orphan <node-id> (--reason "text" | --reason-file <path>) [--evidence key=value ...] [--approve-hash <sha256>] [--json]');
  }
  const attestationReason = options.attestationReasonFile
    ? fs.readFileSync(path.resolve(process.cwd(), options.attestationReasonFile), 'utf8').trim()
    : options.attestationReason!;
  // Reject BEFORE any store call: a blank reason must never reach draft or
  // approval, not even as a draft that only the loader would later refuse.
  if (attestationReason.trim().length === 0) {
    throw new Error('Attestation reason is empty or whitespace-only; a reviewed, non-blank --reason/--reason-file is required before anything can be drafted or approved.');
  }
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents.');
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  const evidence = parseEvidencePairs(options.evidencePairs);
  const draftOptions = {
    reason: attestationReason,
    evidence,
    approvedBy: defaultActor(options.actor)
  };
  if (!options.approveHash) {
    // No early "already attested" refusal here: drafting is read-only, and
    // the draft is the required first step of the idempotent re-confirmation
    // that restores a lost witness. The real gate lives in commit.
    const draft = draftNodeAttestation(storeDir, nodeId, draftOptions);
    print({ status: 'draft', nodeId, contentSha256: draft.contentSha256, attestation: draft.attestation }, options.json);
    if (!options.json) {
      console.log('');
      console.log(`Approve with: mapctx store attest-orphan ${nodeId} --reason-file <same-file> --approve-hash ${draft.contentSha256}`);
    }
    return;
  }
  const result = commitNodeAttestation(storeDir, nodeId, options.approveHash, draftOptions);
  print({ status: 'attested', nodeId, contentSha256: result.contentSha256, filePath: result.filePath, attestedAt: result.attestation.attestedAt, approvedBy: result.attestation.approvedBy }, options.json);
}

/**
 * T-126: the `[privacy] patterns` lint, wired at the four write paths that
 * accept operator/agent free text. Warnings go to STDERR so `--json` stdout
 * stays a clean document, and they never change the exit status: a regex is a
 * guess, and a false positive must not be able to stop board work.
 */
function warnPrivacy(
  operation: string,
  value: unknown,
  cwd = process.cwd(),
  /**
   * T-126 review MEDIA-1: the warning used to end with "or redact it after
   * the fact" everywhere, and that advice was false at three of the four call
   * sites -- `task.upserted` has no redactable root at all, and the receipt
   * scan reported `evidence.0.uri` while redaction addresses
   * `receipt.evidence.0.uri`. Teaching a cure that `mapctx redact` refuses is
   * worse than saying nothing, because the operator writes the production
   * value trusting it. So each site declares the event type it actually
   * writes (absent = nothing redactable here) and the root path the payload
   * will sit under, and the lint tailors the remedy from REDACTABLE_ROOTS.
   */
  wiring: { rootPath?: string; eventType?: string } = {}
): void {
  let patterns: string[] | undefined;
  try {
    patterns = resolveMapctxToml(cwd)?.config.privacy?.patterns;
  } catch {
    return; // an unreadable config is the config loader's problem, not the lint's
  }
  const eventType = wiring.eventType;
  for (const warning of lintForPrivacy(operation, value, patterns, {
    ...(wiring.rootPath ? { rootPath: wiring.rootPath } : {}),
    ...(eventType ? { redactable: (fieldPath: string) => isRedactableFieldPath(eventType, fieldPath) } : {})
  }).warnings) {
    console.error(warning);
  }
}

function redactListCommand(options: MapctxOptions): void {
  const { handle } = openStoreOrFail(process.cwd(), { mode: 'read' });
  try {
    const candidates = listRedactionCandidates(handle.db, options.taskFilter ? { taskId: options.taskFilter } : {});
    print({
      ok: true,
      count: candidates.length,
      redactableRoots: REDACTABLE_ROOTS,
      candidates
    }, options.json);
    if (!options.json && candidates.length > 0) {
      console.log('');
      console.log('Redact one with: mapctx redact --node <nodeId> --sequence <n> --field <path> --reason "<why>" --actor <name> [--commit]');
    }
  } finally {
    handle.close();
  }
}

/**
 * `mapctx redact` -- dry-run by default, `--commit` to apply. Both --reason
 * and --actor are required: an unexplained, unattributed destruction of
 * evidence is not an audit record. The dry run opens the store read-only, so
 * the default path provably cannot write.
 */
function redactCommand(options: MapctxOptions): void {
  const reason = options.attestationReason ?? (typeof options.reason === 'string' ? options.reason : undefined);
  if (options.sequence === undefined || !options.field) {
    throw new Error('Usage: mapctx redact --sequence <n> --field <payload.path> --reason "<why>" [--node <nodeId>] [--actor <name>] [--commit] [--json]  |  mapctx redact list [--task T-123] [--json]');
  }
  // T-143 shares `--sequence` with `run event`, whose sequences are 0-based,
  // so the parser's floor moved to 0. A journal sequence of 0 never exists,
  // and it must keep being refused by name rather than becoming a lookup that
  // finds nothing.
  if (options.sequence < 1) {
    throw new Error('mapctx redact --sequence is a journal event sequence and starts at 1; 0 addresses no event.');
  }
  if (!reason || !reason.trim()) {
    throw new Error('mapctx redact requires --reason "<why>": redaction destroys evidence permanently and must say why.');
  }
  const cwd = process.cwd();
  const { handle, storeDir } = openStoreOrFail(cwd, { mode: options.commit ? 'write' : 'read' });
  try {
    const target = { nodeId: options.nodeId ?? handle.nodeId, sequence: options.sequence };
    const result = redactEvidence(handle, {
      target,
      fieldPath: options.field,
      reason: reason.trim(),
      actor: defaultActor(options.actor),
      commit: Boolean(options.commit)
    });
    // Review BAIXA-4: a refusal used to be printed as a result on stdout AND
    // raised as an error, so the same refusal left twice by two channels.
    // stdout is the result channel; a refusal is not a result. The structured
    // object still exists for machine consumers -- on stderr, next to the
    // message -- and the exit code is what they check first. T-127 generalized
    // this to every refusing command through CliRefusal.
    if (!result.ok) refuse(result, `Redaction refused: ${result.reason} -- ${result.message}`);
    print(result, options.json);
    // T-131 review ALTO-1/ALTO-2: what this redaction does NOT reach, and
    // what it costs. On stderr so `--json` stdout stays a clean document, and
    // on BOTH the dry run and the commit -- the dry run is where the operator
    // decides, and the commit is the last chance to hear that a derived copy
    // is still out there. The advisories never carry a value.
    for (const advisory of result.advisories) {
      console.error(`Warning: ${advisory}`);
    }
    if (!options.json && result.mode === 'dry-run') {
      console.log('');
      console.log(`Dry run: nothing was written to ${storeDir}. Re-run with --commit to destroy the content above.`);
    }
    if (result.mode === 'commit' && result.reclaimWarning) {
      console.error(result.reclaimWarning);
    }
  } finally {
    handle.close();
  }
}

function importDryRunCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const tasksFilePath = resolveTasksFilePath(cwd, options);
  const result = importDryRun({
    tasksFilePath,
    cwd,
    legacyConfigPath: options.configPath ? path.resolve(cwd, options.configPath) : undefined
  });
  // Same as `store repair`: a dry-run plan is a report, so the plan stays on
  // stdout even when it fails the gate -- the errors it lists are what the
  // caller came for.
  print(result, options.json);
  if (result.plan.errors > 0) {
    throw new Error(`Import validation failed with ${result.plan.errors} error(s).`);
  }
  if (result.cutover && result.cutover.blockers.length > 0) {
    throw new Error(`Cutover blocked:\n${result.cutover.blockers.map(b => `- ${b}`).join('\n')}`);
  }
}

function importCommitCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const result = importCommit({
    cwd,
    tasksFilePath: options.tasksFileOverride ? path.resolve(cwd, options.tasksFileOverride) : undefined,
    legacyConfigPath: options.configPath ? path.resolve(cwd, options.configPath) : undefined,
    actor: defaultActor(options.actor)
  });
  print(result, options.json);
}

function exportCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  const tasksRoot = toml?.dir ?? cwd;
  const { handle } = openStoreOrFail(cwd);
  try {
    const reason = options.reason ?? 'manual';
    const result = publishCheckpoint(handle, tasksRoot, { reason, actor: defaultActor(options.actor) });
    if (!result.ok) refuse(result, `Checkpoint failed at ${result.stage}: ${result.error}`);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

/**
 * T-127 (R7): resolves `--task` / `--baseline` / `--write-baseline` into the
 * selectors `applyValidationGate` takes. Both refusals happen before any
 * validation runs, so a typo in the flags never costs a full board read.
 */
function resolveValidateGate(cwd: string, options: MapctxOptions): {
  tasks?: string[];
  baseline?: ValidationBaselineFile;
  writeBaselinePath?: string;
} {
  // A flag written without its value is refused in parseArgs now (review A5),
  // for every value-taking flag rather than only these three. What is left
  // here is the blank case, which parseArgs cannot distinguish from a caller
  // deliberately passing an empty string: for a gate, an empty filter must
  // never read as "match nothing, exit 0".
  for (const [flag, value] of [['--task', options.taskFilter], ['--baseline', options.baselinePath], ['--write-baseline', options.writeBaselinePath]] as const) {
    if (value !== undefined && value.trim() === '') throw new Error(`${flag} is missing its value.`);
  }
  if (options.baselinePath && options.writeBaselinePath) {
    throw new Error('--baseline and --write-baseline are mutually exclusive: one reads accepted issues, the other records the current ones.');
  }
  const tasks = options.taskFilter ? parseListInput('--task', options.taskFilter) : undefined;
  if (tasks && tasks.length === 0) {
    throw new Error('--task needs at least one task id.');
  }
  let baseline: ValidationBaselineFile | undefined;
  if (options.baselinePath) {
    const baselineFile = path.resolve(cwd, options.baselinePath);
    if (!fs.existsSync(baselineFile)) {
      throw new Error(`Baseline file not found: ${baselineFile}. Record one with \`mapctx validate --write-baseline ${options.baselinePath}\`.`);
    }
    baseline = parseValidationBaseline(fs.readFileSync(baselineFile, 'utf8'));
  }
  return {
    ...(tasks ? { tasks } : {}),
    ...(baseline ? { baseline } : {}),
    ...(options.writeBaselinePath ? { writeBaselinePath: path.resolve(cwd, options.writeBaselinePath) } : {})
  };
}

function writeValidateBaseline(filePath: string, issues: ValidationGateIssue[], json?: boolean): void {
  const baseline = buildValidationBaseline(issues);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Temp + rename (review A12): two concurrent runs writing the same baseline
  // must not leave a truncated file behind, and the repo writes every durable
  // artifact this way.
  // Review B12: a write that throws part-way (full disk, permissions) used to
  // leave the temp file behind, so the cleanup is unconditional.
  const tempPath = `${filePath}.${process.pid}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch { /* nothing to clean up */ }
    }
  }
  if (json) print({ wroteBaseline: filePath, issues: baseline.issues.length, schemaVersion: baseline.schemaVersion }, true);
  else console.log(`Wrote baseline with ${baseline.issues.length} accepted issue(s): ${filePath}`);
}

/** Shared `--task`/`--baseline` reporting lines, identical in both regimes. */
function printGateSummary(gate: Pick<ValidationGateResult<ValidationGateIssue>, 'taskFilter' | 'filteredOutByTask' | 'boardScopedExcluded' | 'boardScopedErrors' | 'baselined' | 'staleBaseline'>): void {
  if (gate.taskFilter) {
    console.log(`Task filter: ${gate.taskFilter.join(', ')} (${gate.filteredOutByTask} issue(s) on other tasks, ${gate.boardScopedExcluded} board-scoped issue(s) not shown)`);
  }
  if (gate.baselined > 0) console.log(`Baselined: ${gate.baselined} pre-existing issue(s) accepted`);
  for (const stale of gate.staleBaseline) {
    const advice = stale.cause === 'out-of-scope'
      ? 'excluded by --task, not gone; keep it in the baseline.'
      : 'no longer reported; drop it from the baseline.';
    console.log(`- [stale-baseline] ${stale.code}${stale.taskId ? ` ${stale.taskId}` : ''}: ${advice}`);
  }
}

/**
 * A task-scoped run can exit 0 while the board carries an error nobody can
 * attribute to a task. That is the documented division of labour (`--task`
 * filters, `--baseline` gates), but it must never be quiet. The warning goes
 * to stderr, so it survives `--json` without touching the stdout document,
 * and it is emitted in both output modes.
 */
function warnBoardScopedErrors(gate: Pick<ValidationGateResult<ValidationGateIssue>, 'boardScopedErrors'>): void {
  for (const issue of gate.boardScopedErrors) {
    console.error(`Warning: board-scoped error not covered by --task: [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}

export function mapctxValidateCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  const gateOptions = resolveValidateGate(cwd, options);
  if (toml?.config.plansAuthority === 'store') {
    // Operational validation reads only identity config and read-only store.
    // Local snapshots are opened only when the caller explicitly asks.
    const rawStore = validateStoreRegime(cwd);
    // T-127: the gate narrows WHICH issues count, never which checks run. The
    // canonical and semantic reports keep their own identities (and their own
    // recomputed counts) so the printed shape stays the one consumers read.
    const gated = rawStore.status === 'store-authority'
      ? (() => {
          const canonical = applyValidationGate(rawStore.canonical.issues, gateOptions);
          const semantic = applyValidationGate(rawStore.semantic.issues, gateOptions);
          const combined = applyValidationGate([...rawStore.canonical.issues, ...rawStore.semantic.issues], gateOptions);
          return { canonical, semantic, combined };
        })()
      : null;
    if (gateOptions.writeBaselinePath) {
      if (!gated) throw new Error(`Cannot record a baseline: store validation returned "${rawStore.status}".`);
      writeValidateBaseline(gateOptions.writeBaselinePath, gated.combined.issues, options.json);
      return;
    }
    const store = gated && rawStore.status === 'store-authority'
      ? {
          ...rawStore,
          canonical: { ...rawStore.canonical, errors: gated.canonical.errors, warnings: gated.canonical.warnings, issues: gated.canonical.issues },
          semantic: { errors: gated.semantic.errors, warnings: gated.semantic.warnings, issues: gated.semantic.issues }
        }
      : rawStore;
    let snapshots: unknown;
    let snapshotFailed = false;
    if (options.snapshots) {
      const tasksRoot = options.tasksFileOverride
        ? path.dirname(path.resolve(cwd, options.tasksFileOverride))
        : toml.dir;
      let structural: unknown;
      try {
        structural = getValidationReport(options);
        snapshotFailed ||= (structural as ReturnType<typeof getValidationReport>).errors > 0;
      } catch (error) {
        structural = { error: 'snapshot-structure-failed', message: error instanceof Error ? error.message : String(error) };
        snapshotFailed = true;
      }
      const drift = checkStoreSnapshots(cwd, tasksRoot);
      snapshotFailed ||= drift.status !== 'store-authority' || drift.drift.hasDrift;
      snapshots = { status: snapshotFailed ? 'failed' : 'passed', structural, drift };
    }
    const gateApplied = Boolean(gateOptions.tasks || gateOptions.baseline);
    if (options.json) {
      print({
        store,
        ...(options.snapshots ? { snapshots } : {}),
        ...(gateApplied && gated
          ? {
              gate: {
                taskFilter: gated.combined.taskFilter,
                filteredOutByTask: gated.combined.filteredOutByTask,
                boardScopedExcluded: gated.combined.boardScopedExcluded,
                boardScopedErrors: gated.combined.boardScopedErrors,
                baselined: gated.combined.baselined,
                staleBaseline: gated.combined.staleBaseline
              }
            }
          : {})
      }, true);
      if (gated) warnBoardScopedErrors(gated.combined);
    } else {
      console.log(`Store validation: ${store.status}`);
      if (store.status === 'store-authority') {
        console.log(`Canonical: ${store.canonical.errors ? 'FAIL' : 'PASS'} (${store.canonical.errors} errors, ${store.canonical.warnings} warnings)`);
        console.log(`Store semantics: ${store.semantic.errors ? 'FAIL' : 'PASS'} (${store.semantic.errors} errors, ${store.semantic.warnings} warnings)`);
        for (const issue of [...store.canonical.issues, ...store.semantic.issues]) console.log(`- [${issue.severity}] ${issue.code}${issue.taskId ? ` ${issue.taskId}` : ''}: ${issue.message}`);
        if (gated) { printGateSummary(gated.combined); warnBoardScopedErrors(gated.combined); }
      } else if (store.status === 'maintenance-needed') console.log(`Store needs maintenance: ${store.maintenanceNeeded}`);
      else if (store.status === 'not-materialized') console.log(`Store not materialized at ${store.storeDir}. Run \`mapctx store init\`.`);
      if (options.snapshots) console.log(`Snapshot inspection: ${snapshotFailed ? 'FAIL' : 'PASS'}`);
    }
    const canonicalFailed = store.status === 'store-authority' && (store.canonical.errors > 0 || store.semantic.errors > 0);
    const storeUnavailable = store.status === 'not-materialized' || store.status === 'maintenance-needed';
    if (canonicalFailed || storeUnavailable || snapshotFailed) throw new Error('mapctx validate failed.');
    return;
  }

  // Markdown authority remains compatible: structural validation is the
  // operational source and no store snapshot mode is needed. T-127: the same
  // gate applies here, because the markdown structural report emits the same
  // {severity, code, message, taskId?} issues.
  const gateApplied = Boolean(gateOptions.tasks || gateOptions.baseline);
  let validation: ReturnType<typeof getValidationReport> | null = null;
  let structuralError: Error | null = null;
  try {
    // The gate has to recount, so the report is always obtained as data and
    // printed here once the selectors have been applied.
    validation = getValidationReport(options);
  } catch (error) { structuralError = error instanceof Error ? error : new Error(String(error)); }
  const gate = validation ? applyValidationGate(validation.issues, gateOptions) : null;
  if (gateOptions.writeBaselinePath) {
    if (!validation || !gate) throw new Error(`Cannot record a baseline: ${structuralError?.message ?? 'board resolution failed.'}`);
    writeValidateBaseline(gateOptions.writeBaselinePath, gate.issues, options.json);
    return;
  }
  const report = validation && gate
    ? { ...validation, errors: gate.errors, warnings: gate.warnings, issues: gate.issues }
    : null;
  const store = validateStoreRegime(cwd);
  if (options.json) {
    if (report) {
      print({
        ...report,
        store,
        ...(gateApplied && gate
          ? { gate: { taskFilter: gate.taskFilter, filteredOutByTask: gate.filteredOutByTask, boardScopedExcluded: gate.boardScopedExcluded, boardScopedErrors: gate.boardScopedErrors, baselined: gate.baselined, staleBaseline: gate.staleBaseline } }
          : {})
      }, true);
      if (gate) warnBoardScopedErrors(gate);
    } else {
      print({ error: 'board-resolution-failed', message: structuralError?.message ?? 'Board resolution failed.', tasksFilePath: options.tasksFileOverride ? path.resolve(cwd, options.tasksFileOverride) : null, store }, true);
    }
  } else if (report) {
    printValidationReport(report, false);
    if (gate) { printGateSummary(gate); warnBoardScopedErrors(gate); }
  }
  if (structuralError || (report && report.errors > 0)) throw new Error('mapctx validate failed.');
}

/**
 * T-134: the refusal has to stay actionable in HUMAN mode too, where T-127's
 * A9 stopped printing the structured payload. Without this the operator saw
 * only "Claim failed: active-claim-held" and had no way to learn who holds
 * the task or when the lease lapses -- the two facts that decide whether to
 * wait or to escalate. The token is deliberately not among them.
 */
/**
 * Review F2: the first version rendered `JSON.stringify(holder)` verbatim and
 * unbounded, which was wrong twice. The DEFAULT holder is `{pid, host}` --
 * nobody opts into that -- so an internal hostname and pid were disclosed to
 * anyone who merely tried to claim a busy task; and a 300-character holder
 * echoed the whole thing (a secret-looking field included) into human stderr,
 * putting raw JSON back in the channel T-126/T-127 kept it out of.
 *
 * So: only keys a holder uses to IDENTIFY itself, each clipped, joined without
 * braces, with a total cap. `pid`/`host` are deliberately not among them --
 * another agent's process id is not actionable, while `claimId` and
 * `expiresAt` already answer "wait or escalate". The full holder stays in the
 * `--json` payload, which is the structured channel and is the caller's own
 * self-reported data.
 */
const HOLDER_IDENTITY_KEYS = ['provider', 'agent', 'actor', 'name', 'epic'] as const;
const HOLDER_VALUE_LIMIT = 40;
const HOLDER_RENDER_LIMIT = 100;

export function renderHolder(holder: Record<string, unknown> | undefined): string {
  const fields = Object.entries(holder ?? {});
  if (fields.length === 0) return 'an unidentified holder';
  const named = fields
    .filter(([key]) => (HOLDER_IDENTITY_KEYS as readonly string[]).includes(key))
    .map(([key, value]) => {
      // Clip and strip, so neither a long value nor a brace/newline reaches
      // the one-line human channel.
      const text = String(value).replace(/[{}\r\n]/g, ' ').trim();
      return `${key}=${text.length > HOLDER_VALUE_LIMIT ? `${text.slice(0, HOLDER_VALUE_LIMIT)}…` : text}`;
    });
  if (named.length === 0) return `an unidentified holder (${fields.length} field(s))`;
  const joined = named.join(' ');
  return joined.length > HOLDER_RENDER_LIMIT ? `${joined.slice(0, HOLDER_RENDER_LIMIT)}…` : joined;
}

function activeClaimSuffix(activeClaim: DisclosableClaimRecord | undefined): string {
  if (!activeClaim) return '';
  return ` -- claim ${activeClaim.claimId} held by ${renderHolder(activeClaim.holder)}, expires ${activeClaim.expiresAt}`;
}

/**
 * T-141 (C2 / D3): lease resolution for `task claim` and `task start`, in one
 * place so the two entry points cannot drift on precedence.
 *
 *     --lease  >  [coordination] in mapctx.toml  >  derived from the plan
 *
 * `--lease` is honoured as written and is deliberately NOT clamped by
 * `maxLease`: D3 makes the flag the operator's explicit choice, and quietly
 * shrinking `--lease 12h` to 8 h is the kind of silent adjustment this CLI
 * refuses everywhere else. The bound on an over-long lease is C4's 24 h
 * absolute renewal ceiling (D4), which lands with the heartbeat path.
 */
function resolveCoordination(cwd: string): CoordinationSettings {
  return resolveCoordinationSettings(resolveMapctxToml(cwd)?.config.coordination);
}

/** The `--lease` override in milliseconds, or undefined when the flag is absent. */
function leaseOverrideMs(options: MapctxOptions): number | undefined {
  if (options.lease === undefined) return undefined;
  const parsed = parseEstimatedEffortMs(options.lease);
  if (parsed === null) {
    refuse(
      { ok: false, reason: 'invalid-lease', lease: options.lease },
      `--lease must be a positive duration like 30m, 4h or 1d (got "${options.lease}").`
      + ' Omit it to use the lease derived from estimatedEffort and [coordination] in mapctx.toml.'
    );
  }
  // B3: the flag is not clamped by `maxLease` on purpose (it is the operator's
  // override), but "not clamped" is not "unbounded": `--lease 9999w` used to
  // write an expiry in 2072 and hold the lane until somebody released it by
  // hand. Refused, not silently shrunk, so the override keeps meaning exactly
  // what it says -- against D4's 24 h ceiling, the same number C4 will enforce
  // on the renewal paths.
  if (parsed > ABSOLUTE_LEASE_CEILING_MS) {
    refuse(
      { ok: false, reason: 'lease-above-ceiling', lease: options.lease, ceilingMs: ABSOLUTE_LEASE_CEILING_MS },
      `--lease ${options.lease} exceeds the absolute lease ceiling of 24h (D4).`
      + ' A lane held longer than a day is a stuck lane, not a long task: split the task, or release and re-claim.'
    );
  }
  return parsed;
}

export function taskClaimCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const holder = options.holder ? (JSON.parse(options.holder) as Record<string, unknown>) : { pid: process.pid, host: os.hostname() };
    const result = claimTask(handle, {
      taskId,
      actor: defaultActor(options.actor),
      holder,
      leaseDurationMs: leaseOverrideMs(options),
      coordination: resolveCoordination(cwd)
    });
    if (!result.ok) refuse(result, `Claim failed: ${result.reason}${activeClaimSuffix(result.activeClaim)}`);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

export function taskShowCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    print({ ...queryTaskFromMarkdown(path.dirname(tasksFilePath), taskId, tasksFilePath), tasksFilePath }, options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd, { mode: 'read' });
  try {
    print({ ...queryTask(handle.db, taskId), tasksFilePath: resolveStoreCheckpointPath(cwd, options, toml.dir) }, options.json);
  } finally {
    handle.close();
  }
}

export function taskContextCommand(taskId: string, options: MapctxOptions): void {
  if (!options.budget) throw new Error('task context requires --budget <n>');
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    print({ ...queryTaskContextFromMarkdown(path.dirname(tasksFilePath), taskId, { budget: options.budget }, tasksFilePath), tasksFilePath }, options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd);
  try {
    print({
      ...queryTaskContext(handle.db, taskId, { budget: options.budget, tasksRoot: toml.dir }),
      tasksFilePath: resolveStoreCheckpointPath(cwd, options, toml.dir)
    }, options.json);
  } finally {
    handle.close();
  }
}

export function taskSearchCommand(options: MapctxOptions): void {
  if (!options.query || !options.query.trim()) throw new Error('task search requires --query "<text>"');
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    const board = parseTasksFile(tasksFilePath);
    const hits = board.tasks.map(task => ({
      taskId: task.id,
      title: task.title,
      planningState: task.status,
      completedOn: task.completed,
      tags: task.tags ?? [],
      domains: task.domains ?? task.touch ?? [],
      summary: null
    }));
    print({
      query: options.query,
      matches: filterTaskSearchHits(hits, { query: options.query, status: options.status, limit: options.limit })
    }, options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd, { mode: 'read' });
  try {
    print({
      query: options.query,
      matches: searchTasks(handle.db, { query: options.query, status: options.status, limit: options.limit })
    }, options.json);
  } finally {
    handle.close();
  }
}

export function mapctxPlanCommand(options: MapctxOptions): void {
  const planner = require('@mapctx/planner') as { planExecution: (input: unknown) => unknown };
  const toml = resolveMapctxToml(process.cwd());
  if (!toml || toml.config.plansAuthority !== 'store') {
    // Planning is read-only. Before cutover, use the same TASKS.md fallback
    // as mapcs plan instead of forcing operators to materialize a store.
    const tasksFilePath = resolveTasksFilePath(process.cwd(), options);
    const board = parseTasksFile(tasksFilePath);
    // dependencyEdges is the single source of truth for board-sourced plans; task.dependsOn is
    // omitted here so the same relation is never sent to the planner twice (see T-063).
    const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
      fromTaskId: task.id,
      toTaskId,
      kind: 'depends-on' as const
    })));
    const report = planner.planExecution({
      tasks: board.tasks.map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        type: task.type,
        parent: task.parent ?? null,
        domains: task.domains ?? task.touch ?? []
      })),
      dependencyEdges
    });
    print({ ...(report as Record<string, unknown>), tasksFilePath }, options.json);
    return;
  }

  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd, { mode: 'read' });
  try {
    const tasks = listTasks(handle.db);
    const edges = listDependencies(handle.db);
    const detailsByTaskId = new Map(tasks.map(task => [task.taskId, getTaskDetail(handle.db, task.taskId)]));
    // dependencyEdges is the single source of truth here too; task.dependsOn is omitted (see
    // the TASKS.md fallback branch above and T-063).
    const report = planner.planExecution({
      tasks: tasks.map(task => ({
        id: task.taskId,
        title: task.title,
        status: task.planningState,
        type: task.type ?? undefined,
        parent: task.parentTaskId ?? null,
        domains: task.domains,
        // Store projections keep detail separately; pass its file evidence to
        // planner so filesAffected can override broad inferred domains.
        filesAffected: detailsByTaskId.get(task.taskId)?.filesAffected ?? []
      })),
      dependencyEdges: edges.map(edge => ({ fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind }))
    });
    print({ ...(report as Record<string, unknown>), tasksFilePath: resolveStoreCheckpointPath(cwd, options, toml.dir) }, options.json);
  } finally {
    handle.close();
  }
}

/**
 * Emits the complete Gantt dataset (planned/forecast/actual/waves/blockers/
 * collisions/violations) as JSON. Works pre-cutover like `plan`, `task show`,
 * and `task context` -- planning and forecasting are read-only, so neither
 * needs a materialized store. Authored planned dates (start/due) are carried
 * into the dataset so both the CLI and workspace host expose one complete,
 * query-backed contract. See T-055.
 */
export function mapctxGanttCommand(options: MapctxOptions): void {
  const toml = resolveMapctxToml(process.cwd());
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(process.cwd(), options);
    const tasksRoot = path.dirname(tasksFilePath);
    const board = parseTasksFile(tasksFilePath);
    const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
      fromTaskId: task.id,
      toTaskId,
      kind: 'depends-on' as const
    })));
    const dataset = buildGanttDataset({
      tasks: board.tasks.map(task => {
        const detailPath = task.detail && task.detail !== 'null' ? path.resolve(tasksRoot, task.detail) : null;
        const detail = detailPath && fs.existsSync(detailPath) ? readTaskDetailFile(detailPath) : null;
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          type: task.type,
          parentId: task.parent ?? null,
          start: task.start ?? null,
          due: task.due ?? null,
          domains: task.domains ?? task.touch ?? [],
          workload: task.workload as string | null,
          estimatedEffort: detail?.estimatedEffort ?? null,
          estimatedEffortSource: detail?.estimatedEffortSource ?? (detail?.estimatedEffort ? 'legacy-human' : undefined),
          predictedStart: null,
          // No cutover means no store, so there are no receipts to read yet.
          receipts: []
        };
      }),
      dependencyEdges,
      mode: 'pre-cutover'
    });
    print(dataset, options.json);
    return;
  }

  const { handle, storeDir } = openStoreOrFail(process.cwd(), { mode: 'read' });
  try {
    const tasks = listTasks(handle.db);
    const edges = listDependencies(handle.db);
    const detailsByTaskId = new Map(tasks.map(task => [task.taskId, getTaskDetail(handle.db, task.taskId)]));
    // T-116: receipts invalidated by an accepted history correction are not
    // actuals. Original rows stay queryable in the store; the roadmap simply
    // stops displaying and calibrating on them.
    const invalidated = listInvalidatedReceiptKeys(handle.db);
    const validReceiptsFor = (taskId: string) =>
      listReceiptsForTask(handle.db, taskId).filter(receipt => !invalidated.has(`${receipt.dispatchId}/${receipt.attempt}`));
    const dataset = buildGanttDataset({
      tasks: tasks.map(task => ({
        id: task.taskId,
        title: task.title,
        status: task.planningState,
        type: task.type ?? undefined,
        parentId: task.parentTaskId ?? null,
        start: task.startDate ?? null,
        due: task.dueDate ?? null,
        domains: task.domains,
        filesAffected: detailsByTaskId.get(task.taskId)?.filesAffected ?? [],
        workload: task.workload as string | null,
        estimatedEffort: detailsByTaskId.get(task.taskId)?.estimatedEffort ?? null,
        estimatedEffortSource: detailsByTaskId.get(task.taskId)?.estimatedEffortSource ?? "legacy-human",
        estimateSnapshot: listEstimateSnapshots(handle.db, task.taskId).slice(-1)[0] ?? null,
        predictedStart: task.predictedStart ?? null,
        receipts: validReceiptsFor(task.taskId)
      })),
      dependencyEdges: edges.map(edge => ({ fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind })),
      historyDates: readHistoryDates(path.join(storeDir, 'history-dates.json')),
      claimViolations: listClaimViolations(handle.db, {}),
      mode: 'store'
    });
    print(dataset, options.json);
  } finally {
    handle.close();
  }
}

/**
 * Emits the kanban board dataset (title/mode/tasks) as JSON, mirroring
 * `gantt`: pre-cutover it parses TASKS.md; under store authority it reads the
 * SQLite store through the same field mapping as the checkpoint export, so
 * the board view can never disagree with the canonical store. The
 * workspace server forwards this dataset for both the page bootstrap and
 * /api/board (T-094).
 */
export function mapctxBoardCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    const board = parseTasksFile(tasksFilePath);
    print({
      title: board.title,
      mode: detectWorkspaceModel(fs.readFileSync(tasksFilePath, 'utf8')),
      tasks: board.tasks.map(toWorkspaceTaskView)
    }, options.json);
    return;
  }

  const { handle } = openStoreOrFail(cwd, { mode: 'read' });
  try {
    const tasks = listTasks(handle.db);
    const edges = listDependencies(handle.db);
    const project = getSingleProject(handle.db);
    print({
      title: project?.boardTitle ?? 'MapCtx Workspace',
      mode: 'store',
      tasks: tasks.map(task => toWorkspaceTaskViewFromStoreRecord(
        task,
        edges.filter(edge => edge.fromTaskId === task.taskId && edge.kind === 'depends-on').map(edge => edge.toTaskId),
        deriveSubIssueProgress(task.taskId, tasks)
      ))
    }, options.json);
  } finally {
    handle.close();
  }
}

/**
 * T-143 (C4 / D3): `mapctx run event <dispatch-id>` -- the renewal path that
 * needs no secret, because it is addressed by the dispatch an orchestrator
 * already holds.
 *
 * The problem it answers, measured in this store: renewal required
 * `--claim/--token`, a credential printed once to whoever ran `task start`,
 * so the executing agent had to interrupt itself every lease to stay alive.
 * It did not happen -- 26 renewal events across 162 claims, 8% of claims ever
 * renewed. Here liveness is a by-product of working: emit one event where the
 * run already pauses.
 *
 * The event is ALWAYS the deliverable; the renewal is reported beside it. A
 * stale attempt, a landed receipt, a missing or expired claim and the 24 h
 * ceiling each leave the event recorded and say, in `renewal.reason`, that
 * nothing was extended -- because "we wrote your event but silently did not
 * keep your lane alive" is exactly the failure an agent must be able to see.
 *
 * `--attempt` and `--sequence` exist because `runEventSchema` requires both,
 * so the CLI cannot omit them. Deriving the attempt makes "the caller's
 * attempt is the latest" a tautology, which is why the guarantee that matters
 * is the refusal of an explicitly OLDER one: naming a dead attempt is a
 * mistake about which lane you are in, and answering it with a recorded event
 * that renews nothing would hide that mistake behind exit 0.
 */
function runEventCommand(dispatchId: string, options: MapctxOptions): void {
  const type = options.type;
  if (!type || !isLivenessRunEventType(type)) {
    throw new Error(
      `run event requires --type ${LIVENESS_RUN_EVENT_TYPES.join('|')}`
      + `${type ? `; "${type}" is not one of them` : ''}.`
      + ' These are the liveness types this command can write, and the ones excluded from active-time measurement.'
    );
  }

  let payload: Record<string, unknown> = {};
  if (options.payload !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.payload);
    } catch (error) {
      throw new Error(`--payload must be JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--payload must be a JSON object, e.g. --payload \'{"slice":"2/5"}\'.');
    }
    payload = parsed as Record<string, unknown>;
  }

  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const attempts = listDispatchAttempts(handle.db, dispatchId);
    if (attempts.length === 0) {
      refuse({ ok: false, reason: 'unknown-dispatch', dispatchId }, `Unknown dispatch: ${dispatchId}.`);
    }
    const latestAttempt = Math.max(...attempts.map(attempt => attempt.attempt));
    if (options.attempt !== undefined && options.attempt < latestAttempt) {
      refuse(
        { ok: false, reason: 'stale-attempt', attempt: options.attempt, latestAttempt },
        `Attempt ${options.attempt} is older than this dispatch's latest attempt (${latestAttempt}).`
        + ' Record liveness against the attempt that is running, or omit --attempt to use the latest.'
      );
    }
    if (options.attempt !== undefined && !attempts.some(attempt => attempt.attempt === options.attempt)) {
      refuse(
        { ok: false, reason: 'unknown-attempt', attempt: options.attempt, latestAttempt },
        `Dispatch ${dispatchId} has no attempt ${options.attempt} (latest is ${latestAttempt}).`
      );
    }
    const attempt = options.attempt ?? latestAttempt;

    // Next unused sequence for THIS attempt. An explicit --sequence is kept
    // as given: colliding with a recorded one is answered by the writer's
    // existing duplicate/conflicting refusal, which is also why a replayed
    // event cannot renew -- it never reaches the append.
    const recorded = listRunEvents(handle.db, dispatchId, attempt);
    const sequence = options.sequence
      ?? (recorded.length === 0 ? 0 : Math.max(...recorded.map(event => event.sequence)) + 1);

    const actor = defaultActor(options.actor);
    const result = recordRunEvent(
      handle,
      { schemaVersion: 1, dispatchId, attempt, sequence, type, timestamp: new Date().toISOString(), payload },
      actor,
      dispatchId,
      { renew: { coordination: resolveCoordination(cwd), actor } }
    );
    if (!result.ok) {
      refuse(
        result,
        `run event refused: ${result.reason}`
        + (result.reason === 'duplicate-run-event' || result.reason === 'conflicting-run-event'
          ? ` -- attempt ${attempt} already holds sequence ${sequence}. Omit --sequence to take the next unused one.`
          : '')
      );
    }
    print(result, options.json);
  } finally {
    handle.close();
  }
}

function taskRenewCommand(taskId: string, options: MapctxOptions): void {
  // B1: `--lease` lives in the global VALUE_FLAGS table (claim/start need it),
  // so the parser accepts it here too -- and this command used to drop it in
  // silence while the help and the CHANGELOG said it "is not offered", which
  // a reader takes for a refusal. Refused before anything else, so passing it
  // is answered by name even when the token is missing as well. Same shape as
  // `acceptance unapprove --evidence`: refuse caller input, never discard it.
  if (options.lease !== undefined) {
    refuse(
      { ok: false, reason: 'lease-not-accepted-on-renew', lease: options.lease },
      '--lease is not accepted by task renew; a renewal re-derives the lease from the task plan.'
      + ' Set the size when the lane opens (task claim/start --lease), or tune [coordination] in mapctx.toml.'
    );
  }
  // T-142: `--dispatch-id` is the spelling `task start` uses for the same
  // identifier, so it is the spelling a hand reaches for here -- and it is a
  // known global flag, which means the parser would accept it and this command
  // would then renew nothing while exiting 0. Refused by name, same reason as
  // `--lease` above (B1): never discard caller input.
  if (options.dispatchId !== undefined) {
    refuse(
      { ok: false, reason: 'dispatch-id-not-accepted-on-renew', dispatchId: options.dispatchId },
      'task renew addresses a dispatch with --dispatch <id>, not --dispatch-id (which belongs to task start/dispatch create).'
    );
  }
  const addresses = [options.claimId !== undefined, options.dispatch !== undefined].filter(Boolean).length;
  const credentials = [options.leaseToken !== undefined, options.renewToken !== undefined].filter(Boolean).length;
  if (addresses !== 1 || credentials !== 1) {
    throw new Error(
      'task renew takes exactly one address and exactly one credential:'
      + ' --claim <id> (with the task id) or --dispatch <id> to look the claim up,'
      + ' plus --token <leaseToken> or --renew-token <renewToken>.'
      + ' The renew token renews only; releasing still requires --token.'
    );
  }
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const result = renewClaim(handle, {
      // With `--dispatch` the task id is an assertion, not the address: the
      // dispatch names its own task, and a mismatch is refused rather than
      // silently renewing the lane the caller did not mean.
      taskId,
      claimId: options.claimId,
      dispatchId: options.dispatch,
      leaseToken: options.leaseToken,
      renewToken: options.renewToken,
      actor: defaultActor(options.actor),
      coordination: resolveCoordination(cwd)
    });
    if (!result.ok) refuse(result, `Renew failed: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

function taskReleaseCommand(taskId: string, options: MapctxOptions): void {
  if (!options.claimId || !options.leaseToken) throw new Error('task release requires --claim <id> --token <token>');
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const result = releaseClaim(handle, { taskId, claimId: options.claimId, leaseToken: options.leaseToken, actor: defaultActor(options.actor) });
    if (!result.ok) refuse(result, `Release failed: ${result.reason}`);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

function readReceiptPayload(options: MapctxOptions): unknown {
  if (options.receiptPath) return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options.receiptPath), 'utf8'));
  if (!process.stdin.isTTY) {
    const input = fs.readFileSync(0, 'utf8').trim();
    if (input) return JSON.parse(input);
  }
  throw new Error('dispatch receipt requires --receipt <path> or JSON on stdin');
}

export function dispatchReceiptCommand(dispatchId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    if (options.readReceipt) {
      print({
        ok: true,
        dispatchId,
        attempts: listDispatchAttempts(handle.db, dispatchId),
        receipts: listReceiptsForDispatch(handle.db, dispatchId)
      }, options.json);
      return;
    }
    const receipt = readReceiptPayload(options) as Parameters<typeof recordRunReceipt>[1];
    // T-126: receipts carry agent-authored evidence and failure text, the
    // other place production identifiers have leaked into the journal.
    warnPrivacy(`dispatch receipt ${dispatchId}`, receipt, cwd, { rootPath: 'receipt', eventType: 'run.receipt-recorded' });
    if (options.claudeTranscriptPath) {
      const activity: OtherSessionActivity[] = options.otherSessionActivityPath
        ? JSON.parse(fs.readFileSync(path.resolve(cwd, options.otherSessionActivityPath), 'utf8')) as OtherSessionActivity[]
        : [];
      if (!Array.isArray(activity) || !activity.every(item => item && typeof item.start === 'string' && typeof item.end === 'string' && typeof item.sessionId === 'string' && item.sessionId.length > 0 && Number.isFinite(Date.parse(item.start)) && Number.isFinite(Date.parse(item.end)) && Date.parse(item.end) > Date.parse(item.start))) {
        throw new Error('--other-session-activity requires valid positive {start,end,sessionId} spans');
      }
      receipt.timeEvidence = extractClaudeIntervals(
        fs.readFileSync(path.resolve(cwd, options.claudeTranscriptPath), 'utf8'),
        {
          ...(options.idleThresholdMs === undefined ? {} : { idleThresholdMs: options.idleThresholdMs }),
          ...(options.reviewThresholdMs === undefined ? {} : { reviewThresholdMs: options.reviewThresholdMs }),
          ...(options.parkedThresholdMs === undefined ? {} : { parkedThresholdMs: options.parkedThresholdMs }),
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone })
        }, activity
      );
    }
    const result = recordRunReceipt(handle, receipt, defaultActor(options.actor), dispatchId);
    // R10: accepted receipts mutate generated state (completed moves planning
    // to review, failed moves it to ready; time-budget consumption changes),
    // so the canonical files must follow in the same operation -- exactly like
    // claim/move do. An export failure is reported DISTINCTLY: the receipt is
    // already accepted and persisted, so callers must not blindly retry.
    if (!result.ok) refuse(result, `Receipt rejected: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

/**
 * Writing tasks is a store-authority operation: in the Markdown regime the
 * files themselves are authoritative and are edited directly, so a CLI write
 * path here would create a second writer. Fail closed with that explanation
 * instead of silently picking a side.
 */
function requireStoreAuthority(cwd: string): { toml: { config: MapctxTomlConfig; path: string; dir: string }; handle: StoreHandle; tasksRoot: string } {
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    throw new Error('task write commands require plansAuthority=store (mapctx.toml). Pre-cutover, edit TASKS.md and tasks/<ID>.md directly.');
  }
  const { handle } = openStoreOrFail(cwd);
  return { toml, handle, tasksRoot: toml.dir };
}

const LIST_SET_FIELDS = new Set(['tags', 'domains', 'assignees', 'externalLinks', 'filesAffected', 'testsRequired', 'prerequisites', 'blocking']);

const LIST_SYNTAX_HELP = 'use `a,b,c` (bare, comma-separated) or a JSON array like `["a","b"]`';

/**
 * A comma inside a list ELEMENT is unrepresentable, whichever spelling put it
 * there (review A2). The generated snapshots join lists with ", " and parse
 * them by splitting on "," (core markdown `toArrayString`/`parseArray`,
 * store `export.ts`), so `["src/{a,b}.ts"]` round-trips as TWO entries. Before
 * T-127 the comma was the only separator, so such an element was unreachable;
 * the JSON spelling made it reachable in every list field, and the resulting
 * drift does not converge -- `reconcile --accept` would write the split value
 * back into the store.
 */
const COMMA_IN_ELEMENT_HELP =
  'a comma inside a list element is not representable in the generated snapshots '
  + '(they join with "," and split on it). Use a comma-free glob like `src/*.ts`, '
  + 'or list the paths separately.';

/** Brackets/braces/parens that must stay balanced within one element. */
const DELIMITER_PAIRS: Array<[string, string]> = [['[', ']'], ['{', '}'], ['(', ')']];

/**
 * Review A3: `src/{a,b}.ts` used to be comma-split in silence into `src/{a`
 * and `b}.ts` -- the same silent corruption T-127 closes for brackets, in the
 * same field, and exactly the brace pattern T-132 taught the planner to
 * expand. An element left with an unbalanced delimiter after the split is a
 * group that was cut in half, so it is refused instead of stored broken.
 */
function unbalancedDelimiter(element: string): string | null {
  for (const [open, close] of DELIMITER_PAIRS) {
    let depth = 0;
    for (const char of element) {
      if (char === open) depth += 1;
      else if (char === close) depth -= 1;
      if (depth < 0) return close;
    }
    if (depth > 0) return open;
  }
  return null;
}

/**
 * T-127: list-valued inputs used to be comma-split unconditionally, so
 * `--set detail.filesAffected=[a,b]` -- the shape every agent reaches for --
 * was accepted in silence and stored `["[a", "b]"]`, brackets and quotes
 * welded onto the values. That actually corrupted T-126's filesAffected on
 * this board and hid a real file overlap from the planner.
 *
 * Now there are exactly two accepted spellings and no silent third one:
 * a bare comma list, or a JSON array of strings. Anything bracket-shaped must
 * be valid JSON, and an element that is wholly wrapped in quotes is refused
 * rather than stored with the quotes as part of the value. Refusals name the
 * correct syntax, because an agent that guessed once will guess again.
 */
export function parseListInput(label: string, raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  // Review B3: for a URL the remedy is percent-encoding, not a glob.
  const commaHelp = label.includes('externalLinks')
    ? `${COMMA_IN_ELEMENT_HELP} For a URL, percent-encode the comma as \`%2C\`.`
    : COMMA_IN_ELEMENT_HELP;
  // BOTH ends, not either (review A1): `endsWith(']')` alone rejected every
  // path that merely ends in a bracket -- `app/[locale]`, `pages/[slug]`,
  // `src/routes/[id]` -- which are the most common `filesAffected` entries in
  // a web project and stored fine before T-127. Only a value that opens AND
  // closes like an array is read as one.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Review B1: the JSON hint is only reachable advice when the value has
      // no comma. For `[a,b]` -- the canonical mistake this task exists to
      // catch -- `["[a,b]"]` would hit the comma rule next, so suggesting it
      // sent the reader into a second refusal.
      const hint = trimmed.includes(',')
        ? ` If you meant a two-item list, write them bare: \`${trimmed.slice(1, -1)}\`. A single element containing a comma cannot be stored at all: ${commaHelp}`
        : ` A single value that itself contains brackets needs the JSON spelling, e.g. ${JSON.stringify([trimmed])}.`;
      throw new Error(`${label} is bracketed like an array but is not valid JSON: ${raw}. To pass a list, ${LIST_SYNTAX_HELP}.${hint}`);
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new Error(`${label} JSON must be an array of strings, got: ${raw}. To pass a list, ${LIST_SYNTAX_HELP}.`);
    }
    return (parsed as string[]).map(item => item.trim()).filter(Boolean).map(item => {
      if (item.includes(',')) throw new Error(`${label} element ${JSON.stringify(item)} contains a comma: ${commaHelp}`);
      return item;
    });
  }
  const parts = trimmed.split(',');
  // Review B4: the unbalanced-delimiter rule exists to catch a `{a,b}` group
  // cut in half by the comma split. With no comma there was no split, so a
  // one-element input must not be told that one happened -- `a{b`, `a)b`, `}`
  // and `]` are legal POSIX names that stored fine before, and the JSON
  // spelling still takes them.
  const wasSplit = parts.length > 1;
  return parts.map(value => {
    const item = value.trim();
    if (item.length >= 2 && (item.startsWith('"') || item.startsWith("'")) && item.endsWith(item[0])) {
      throw new Error(`${label} element ${item} is wrapped in quotes; bare comma lists are not quoted. To pass a list, ${LIST_SYNTAX_HELP}.`);
    }
    const unbalanced = unbalancedDelimiter(item);
    if (unbalanced !== null) {
      throw new Error(wasSplit
        ? `${label} element ${JSON.stringify(item)} has an unbalanced \`${unbalanced}\`, so a group was split across a comma: ${commaHelp}`
        : `${label} value ${JSON.stringify(item)} has an unbalanced \`${unbalanced}\`. If that is the literal value you want, use the JSON spelling: ${JSON.stringify([item])}.`);
    }
    return item;
  }).filter(Boolean);
}

function parseSetValue(field: string, raw: string, key = field): unknown {
  if (raw === 'null') return null;
  if (LIST_SET_FIELDS.has(field)) return parseListInput(`--set ${key}`, raw);
  return raw;
}

/**
 * T-128 (R1): the ONE piece of closing advice, appended by both closing paths.
 *
 * The acceptance gate itself was never duplicated -- `moveTask` and
 * `finishTask` both call `checkTaskAcceptance`, so `task move --status done`
 * and `task finish` already refused with a byte-identical message (verified
 * against a disposable store before this change). What was missing is that
 * neither refusal told the reader which command actually closes a task, which
 * is how agents ended up picking a path by guesswork. The advice lives here,
 * once, rather than inside the store message, so `mapctx validate`'s
 * `completion-acceptance-incomplete` issue stays a plain statement of fact.
 */
function closingAdvice(taskId: string, reason: string): string {
  if (reason !== 'acceptance-incomplete') return '';
  return ` Once every criterion is approved, close it with \`mapctx task finish ${taskId}\``
    + ` (add --no-snapshot to apply the same gate without regenerating TASKS.md and tasks/*.md).`;
}

/**
 * Review F5: closing a task revokes whatever claim is active on it, which is
 * pre-existing `moveTask` semantics and identical on both closing paths. It
 * was silent, though, and `--no-snapshot` is pitched exactly at a worktree
 * shared with other agents -- the one setting where revoking somebody else's
 * lease matters. Stderr, so it never disturbs the `--json` stdout document,
 * and advisory: the release already happened and is journaled.
 */
function warnForeignClaimRelease(releasedClaimId: string | undefined, actor: string, taskId: string): void {
  if (!releasedClaimId) return;
  console.error(`Warning: closing ${taskId} released the active claim ${releasedClaimId}.`
    + ` If that lease was not yours (${actor}), another agent was holding this task and has just lost it.`);
}

export function taskMoveCommand(taskId: string, options: MapctxOptions): void {
  if (!options.status) throw new Error('task move requires --status <planning-state>');
  const cwd = process.cwd();
  const { handle } = requireStoreAuthority(cwd);
  try {
    const result = moveTask(handle, { taskId, to: toPlanningState(options.status), actor: defaultActor(options.actor) });
    if (!result.ok) {
      refuse(result, `Move refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}${closingAdvice(taskId, result.reason)}`);
    }
    warnForeignClaimRelease(result.releasedClaimId, defaultActor(options.actor), taskId);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

export function taskReopenCommand(taskId: string, options: MapctxOptions): void {
  if (!options.status) throw new Error('task reopen requires --status review');
  const target = toPlanningState(options.status);
  if (target !== 'review') throw new Error('task reopen only supports --status review');

  const cwd = process.cwd();
  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    const result = reopenTask(handle, {
      taskId,
      to: target,
      actor: defaultActor(options.actor)
    });
    if (!result.ok) refuse(result, `Reopen refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    print(result, options.json);
  } finally {
    handle.close();
  }
}

/**
 * T-127: `--tags`, `--domains`, `--depends-on` and `--blocking` take the same
 * two spellings as `--set`, and refuse a bracketed or quoted guess instead of
 * welding the punctuation onto the values. `label` names the flag so the
 * refusal says which argument to retype.
 */
export function splitList(value?: string, label = 'list value'): string[] | undefined {
  if (value === undefined) return undefined;
  return parseListInput(label, value);
}

/**
 * T-136: the description prose from `--description <text>` or
 * `--description-file <path>` (text wins, as it always did on create). A
 * one-line flag value carrying literal `\n` is how a shell hands over
 * "## Scope\n\nbody" -- stored verbatim it becomes a single unreadable line
 * -- so it is unescaped, and the caller is told. A file is read verbatim.
 */
function readDescriptionInput(options: MapctxOptions, cwd: string, refusal: { verb: 'Create' | 'Update'; taskId?: string }): string | undefined {
  const description = readRawDescription(options, cwd);
  // Review F4: an empty value is the usual shell accident (`--description
  // "$NOTES"` with NOTES unset), and on update it would silently erase
  // Git-authored prose -- the one CLI path that destroys it. Refused, not
  // flagged: a task without prose is invalid anyway (import's
  // missing-description), and clearing it on purpose is a hand edit.
  if (description !== undefined && description.trim() === '') {
    const flag = options.description !== undefined ? '--description' : `--description-file ${options.descriptionFile}`;
    refuse(
      { ok: false, reason: 'empty-description', ...(refusal.taskId ? { to: refusal.taskId } : {}) },
      `${refusal.verb} refused: empty-description -- ${flag} is empty or whitespace-only, which would leave ${refusal.taskId ?? 'the task'} with no description. An unset shell variable is the usual cause; pass the text, or edit tasks/<ID>.md by hand.`
    );
  }
  return description;
}

function readRawDescription(options: MapctxOptions, cwd: string): string | undefined {
  if (options.description !== undefined) {
    const raw = options.description;
    if (raw.includes('\n') || !raw.includes('\\n')) return raw;
    console.error('Note: --description had literal \\n and no line breaks; converted \\n to line breaks. Use --description-file to keep the text verbatim.');
    return raw.replace(/\\r\\n|\\n/g, '\n');
  }
  if (options.descriptionFile === undefined) return undefined;
  const descriptionPath = path.resolve(cwd, options.descriptionFile);
  try {
    return fs.readFileSync(descriptionPath, 'utf8');
  } catch (error) {
    throw new Error(`--description-file ${options.descriptionFile} could not be read at ${descriptionPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Registers a new task under store authority. Auto-assigns the next free
 * sequential id for the type's prefix (E for epic, T otherwise) unless --id
 * is given. The description prose (--description / --description-file) is
 * written straight into the new detail file and stays Git-authored from then
 * on -- the store never owns prose.
 */
export function taskCreateCommand(options: MapctxOptions): void {
  if (!options.title) throw new Error('task create requires --title "<title>"');
  const cwd = process.cwd();
  // T-126: lint the operator-supplied text BEFORE the store is opened, so the
  // warning is on screen whether or not the create itself succeeds.
  warnPrivacy('task create', {
    title: options.title,
    summary: options.summary,
    tags: options.tags,
    domains: options.domains
  }, cwd);
  // Parsed before the writable open, like task update: a bracketed list is a
  // syntax refusal, never a schema migration followed by a refusal.
  const tags = splitList(options.tags, '--tags') ?? [];
  const domains = splitList(options.domains, '--domains') ?? [];
  const dependsOn = splitList(options.dependsOn, '--depends-on');
  const blocking = splitList(options.blocking, '--blocking');

  // ---- T-129 criterion 0: acceptance in the SAME command ----
  // Resolved here, before the writable open, so a bad source file refuses
  // without having created anything.
  const description = readDescriptionInput(options, cwd, { verb: 'Create' });
  // T-136 review F3: the description is linted as resolved, so prose from
  // --description-file (headed for a public Git file) is covered too, not
  // only the raw --description flag value.
  if (description !== undefined) warnPrivacy('task create', { description }, cwd);
  let acceptance: { condition: 'criteria' | 'empty'; texts: string[] } | undefined;
  let acceptanceNote: string | undefined;
  if (options.acceptanceFile) {
    // Review F6: every other refusal on this command names the flag; a raw
    // ENOENT did not.
    const acceptancePath = path.resolve(cwd, options.acceptanceFile);
    let source: string;
    try {
      source = fs.readFileSync(acceptancePath, 'utf8');
    } catch (error) {
      throw new Error(`--acceptance-file ${options.acceptanceFile} could not be read at ${acceptancePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const read = readAcceptanceSource(source);
    if (read === null) {
      throw new Error(`--acceptance-file ${options.acceptanceFile} has neither a ## Acceptance section nor any \`- [ ]\` checklist item.`);
    }
    acceptance = { condition: read.condition, texts: read.texts };
    // The description's own section is NOT silently dropped: --acceptance-file
    // wins, and the caller is told which one was used (criterion 0's "seção
    // ignorada gera aviso").
    if (description !== undefined && parseAcceptanceRead(description).condition !== 'absent') {
      acceptanceNote = `Note: both --acceptance-file and a ## Acceptance section in the description were given; the criteria came from --acceptance-file ${options.acceptanceFile} and the description's section was NOT recorded.`;
    } else if (read.headerless) {
      acceptanceNote = `Note: --acceptance-file ${options.acceptanceFile} has no ## Acceptance heading; read ${read.texts.length} checklist item(s) from the whole file.`;
    }
  } else if (description !== undefined) {
    const read = readAcceptanceSource(description);
    // Only a REAL section is promoted from the description. A bare checklist
    // in prose is not an acceptance declaration -- it would turn any
    // description bullet list into criteria -- so it is warned about, not used.
    const sectioned = parseAcceptanceRead(description);
    if (sectioned.condition !== 'absent' && read !== null) {
      acceptance = { condition: read.condition, texts: read.texts };
    } else if (read !== null && read.headerless) {
      acceptanceNote = `Note: the description holds ${read.texts.length} checklist item(s) but no ## Acceptance heading, so NO criteria were recorded. Add the heading, or pass --acceptance-file.`;
    }
  }

  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    const result = createTask(handle, {
      title: options.title,
      id: options.id,
      type: options.type,
      parent: options.parent ?? null,
      status: options.status ? toPlanningState(options.status) : undefined,
      priority: options.priority ?? null,
      workload: options.workload ?? null,
      tags,
      domains,
      dependsOn,
      blocking,
      startDate: options.start ?? null,
      dueDate: options.due ?? null,
      detail: {
        role: options.role,
        impact: options.impact,
        estimatedEffort: options.effort,
        waitReason: options.waitReason,
        summary: options.summary
      },
      ...(acceptance ? { acceptance } : {}),
      actor: defaultActor(options.actor)
    });
    if (!result.ok) refuse(result, `Create refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    if (acceptanceNote) console.error(acceptanceNote);
    if (acceptance) {
      const emptyNote = emptyAcceptanceWarning(result.taskId, acceptance.condition, acceptance.texts.length);
      if (emptyNote) console.error(emptyNote);
    }

    const detailPath = path.resolve(cwd, result.detailPath);
    const generated = buildExport(handle.db, { tasksRoot }).taskDetailFiles.find(file => path.resolve(file.path) === detailPath);
    if (!generated) throw new Error(`Created task detail is missing from canonical export: ${result.detailPath}`);
    const detail = parseTaskDetailFile(generated.content);
    fs.mkdirSync(path.dirname(detailPath), { recursive: true });
    fs.writeFileSync(detailPath, generateTaskDetailFile({ ...detail, ...(description === undefined ? {} : { description }) }), 'utf8');

    print(result, options.json);
  } finally {
    handle.close();
  }
}

export function taskUpdateCommand(taskId: string, options: MapctxOptions): void {
  const setPairs = options.setPairs ?? [];
  const wantsDescription = options.description !== undefined || options.descriptionFile !== undefined;
  if (setPairs.length === 0 && options.dependsOn === undefined && options.blocking === undefined && !wantsDescription) {
    throw new Error('task update requires --set key=value, --depends-on a,b, --blocking x,y, or --description text / --description-file path');
  }
  const patch: Record<string, unknown> = {};
  const detailPatch: Record<string, unknown> = {};
  for (const pair of setPairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`--set expects key=value, got: ${pair}`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (key === 'waitReason') {
      detailPatch.waitReason = raw === 'null' || raw === '' ? null : raw;
    } else if (key === 'predictedStart') {
      // T-102 schema-only prediction: --set predictedStart=null clears, else
      // JSON {start, method, confidence}. Dotted parts also accepted below.
      if (raw === 'null' || raw === '') {
        patch.predictedStart = null;
      } else {
        try {
          patch.predictedStart = JSON.parse(raw);
        } catch {
          throw new Error(`--set predictedStart expects JSON like {"start":"2026-09-01","method":"manual","confidence":"low"} or null, got: ${raw}`);
        }
      }
    } else if (key.startsWith('detail.')) {
      detailPatch[key.slice('detail.'.length)] = parseSetValue(key.slice('detail.'.length), raw, key);
    } else {
      patch[key] = parseSetValue(key, raw);
    }
  }
  // Edge lists are parsed here, with the --set pairs, so a bad list syntax
  // refuses before the writable store handle exists (it migrates schemas and
  // replays journals on open).
  const dependsOn = splitList(options.dependsOn, '--depends-on');
  const blocking = splitList(options.blocking, '--blocking');
  const cwd = process.cwd();
  const description = readDescriptionInput(options, cwd, { verb: 'Update', taskId });
  warnPrivacy(`task update ${taskId}`, { patch, detail: detailPatch, ...(description === undefined ? {} : { description }) }, cwd);
  const storeChange = setPairs.length > 0 || dependsOn !== undefined || blocking !== undefined;
  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    // T-136: the description is Git-authored prose, so it goes to the detail
    // file and never to the store. The new file is fully computed (acceptance
    // rendered from the store, refusals raised) BEFORE any store write, so a
    // bad description refuses without having patched anything.
    let detailWrite: { path: string; content: string; changed: boolean } | undefined;
    if (description !== undefined) {
      const task = getTask(handle.db, taskId);
      if (!task) refuse({ ok: false, reason: 'unknown-task', to: taskId }, `Update refused: unknown-task -- ${taskId}`);
      if (!task.detailPath) refuse({ ok: false, reason: 'no-detail-file', to: taskId }, `Update refused: no-detail-file -- ${taskId} has no tasks/<ID>.md to hold a description`);
      const detailPath = path.resolve(tasksRoot, task.detailPath);
      if (!fs.existsSync(detailPath)) {
        refuse({ ok: false, reason: 'no-detail-file', to: taskId }, `Update refused: no-detail-file -- ${task.detailPath} is missing; run \`mapctx export\` to materialize it first`);
      }
      const current = fs.readFileSync(detailPath, 'utf8');
      const rendered = renderStoreDescription(handle.db, taskId, description);
      const supplied = parseAcceptanceChecklist(description);
      if (supplied.found && JSON.stringify(supplied.items) !== JSON.stringify(parseAcceptanceChecklist(rendered).items)) {
        console.error(`Note: the ## Acceptance checklist of ${taskId} is store-owned; the file shows the store's criteria, not the ones supplied. Change criteria with \`mapctx task acceptance revise ${taskId}\`.`);
      }
      const content = replaceTaskDetailDescription(current, rendered);
      detailWrite = { path: detailPath, content, changed: content !== current };
    }
    let result: Extract<ReturnType<typeof updateTask>, { ok: true }> | undefined;
    if (storeChange) {
      const updated = updateTask(handle, {
        taskId,
        patch: Object.keys(patch).length > 0 ? patch as never : undefined,
        detailPatch: Object.keys(detailPatch).length > 0 ? detailPatch as never : undefined,
        dependsOn,
        blocking,
        actor: defaultActor(options.actor)
      });
      if (!updated.ok) refuse(updated, `Update refused: ${updated.reason}${updated.message ? ` -- ${updated.message}` : ''}`);
      result = updated;
      const effortNote = effortChangedUnderLiveClaimWarning(handle, taskId, detailPatch);
      if (effortNote) console.error(effortNote);
    }
    if (detailWrite?.changed) fs.writeFileSync(detailWrite.path, detailWrite.content, 'utf8');
    print({
      taskId,
      ...(result ?? { ok: true, applied: { fields: [], detailFields: [], edges: false } }),
      ...(detailWrite ? { description: { detailPath: path.relative(tasksRoot, detailWrite.path), changed: detailWrite.changed } } : {})
    }, options.json);
  } finally {
    handle.close();
  }
}

/**
 * T-142, answering the T-141 review's B2: a renewal re-derives the lease from
 * `detail.estimatedEffort`, and nothing requires the editor of that field to
 * be the holder of the claim. Lowering it pins the holder's next renewal to
 * `defaultLease`; raising it extends somebody else's lane.
 *
 * What this is NOT: a refusal, and not a frozen lease either. T-141 decided
 * deliberately that renewal re-derives from the plan, because a task
 * re-classified mid-flight should renew on the new plan and not on the
 * estimate that turned out wrong -- freezing the duration on the claim would
 * undo that decision, and a capability change (C3) is not the place to
 * reverse it. The gap B2 names is not that re-derivation happens, it is that
 * it happened INVISIBLY to the editor.
 *
 * So the edit lands and says what it just did to a live lane, naming the claim
 * by id only -- never a token (T-134 / D1). Advisory on stderr, so `--json`
 * stdout stays one document. Best-effort by construction: the write already
 * succeeded, and no read for a warning may turn a successful update into an
 * error.
 */
function effortChangedUnderLiveClaimWarning(
  handle: { db: Parameters<typeof getLiveActiveClaim>[0] },
  taskId: string,
  detailPatch: Record<string, unknown>
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(detailPatch, 'estimatedEffort')) return undefined;
  try {
    const claim = getLiveActiveClaim(handle.db, taskId, () => new Date());
    if (!claim) return undefined;
    return `Note: ${taskId} has a live claim (${claim.claimId}, expires ${claim.expiresAt}).`
      + ` Its next renewal re-derives the lease from detail.estimatedEffort, so this edit changes the lane's window`
      + ` even though you are not necessarily its holder.`;
  } catch {
    return undefined;
  }
}

/**
 * Review F3: an acceptance revision with NO criteria is exactly the shape
 * `checkTaskAcceptance` refuses `done` for ("revision N in the store is
 * empty"), so recording one silently builds a task that cannot be finished.
 * The create path already warned about the headerless case and the two-source
 * case; this is the one that produced a dead end and said nothing.
 */
function emptyAcceptanceWarning(taskId: string, condition: 'criteria' | 'empty', count: number): string | undefined {
  if (condition !== 'empty' && count > 0) return undefined;
  return `Note: recorded an acceptance revision for ${taskId} with NO criteria. \`task finish\` and \`task move --status done\` will refuse until it is revised with criteria.`;
}

/**
 * T-129 (criteria 0 and 4): reads acceptance criteria from caller-supplied
 * content, preferring a real `## Acceptance` section and falling back to a
 * bare checklist when there is no heading at all.
 *
 * The fallback is what makes `--from-file` usable on a scratch file holding
 * just the list (friction A1.6). It is a FALLBACK, not an alternative: when a
 * real section exists, only that section's items are read, so a file with
 * both a section and unrelated checkboxes elsewhere behaves exactly as before.
 *
 * Returns null when neither reading finds anything, so the caller can refuse
 * with its own message. `headerless` lets the caller say which reading it got.
 */
function readAcceptanceSource(content: string): { condition: 'criteria' | 'empty'; texts: string[]; headerless: boolean } | null {
  const sectioned = parseAcceptanceRead(content);
  if (sectioned.condition === 'criteria') {
    return { condition: 'criteria', texts: sectioned.items.map(item => item.text), headerless: false };
  }
  if (sectioned.condition === 'empty') return { condition: 'empty', texts: [], headerless: false };
  const bare = parseBareAcceptanceChecklist(content);
  if (bare.length === 0) return null;
  return { condition: 'criteria', texts: bare.map(item => item.text), headerless: true };
}

/**
 * T-127 (R4 item 6): a missing `--expect-revision` used to refuse without
 * saying what to pass, so the agent had to go run `acceptance show` and come
 * back. The number is one read-only lookup away, so the refusal carries it --
 * and the whole hint is best-effort: a store that cannot be read read-only
 * (absent, pre-cutover, mid-maintenance) must still produce the plain refusal,
 * never a second, unrelated error.
 */
function currentRevisionHint(cwd: string, taskId: string): string {
  try {
    const { handle } = openStoreOrFail(cwd, { mode: 'read' });
    try {
      const acceptance = getAcceptance(handle.db, taskId);
      return acceptance
        ? ` The store currently holds revision ${acceptance.revision} for ${taskId}: pass --expect-revision ${acceptance.revision}.`
        : ` No acceptance revision exists for ${taskId} yet: pass --expect-revision 0.`;
    } finally {
      handle.close();
    }
  } catch {
    return '';
  }
}

export function taskAcceptanceCommand(action: string | undefined, taskId: string | undefined, options: MapctxOptions): void {
  if (!action || !taskId) throw new Error('Usage: mapctx task acceptance <show|revise|approve|unapprove> <task-id> [options]');
  const cwd = process.cwd();
  // ---- Preflight: EVERY input that can refuse is validated here, before
  // any store handle exists (attempt-6 review): a malformed --evidence, a
  // missing --expect-revision, a bad selector or source file must never
  // trigger the writable open, because StoreHandle.open migrates schemas,
  // replays pending journals and writes identity metadata. ----
  let reviseArgs: { condition: "criteria" | "empty"; texts: string[] } | undefined;
  let expectRevision: number | undefined;
  let approveEvidence: Record<string, string> | undefined;
  if (action === 'revise') {
    if (!options.fromFile) throw new Error('acceptance revise requires --from-file <detail.md>');
    if (options.expectRevision === undefined) {
      throw new Error(`acceptance revise requires --expect-revision <current-revision> (use 0 when no revision exists).${currentRevisionHint(cwd, taskId)}`);
    }
    const source = fs.readFileSync(path.resolve(cwd, options.fromFile), 'utf8');
    const read = readAcceptanceSource(source);
    if (read === null) {
      throw new Error('Source has neither a ## Acceptance section nor any `- [ ]` checklist item; use a file with explicit checklist criteria.');
    }
    if (read.headerless) {
      // Said once, on stderr, so --json stdout stays a clean document: the
      // caller should know WHICH reading produced the criteria.
      console.error(`Note: ${options.fromFile} has no ## Acceptance heading; read ${read.texts.length} checklist item(s) from the whole file.`);
    }
    expectRevision = options.expectRevision;
    reviseArgs = { condition: read.condition, texts: read.texts };
  } else if (action === 'approve' || action === 'unapprove') {
    if (options.expectRevision === undefined) {
      throw new Error(`acceptance ${action} requires --expect-revision <current-revision>.${currentRevisionHint(cwd, taskId)}`);
    }
    if (options.all && action === 'unapprove') {
      throw new Error('acceptance unapprove does not take --all; unapproving is a per-criterion decision.');
    }
    if (!options.all && options.criterionId === undefined && options.indices === undefined) {
      throw new Error(`acceptance ${action} requires --criterion-id <id>, --index <n[,n...]>${action === 'approve' ? ' or --all' : ''}`);
    }
    if (options.all && (options.criterionId !== undefined || options.indices !== undefined)) {
      throw new Error('acceptance approve takes --all or an explicit --index/--criterion-id, not both.');
    }
    if (action === 'unapprove' && options.indices !== undefined && options.indices.length > 1) {
      throw new Error('acceptance unapprove takes a single --index; unapproving is a per-criterion decision.');
    }
    // Evidence belongs to approvals only; refusing it on unapprove keeps
    // the CLI from silently dropping caller input (review: CLI evidence gap).
    if (action === 'unapprove' && (options.evidencePairs ?? []).length > 0) {
      throw new Error('acceptance unapprove does not take --evidence; evidence belongs to approvals.');
    }
    expectRevision = options.expectRevision;
    // Parse BEFORE any store call: a malformed pair must refuse with zero
    // mutations, never after an approval landed (or after a migration).
    if (action === 'approve' && (options.evidencePairs ?? []).length > 0) {
      approveEvidence = parseEvidencePairs(options.evidencePairs);
      // T-126: approval evidence is the exact field R5 was found in. Warn
      // here, in the preflight, before any store handle exists.
      warnPrivacy(`acceptance approve ${taskId}`, { evidence: approveEvidence }, cwd, { eventType: 'acceptance.approved' });
    }
  } else if (action !== 'show') {
    throw new Error(`Unknown acceptance action: ${action}`);
  }

  if (action === 'show') {
    const { handle } = openStoreOrFail(cwd, { mode: 'read' });
    try { print({ taskId, acceptance: getAcceptance(handle.db, taskId) ?? { condition: 'absent' } }, options.json); }
    finally { handle.close(); }
    return;
  }
  const { handle } = requireStoreAuthority(cwd);
  try {
    if (action === 'revise') {
      const result = reviseAcceptance(handle, {
        taskId,
        condition: reviseArgs!.condition,
        texts: reviseArgs!.texts,
        actor: defaultActor(options.actor),
        expectRevision: expectRevision!,
        ...(options.expectTitle === undefined ? {} : { expectTitle: options.expectTitle })
      });
      if (!result.ok) refuse(result, result.message);
      const emptyNote = emptyAcceptanceWarning(taskId, reviseArgs!.condition, result.criteria.length);
      if (emptyNote) console.error(emptyNote);
      print(result, options.json);
      return;
    }
    if (action === 'approve') {
      // T-129: one transaction, one revision check, one evidence set --
      // including the single-criterion case, so there is one code path and
      // not two that can drift. Evidence is forwarded ONLY when the caller
      // supplied pairs, keeping the store's null/omitted semantics.
      const result = approveAcceptanceCriteria(handle, {
        taskId,
        ...(options.indices ? { indices: options.indices } : {}),
        ...(options.criterionId ? { criterionIds: [options.criterionId] } : {}),
        ...(options.all ? { all: true } : {}),
        actor: defaultActor(options.actor),
        expectRevision: expectRevision!,
        ...(approveEvidence ? { evidence: approveEvidence } : {})
      });
      if (!result.ok) refuse(result, result.message);
      // Review F1: routing every approve through the batch path dropped
      // `criterionId`/`state` from the output of the pre-T-129 invocation
      // (`--index 0` / `--criterion-id <id>`). No consumer in this repo read
      // them, but it is a documented public command, and keeping them for a
      // single EXPLICIT selection makes the change purely additive instead of
      // breaking. Keyed on the selection, not the result, so `--all` on a
      // one-criterion task still returns only the batch shape -- `--all` is
      // new and never had the old one.
      const singleSelection = !options.all
        && ((options.indices?.length ?? 0) + (options.criterionId ? 1 : 0)) === 1;
      const compat = singleSelection && result.approved.length === 1
        ? { criterionId: result.approved[0], state: 'approved' as const }
        : {};
      print({ ...result, ...compat }, options.json);
      return;
    }
    if (action === 'unapprove') {
      const result = unapproveAcceptanceCriterion(handle, {
        taskId,
        criterionId: options.criterionId,
        index: options.indices?.[0],
        actor: defaultActor(options.actor),
        expectRevision: expectRevision!
      });
      if (!result.ok) refuse(result, result.message);
      print(result, options.json);
      return;
    }
    throw new Error(`Unknown acceptance action: ${action}`);
  } finally { handle.close(); }
}

export function taskFinishCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    const result = finishTask(handle, tasksRoot, { taskId, actor: defaultActor(options.actor), snapshot: options.snapshot });
    if (!result.ok) {
      // Review B11: A9's premise -- "the `Error:` sentence already carries the
      // reason and the message" -- held for move/update/acceptance/export but
      // not here: this message was only `Finish <stage> failed: <reason>`, so
      // in human mode (where the payload is no longer printed) the detail that
      // says WHICH criterion or WHICH stage blocked was lost. It is in the
      // sentence now, so `--json` is not required to diagnose a failed finish.
      const detail = result.stage === 'move'
        ? `${result.move.reason}${result.move.message ? ` -- ${result.move.message}` : ''}`
          // T-128: the same closing advice `task move --status done` gives, so
          // the two paths stay indistinguishable when the gate is what failed.
          + closingAdvice(taskId, result.move.reason)
        : `checkpoint-${result.checkpoint.stage}${result.checkpoint.error ? ` -- ${result.checkpoint.error}` : ''}`
          + ` (planning move ${result.move.performed ? `applied ${result.move.from} -> ${result.move.to}` : 'not applied'})`
          // Review F2: this advice used to be appended to EVERY checkpoint
          // failure, but the `precondition` stage fires precisely when the
          // planning state is NOT done any more -- somebody reopened or moved
          // the task inside the publication gap. Telling that operator the
          // task is "already closed" and to re-run with --no-snapshot would
          // re-close a task that was deliberately reopened.
          + (result.checkpoint.stage === 'precondition'
            ? ` The task is NOT closed: it changed under the publication lock, so nothing was published. Re-read it with \`mapctx task show\` before deciding -- do not re-run blindly.`
            : ` The planning state is already closed; re-run with --no-snapshot to finish without regenerating the mirrors, or \`mapctx export\` once the working tree is ready.`);
      refuse(result, `Finish ${result.stage} failed: ${detail}`);
    }
    warnForeignClaimRelease(result.move.releasedClaimId, defaultActor(options.actor), taskId);
    print(result, options.json);
  } finally { handle.close(); }
}

export function taskStartCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const status = options.status ?? 'claimed';
  if (status !== 'claimed' && status !== 'running') throw new Error(`task start status must be claimed or running, got: ${status}`);
  const holder = options.holder ? JSON.parse(options.holder) : undefined;
  const { handle } = openStoreOrFail(cwd);
  try {
    const result = startTask(handle, {
      taskId,
      actor: defaultActor(options.actor),
      holder,
      dispatchId: options.dispatchId,
      executorKind: options.executor,
      contextHash: options.contextHash,
      status,
      leaseDurationMs: leaseOverrideMs(options),
      coordination: resolveCoordination(cwd)
    });
    if (!result.ok) refuse(result, `Start refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}${activeClaimSuffix(result.activeClaim)}`);
    print({
      ...result,
      taskId,
      claimId: result.claim.claimId,
      leaseToken: result.claim.leaseToken,
      // T-142: the holder of a successful claim receives BOTH capabilities --
      // it already holds the stronger one. Flattened beside `leaseToken` so an
      // executing agent can hand `renewToken` to its orchestrator without
      // handing over release authority, which is the whole point of D2.
      renewToken: result.claim.renewToken,
      expiresAt: result.claim.expiresAt,
      dispatchId: result.dispatch.dispatchId,
      attempt: result.dispatch.attempt,
      status: result.dispatch.status,
      executorKind: result.dispatch.executorKind,
      next: `mapctx dispatch receipt ${result.dispatch.dispatchId} --receipt <path>`
    }, options.json);
  } finally { handle.close(); }
}

export function dispatchCreateCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const task = queryTask(handle.db, taskId);
    if (!task) throw new Error(`Cannot dispatch unknown task: ${taskId}`);

    let dispatchId: string;
    let attempt: number;
    if (options.dispatchId) {
      const history = listDispatchAttempts(handle.db, options.dispatchId);
      if (history.length === 0) throw new Error(`Unknown dispatch: ${options.dispatchId}`);
      if (history.some(item => item.taskId !== taskId)) throw new Error(`Dispatch belongs to another task. Use mapctx task start ${taskId} for a new dispatch.`);
      dispatchId = options.dispatchId;
      attempt = Math.max(...history.map(a => a.attempt)) + 1;
    } else {
      dispatchId = newDispatchId();
      attempt = 1;
    }

    // A fresh attempt must enter through "claimed": unclaimed -> running is
    // not a legal execution transition, and the receipt (or an explicit
    // transition) is what moves the attempt forward.
    const status = options.status ?? 'claimed';
    if (status !== 'claimed' && status !== 'running') {
      throw new Error(`dispatch create status must be claimed or running, got: ${status}`);
    }
    const contextHash = options.contextHash
      ?? crypto.createHash('sha256').update(JSON.stringify(task)).digest('hex');

    const result = recordDispatchAttempt(handle, {
      dispatch: {
        dispatchId,
        taskId,
        executorKind: options.executor ?? 'cli',
        attempt,
        contextHash,
        status
      }
    }, defaultActor(options.actor), true);
    if (!result.ok) refuse(result, `Dispatch refused: ${result.reason}`);
    print({
      ok: true,
      dispatchId,
      attempt,
      taskId,
      status,
      executorKind: options.executor ?? 'cli',
      next: `mapctx dispatch receipt ${dispatchId} --receipt <path>`
    }, options.json);
  } finally {
    handle.close();
  }
}

function reconcileCliCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    if (options.reconcileMode === 'discard') {
      reconcileDiscard(handle.db, cwd);
      print({ taskId, action: 'discard' }, options.json);
      return;
    }
    if (options.reconcileMode === 'accept') {
      const diff = reconcileAccept(handle, cwd, taskId, defaultActor(options.actor));
      print({ taskId, action: 'accept', diff }, options.json);
      return;
    }
    const diff = diffTaskForReconcile(handle.db, cwd, taskId);
    print({ taskId, action: 'diff', diff }, options.json);
  } finally {
    handle.close();
  }
}

async function syncStatusCommand(options: MapctxOptions): Promise<void> {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || !toml.config.github) {
    print({ status: 'no-github-binding' }, options.json);
    return;
  }
  const github = toml.config.github;
  if (github.verified) {
    print({ status: 'verified', owner: github.owner, repo: github.repo }, options.json);
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    print(
      { status: 'unverified GitHub binding', reason: 'no GITHUB_TOKEN configured to verify', owner: github.owner, repo: github.repo },
      options.json
    );
    return;
  }

  try {
    const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      print({ status: 'unverified GitHub binding', reason: `GitHub API returned ${response.status}`, owner: github.owner, repo: github.repo }, options.json);
      return;
    }
    const scopesHeader = response.headers.get('x-oauth-scopes') || '';
    const scopes = scopesHeader.split(',').map(s => s.trim()).filter(Boolean);
    if (!scopes.includes('read:project') && !scopes.includes('project')) {
      print(
        { status: 'unverified GitHub binding', reason: 'missing scope', missingScope: 'read:project', owner: github.owner, repo: github.repo },
        options.json
      );
      return;
    }
    print({ status: 'verified', owner: github.owner, repo: github.repo, scopes }, options.json);
  } catch (error) {
    print({ status: 'unverified GitHub binding', reason: (error as Error).message, owner: github.owner, repo: github.repo }, options.json);
  }
}

const WORKSPACE_UI_BOOTSTRAP_MARKER = 'MAPCTX_BOOTSTRAP';

/**
 * Launch policy for the workspace UI (shared by bare `mapctx` and
 * `mapctx workspace`): heal a stale registry active target first, then either
 * focus the already-running UI or start a fresh server and open the browser.
 */
async function launchWorkspaceUi(argv: string[]): Promise<void> {
  const wsOptions = parseWorkspaceServerArgs(argv);
  const open = wsOptions.open ?? true;
  healStaleActiveWorkspaceTarget(wsOptions);

  const port = wsOptions.port || Number(process.env.PORT || '4173');
  const host = wsOptions.host || '127.0.0.1';
  const url = `http://${host}:${port}/`;

  if (await isWorkspaceUiRunning(url)) {
    console.log(`MapCtx workspace already running: ${url}`);
    if (open) openWorkspaceUrl(url);
    return;
  }

  await startWorkspaceServer({ ...wsOptions, open });
}

/**
 * The global registry keeps one active target; when its TASKS.md disappears
 * (moved/deleted project, temp checkout), every workspace page request fails.
 * Repoint the active target at the first project whose TASKS.md still exists.
 */
function healStaleActiveWorkspaceTarget(options: { cwd?: string; registryPath?: string }): void {
  const registryOptions = options.registryPath
    ? { registryPath: path.resolve(options.cwd || process.cwd(), options.registryPath) }
    : {};
  const registry = readWorkspaceRegistry(registryOptions);
  if (activeWorkspaceTargetTasksFile(registry)) return;

  const fallback = registry.projects.find(project => fs.existsSync(resolveWorkspaceTargetTasksFile(project)));
  if (!fallback) return;

  writeWorkspaceRegistry({ ...registry, activeTargetId: targetId('project', fallback.id) }, registryOptions);
  console.log(`Active workspace target no longer has a TASKS.md; falling back to: ${fallback.name} (${fallback.path})`);
}

function activeWorkspaceTargetTasksFile(registry: WorkspaceRegistry): string | undefined {
  if (!registry.activeTargetId) return undefined;
  const [type, ...rest] = registry.activeTargetId.split(':');
  const id = rest.join(':');
  const target = type === 'organization'
    ? registry.organizations.find(organization => organization.id === id)
    : registry.projects.find(project => project.id === id);
  if (!target?.path) return undefined;
  const tasksFile = resolveWorkspaceTargetTasksFile(target);
  return fs.existsSync(tasksFile) ? tasksFile : undefined;
}

async function isWorkspaceUiRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes(WORKSPACE_UI_BOOTSTRAP_MARKER);
  } catch {
    return false;
  }
}

function openWorkspaceUrl(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  childProcess.spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function main(): Promise<void> {
  const { command, subcommand, options, positional, help } = parseArgs(process.argv.slice(2));

  if (!command) {
    await launchWorkspaceUi([]);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h' || help) {
    printHelp();
    return;
  }

  if (command === 'workspace') {
    await launchWorkspaceUi(process.argv.slice(3));
    return;
  }

  if (command === 'workspace:add') {
    const wsOptions = parseWorkspaceServerArgs(process.argv.slice(3));
    const projectPath = wsOptions.addProjectPath || wsOptions.projectPath;
    if (!projectPath) throw new Error('workspace:add requires <path>');
    const result = ensureWorkspaceRegistry({
      cwd: wsOptions.cwd,
      addProjectPath: projectPath,
      organizationId: wsOptions.organizationId,
      organizationName: wsOptions.organizationName,
      organizationPath: wsOptions.organizationPath,
      registryPath: wsOptions.registryPath
    });
    console.log(`Registered project in ${result.registryPath}`);
    if (result.addedProject) {
      console.log(`${result.addedProject.name}: ${result.addedProject.path}`);
    }
    return;
  }

  if (command === 'store') {
    if (subcommand === 'init') { storeInitCommand(options); return; }
    if (subcommand === 'repair') { storeRepairCommand(options); return; }
    if (subcommand === 'attest-orphan') { storeAttestOrphanCommand(positional[1], options); return; }
    throw new Error('Usage: mapctx store <init|repair|attest-orphan> [--json]');
  }

  if (command === 'redact') {
    if (subcommand === 'list') { redactListCommand(options); return; }
    redactCommand(options);
    return;
  }

  if (command === 'import') {
    if (options.commit) { importCommitCliCommand(options); return; }
    importDryRunCliCommand(options);
    return;
  }

  if (command === 'export') {
    exportCliCommand(options);
    return;
  }

  if (command === 'validate') {
    mapctxValidateCliCommand(options);
    return;
  }

  if (command === 'acceptance' && subcommand === 'import') {
    // T-129 criterion 3: `--task` narrows the scope. Parsed before the store
    // opens; an unknown id makes the store throw rather than import a smaller
    // set in silence.
    const taskIds = options.taskFilter ? parseListInput('--task', options.taskFilter) : undefined;
    if (taskIds && taskIds.length === 0) throw new Error('--task needs at least one task id.');
    const scope = taskIds ? { taskIds } : {};
    const { handle } = openStoreOrFail(process.cwd(), { mode: options.commit ? 'write' : 'read' });
    try {
      if (!options.commit) {
        print({ mode: 'dry-run', ...planAcceptanceImport(handle.db, resolveMapctxToml(process.cwd())?.dir ?? process.cwd(), scope) }, options.json);
      } else {
        const result = commitAcceptanceImport(handle, resolveMapctxToml(process.cwd())?.dir ?? process.cwd(), { actor: defaultActor(options.actor), ...scope });
        if (!result.ok) refuse(result, result.message);
        print(result, options.json);
      }
    } finally { handle.close(); }
    return;
  }

  if (command === 'plan') {
    mapctxPlanCommand(options);
    return;
  }

  if (command === 'gantt') {
    mapctxGanttCommand(options);
    return;
  }

  if (command === 'board') {
    mapctxBoardCommand(options);
    return;
  }

  if (command === 'push') {
    pushStoreCommand(options);
    return;
  }

  if (command === 'task') {
    if (subcommand === 'create') { taskCreateCommand(options); return; }
    if (subcommand === 'search') { taskSearchCommand(options); return; }
    if (subcommand === 'acceptance') { taskAcceptanceCommand(positional[1], positional[2], options); return; }
    const taskId = positional[1];
    if (!taskId) throw new Error('Usage: mapctx task <create|search|show|context|claim|renew|release|move|reopen|update> [...]');
    if (subcommand === 'show') { taskShowCommand(taskId, options); return; }
    if (subcommand === 'context') { taskContextCommand(taskId, options); return; }
    if (subcommand === 'claim') { taskClaimCommand(taskId, options); return; }
    if (subcommand === 'start') { taskStartCommand(taskId, options); return; }
    if (subcommand === 'finish') { taskFinishCommand(taskId, options); return; }
    if (subcommand === 'renew') { taskRenewCommand(taskId, options); return; }
    if (subcommand === 'release') { taskReleaseCommand(taskId, options); return; }
    if (subcommand === 'move') { taskMoveCommand(taskId, options); return; }
    if (subcommand === 'reopen') { taskReopenCommand(taskId, options); return; }
    if (subcommand === 'update') { taskUpdateCommand(taskId, options); return; }
    throw new Error('Usage: mapctx task <create|search|show|context|claim|renew|release|move|reopen|update> <task-id> [...]');
  }

  if (command === 'dispatch') {
    if (subcommand === 'create' && positional[1]) { dispatchCreateCommand(positional[1], options); return; }
    const dispatchId = positional[1];
    if (subcommand === 'receipt' && dispatchId) { dispatchReceiptCommand(dispatchId, options); return; }
    throw new Error('Usage: mapctx dispatch create <task-id> [...] | mapctx dispatch receipt <dispatch-id> [...]');
  }

  if (command === 'run') {
    const dispatchId = positional[1];
    if (subcommand === 'event' && dispatchId) { runEventCommand(dispatchId, options); return; }
    throw new Error(`Usage: mapctx run event <dispatch-id> --type ${LIVENESS_RUN_EVENT_TYPES.join('|')} [--attempt n] [--sequence n] [--payload json] [--actor name] [--json]`);
  }

  if (command === 'reconcile') {
    const taskId = positional[0];
    if (!taskId) throw new Error('Usage: mapctx reconcile <task-id> [--accept | --discard] [--json]');
    reconcileCliCommand(taskId, options);
    return;
  }

  if (command === 'history') {
    if (subcommand === 'scan') {
      // --dry-run is the default and observes through a read-only handle: the
      // report path cannot write. --commit takes the single-writer path and
      // records ONLY the links an approval file names (T-116): evidence rows
      // journaled without any claim/dispatch/receipt or lifecycle mutation.
      const { handle, storeDir } = openStoreOrFail(process.cwd(), { mode: options.commit ? 'write' : 'read' });
      try {
        const toml = resolveMapctxToml(process.cwd());
        historyScanCommand(handle, toml?.dir ?? process.cwd(), {
          json: options.json,
          commit: options.commit,
          approvePath: options.approvePath,
          emitApprovalPath: options.emitApprovalPath,
          includeInferred: options.includeInferred,
          dateCachePath: path.join(storeDir, 'history-dates.json'),
          actor: options.actor,
          codexSessions: options.codexSessions,
          opencodeDb: options.opencodeDb,
          claudeDir: options.claudeDir,
          repo: options.repo,
          taskFilter: options.taskFilter
        });
      } finally {
        handle.close();
      }
      return;
    }
    if (subcommand === 'correct') {
      const taskId = positional[1];
      if (!taskId) throw new Error('Usage: mapctx history correct <task-id> --target receipt:<dispatchId>/<attempt>|evidence:<id> --because "<reason>" [--json]');
      const { handle, storeDir } = openStoreOrFail(process.cwd(), { mode: 'write' });
      try {
        historyCorrectCommand(handle, taskId, {
          json: options.json,
          target: options.target,
          reason: options.correctionReason,
          actor: options.actor,
          dateCachePath: path.join(storeDir, 'history-dates.json')
        });
      } finally {
        handle.close();
      }
      return;
    }
    if (subcommand === 'reconstruct') {
      const { handle } = openStoreOrFail(process.cwd(), { mode: 'read' });
      try {
        historyReconstructCommand(handle, { json: options.json, taskFilter: options.taskFilter });
      } finally {
        handle.close();
      }
      return;
    }
    throw new Error('Usage: mapctx history scan [--dry-run | --commit --approve <file>] [--json] | history correct <task-id> --target ... --because "..." | history reconstruct [--json]');
  }

  if (command === 'sync' && subcommand === 'status') {
    await syncStatusCommand(options);
    return;
  }

  if (command === 'account') {
    if (subcommand === 'add') { accountAddCommand(positional[1], options); return; }
    if (subcommand === 'list') { accountListCommand(options); return; }
    if (subcommand === 'bind') { accountBindCommand(positional[1], options); return; }
    throw new Error('Usage: mapctx account <add|list|bind> [...]');
  }

  if (command === 'plan-period') {
    if (subcommand === 'record') { planPeriodRecordCommand(options); return; }
    throw new Error('Usage: mapctx plan-period record --account <id-or-name> --amount <decimal> --start <date|datetime> --end <date|datetime>');
  }

  if (command === 'budget') {
    if (subcommand === 'set') { budgetSetCommand(positional[1], options); return; }
    if (subcommand === 'status') { budgetStatusCommand(positional[1], options); return; }
    if (subcommand === 'history') { budgetHistoryCommand(positional[1], options); return; }
    throw new Error('Usage: mapctx budget <set|status|history> <epic-id> [...]');
  }

  printHelp();
}

if (require.main === module) {
  main().catch(error => {
    // T-127: stdout carries results only. Errors -- including the structured
    // refusal payload a CliRefusal carries -- leave on stderr, once, as JSON
    // when the caller asked for --json.
    writeCliError(error, process.argv.includes('--json'));
    process.exit(1);
  });
}
