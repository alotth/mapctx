import * as fs from 'fs';
import * as path from 'path';
import {
  buildExport,
  checkDrift,
  isStoreMaterialized,
  listDependencies,
  listTasks,
  resolveMapctxToml,
  resolveProjectStoreDir,
  StoreHandle,
  updateTask,
  type GithubBinding,
  type TaskRecord
} from '@mapctx/store';
import { parseTaskDetailFile } from '@mapctx/core';
import {
  addIssueToProject,
  clearProjectItemFieldValue,
  createIssue,
  getIssues,
  getProjectDates,
  getProjectStatuses,
  getStatusOptionIds,
  setProjectItemDate,
  setProjectItemStatus,
  updateIssue
} from './github';
import type { GitHubIssue, SyncConfig } from './types';
import { parseExternalIssueNumber, todayISO, unique } from './utils';

/**
 * Store-backed GitHub push (E-013/T-076): GitHub is a projection of the store
 * (ADR 0003), never a source. The command reads task projections from SQLite
 * (never TASKS.md), is fail-closed on board drift, and carries no state back
 * from GitHub into the store -- the only store write is the externalId of
 * issues this push itself created.
 */

const BOARD_STATUS_FOR_PLANNING: Record<string, string> = {
  ready: 'ready-for-do',
  'in-progress': 'doing'
};

export function planningStateToBoardStatus(planningState: string): string {
  return BOARD_STATUS_FOR_PLANNING[planningState] ?? planningState;
}

export type RemoteIssueSnapshot = {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labelNames: string[];
};

export function remoteIssueSnapshot(issue: GitHubIssue): RemoteIssueSnapshot {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labelNames: unique((issue.labels ?? []).map(label => label.name))
  };
}

export function labelsFromTaskRecord(task: TaskRecord): string[] {
  const labels: string[] = [];
  if (task.type) labels.push(`type:${task.type}`);
  if (task.priority) labels.push(`priority:${task.priority}`);
  if (task.workload) labels.push(`workload:${task.workload.toLowerCase()}`);
  for (const tag of task.tags || []) labels.push(`tag:${tag}`);
  return unique(labels);
}

export function buildStoreIssueBody(
  task: TaskRecord,
  deps: string[],
  detailDescription: string | null,
  today: string
): string {
  const lines: string[] = [];
  lines.push(`Synced from store projection (mapctx) on ${today}.`);
  lines.push('');
  lines.push('## Task Metadata');
  lines.push(`- id: ${task.taskId}`);
  lines.push(`- status: ${task.planningState}`);
  if (task.type) lines.push(`- type: ${task.type}`);
  if (task.parentTaskId) lines.push(`- parent: ${task.parentTaskId}`);
  if (task.priority) lines.push(`- priority: ${task.priority}`);
  if (task.workload) lines.push(`- workload: ${task.workload}`);
  lines.push(`- dependsOn: [${deps.join(', ')}]`);
  if (task.startDate) lines.push(`- start: ${task.startDate}`);
  if (task.dueDate) lines.push(`- due: ${task.dueDate}`);
  lines.push(`- completed: ${task.completedOn ?? 'null'}`);
  if (task.detailPath) lines.push(`- detail: ${task.detailPath}`);

  if (detailDescription !== null) {
    lines.push('');
    lines.push('## Detail');
    lines.push('');
    lines.push(detailDescription.trim() || '(empty description)');
  }
  return `${lines.join('\n')}\n`;
}

export type TaskPlan =
  | { action: 'create'; taskId: string; title: string; labels: string[]; body: string }
  | {
      action: 'update';
      taskId: string;
      issueNumber: number;
      title?: string;
      body?: string;
      issueState?: 'open' | 'closed';
      labels?: string[];
      fields: string[];
    }
  | { action: 'skip'; taskId: string; issueNumber: number };

export type TaskConflict = { taskId: string; reason: string };

/**
 * Pure reconciliation decision for one task against its current remote issue.
 * No I/O, no mutation: the caller fetches remote state and applies actions.
 */
export function planForTask(args: {
  task: TaskRecord;
  deps: string[];
  detailDescription: string | null;
  remote: RemoteIssueSnapshot | null;
  statusMap: Record<string, string>;
  today: string;
}): TaskPlan | TaskConflict {
  const { task, deps, detailDescription, remote, statusMap, today } = args;
  const boardStatus = planningStateToBoardStatus(task.planningState);
  if (statusMap[boardStatus] === undefined) {
    return { taskId: task.taskId, reason: `statusMap has no entry for board status '${boardStatus}' (planning state '${task.planningState}')` };
  }
  const expectedState: 'open' | 'closed' = task.planningState === 'done' ? 'closed' : 'open';
  const expectedLabels = labelsFromTaskRecord(task);
  const expectedBody = buildStoreIssueBody(task, deps, detailDescription, today);

  if (!task.externalId) {
    return { action: 'create', taskId: task.taskId, title: task.title, labels: expectedLabels, body: expectedBody };
  }

  const issueNumber = parseExternalIssueNumber(task.externalId);
  if (issueNumber === null) {
    return { taskId: task.taskId, reason: `unparsable externalId: ${task.externalId}` };
  }
  if (!remote) {
    return { taskId: task.taskId, reason: `issue #${issueNumber} (${task.externalId}) not found in the repository; the issue was deleted or the externalId is stale` };
  }

  const fields: string[] = [];
  const update: Extract<TaskPlan, { action: 'update' }> = {
    action: 'update',
    taskId: task.taskId,
    issueNumber,
    fields
  };
  if (remote.title !== task.title) {
    update.title = task.title;
    fields.push('title');
  }
  if ((remote.body ?? '') !== expectedBody) {
    update.body = expectedBody;
    fields.push('body');
  }
  if (remote.state !== expectedState) {
    update.issueState = expectedState;
    fields.push('state');
  }
  if (JSON.stringify(unique(remote.labelNames)) !== JSON.stringify(expectedLabels)) {
    update.labels = expectedLabels;
    fields.push('labels');
  }
  if (fields.length === 0) {
    return { action: 'skip', taskId: task.taskId, issueNumber };
  }
  return update;
}

export function desiredProjectFields(task: TaskRecord, today: string): {
  boardStatus: string;
  start: string | null;
  due: string | null;
  completed: string | null;
} {
  return {
    boardStatus: planningStateToBoardStatus(task.planningState),
    start: task.startDate ?? null,
    due: task.dueDate ?? null,
    completed: task.planningState === 'done' ? (task.completedOn ?? today) : null
  };
}

export type PushPlanReport = {
  created: Array<{ taskId: string; title: string }>;
  updated: Array<{ taskId: string; issueNumber: number; fields: string[] }>;
  skipped: number;
  conflicts: TaskConflict[];
};

export type PushOptions = {
  dryRun?: boolean;
  json?: boolean;
  actor?: string;
};

function normalizeStatusMap(map: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    const k = key.trim().toLowerCase();
    if (k) out[k] = value;
  }
  return out;
}

export function pushStoreCommand(options: PushOptions = {}): PushPlanReport {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml) throw new Error('No mapctx.toml found; store-backed push requires a mapctx.toml project.');
  if (toml.config.plansAuthority !== 'store') {
    throw new Error(`store-backed push requires plansAuthority=store (found "${toml.config.plansAuthority}"). Use legacy mapcs push for Markdown boards.`);
  }
  const binding = toml.config.github;
  if (!binding) {
    throw new Error(`No [github] binding in ${toml.path}. Add [github] owner/repo (and statusMap for Projects) to enable store-backed push.`);
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  if (!isStoreMaterialized(storeDir)) {
    throw new Error(`Store not materialized at ${storeDir}. Run \`mapctx store init\`.`);
  }

  // R14 read-only open: push reads projections; pending maintenance is a named
  // failure, never healed by a push.
  const handle = StoreHandle.openReadOnly(storeDir);
  try {
    const maintenance = handle.maintenanceNeeded();
    if (maintenance) {
      throw new Error(`Store maintenance needed, refusing to push stale state: ${maintenance}`);
    }

    // Fail-closed drift gate (ADR 0003): drift means the on-disk board
    // disagrees with the store. Publishing projections while the repo holds a
    // stale snapshot is a silent fork; resolve drift first.
    const drift = checkDrift(handle.db, toml.dir);
    if (drift.hasDrift) {
      throw new Error(
        `Refusing to push: board drift detected (${drift.issues.length} issue(s)). Regenerate the board first (run \`mapctx validate\`).\n` +
        drift.issues.slice(0, 10).map(issue => `- [${issue.taskId}] ${issue.reason} (${issue.file})`).join('\n')
      );
    }

    const tasks = listTasks(handle.db);
    const statusMap = normalizeStatusMap(binding.statusMap);

    const today = todayISO();
    const depsByTask = new Map<string, string[]>();
    for (const edge of listDependencies(handle.db)) {
      const list = depsByTask.get(edge.fromTaskId) ?? [];
      list.push(edge.toTaskId);
      depsByTask.set(edge.fromTaskId, list);
    }
    const descriptionByTask = new Map<string, string | null>();
    for (const task of tasks) {
      let description: string | null = null;
      if (task.detailPath) {
        const detailPath = path.resolve(toml.dir, task.detailPath);
        if (fs.existsSync(detailPath)) {
          // Post-drift-check this file matches the store export; the
          // description prose is the git-authored section (never stored).
          description = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8')).description;
        }
      }
      descriptionByTask.set(task.taskId, description);
    }

    const syncConfig: SyncConfig = {
      owner: binding.owner,
      repo: binding.repo,
      projectId: binding.projectId,
      statusFieldId: binding.statusFieldId,
      startDateFieldId: binding.startDateFieldId,
      dueDateFieldId: binding.dueDateFieldId,
      completedDateFieldId: binding.completedDateFieldId,
      statusMap,
      tasksFile: 'TASKS.md'
    };

    const remoteIssues = getIssues(syncConfig);
    const rawIssueByNumber = new Map<number, GitHubIssue>(remoteIssues.map(issue => [issue.number, issue]));
    const remoteByNumber = new Map<number, RemoteIssueSnapshot>(remoteIssues.map(issue => [issue.number, remoteIssueSnapshot(issue)]));

    const conflicts: TaskConflict[] = [];
    const plans: Array<{ task: TaskRecord; plan: TaskPlan }> = [];
    for (const task of tasks) {
      const issueNumber = task.externalId ? parseExternalIssueNumber(task.externalId) : null;
      const remote = issueNumber === null ? null : remoteByNumber.get(issueNumber) ?? null;
      const plan = planForTask({
        task,
        deps: depsByTask.get(task.taskId) ?? [],
        detailDescription: descriptionByTask.get(task.taskId) ?? null,
        remote,
        statusMap,
        today
      });
      if ('reason' in plan) conflicts.push(plan);
      else plans.push({ task, plan });
    }

    const report: PushPlanReport = {
      created: [],
      updated: [],
      skipped: plans.filter(entry => entry.plan.action === 'skip').length,
      conflicts
    };

    if (options.dryRun) {
      // The report reflects the PLAN (not the application): created/updated
      // arrays are populated from the planned actions so --json consumers see
      // what a real push would do.
      for (const { plan } of plans) {
        if (plan.action === 'create') report.created.push({ taskId: plan.taskId, title: plan.title });
        else if (plan.action === 'update') report.updated.push({ taskId: plan.taskId, issueNumber: plan.issueNumber, fields: plan.fields });
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ dryRun: true, ...report }, null, 2)}\n`);
      } else {
        const counts = (action: TaskPlan['action']) => plans.filter(entry => entry.plan.action === action).length;
        console.log(`[dry-run] store push plan: create=${counts('create')}, update=${counts('update')}, skip=${counts('skip')}, conflicts=${conflicts.length}`);
        for (const { plan } of plans) {
          if (plan.action === 'create') console.log(`[dry-run] create issue for ${plan.taskId}`);
          else if (plan.action === 'update') console.log(`[dry-run] update issue #${plan.issueNumber} for ${plan.taskId} (${plan.fields.join(', ')})`);
        }
      }
      return report;
    }

    if (conflicts.length > 0) {
      throw new Error(
        `Refusing to push: ${conflicts.length} task(s) have conflicts:\n` +
        conflicts.map(conflict => `- ${conflict.taskId}: ${conflict.reason}`).join('\n')
      );
    }

    const projectEnabled = Boolean(binding.projectId);
    const projectStatusEnabled = projectEnabled && Boolean(binding.statusFieldId);

    applyPlans({ syncConfig, binding, statusMap, plans, today, rawIssueByNumber, report, tasksRoot: toml.dir, storeDir, actor: options.actor ?? 'mapctx-push' });
    return report;
  } finally {
    handle.close();
  }
}

type ApplyPlansArgs = {
  syncConfig: SyncConfig;
  binding: GithubBinding;
  statusMap: Record<string, string>;
  plans: Array<{ task: TaskRecord; plan: TaskPlan }>;
  today: string;
  rawIssueByNumber: Map<number, GitHubIssue>;
  report: PushPlanReport;
  tasksRoot: string;
  storeDir: string;
  actor: string;
};

function applyPlans(args: ApplyPlansArgs): void {
  const { syncConfig, binding, statusMap, plans, today, rawIssueByNumber, report, tasksRoot, storeDir, actor } = args;
  const projectEnabled = Boolean(binding.projectId);
  const projectStatusEnabled = projectEnabled && Boolean(binding.statusFieldId);
  const optionIds = projectStatusEnabled ? getStatusOptionIds(syncConfig) : {};

  const projectStatuses = projectStatusEnabled ? getProjectStatuses(syncConfig) : [];
  const projectDates = projectEnabled ? getProjectDates(syncConfig) : [];
  const itemIdByIssue = new Map<number, string>(projectStatuses.map(entry => [entry.issueNumber, entry.itemId]));
  const statusNameByIssue = new Map<number, string>(projectStatuses.map(entry => [entry.issueNumber, entry.statusName]));
  const datesByIssue = new Map<number, { start?: string; due?: string; completed?: string }>(projectDates.map(entry => [entry.issueNumber, entry]));

  let writeHandle: StoreHandle | null = null;
  const createdNumberByTask = new Map<string, number>();
  try {
    // Phase 1: issues.
    for (const { task, plan } of plans) {
      if (plan.action === 'create') {
        const createdIssue = createIssue(syncConfig, { title: plan.title, body: plan.body, labels: plan.labels });
        report.created.push({ taskId: task.taskId, title: plan.title });
        createdNumberByTask.set(task.taskId, createdIssue.number);
        if (!writeHandle) {
          writeHandle = StoreHandle.open(storeDir);
        }
        const writeResult = updateTask(writeHandle, {
          taskId: task.taskId,
          patch: { externalId: `github:issue:${createdIssue.number}` },
          actor
        });
        if (!writeResult.ok) {
          throw new Error(`issue created but externalId writeback failed for ${task.taskId}: ${(writeResult as { reason?: string }).reason ?? 'unknown'}`);
        }
        if (projectEnabled && !itemIdByIssue.has(createdIssue.number)) {
          itemIdByIssue.set(createdIssue.number, addIssueToProject(syncConfig, createdIssue.node_id));
        }
      } else if (plan.action === 'update') {
        updateIssue(syncConfig, plan.issueNumber, {
          title: plan.title,
          body: plan.body,
          state: plan.issueState,
          labels: plan.labels
        });
        report.updated.push({ taskId: task.taskId, issueNumber: plan.issueNumber, fields: plan.fields });
      }
    }

    // Phase 2: project fields, for every task that has (or now has) an issue.
    if (projectEnabled) {
      for (const { task, plan } of plans) {
        const issueNumber = plan.action === 'create'
          ? createdNumberByTask.get(plan.taskId)
          : plan.action === 'update'
            ? plan.issueNumber
            : plan.issueNumber;
        if (issueNumber === undefined) continue;
        const rawIssue = rawIssueByNumber.get(issueNumber);
        let itemId = itemIdByIssue.get(issueNumber);
        if (!itemId) {
          if (!rawIssue) continue;
          itemId = addIssueToProject(syncConfig, rawIssue.node_id);
          itemIdByIssue.set(issueNumber, itemId);
        }
        const desired = desiredProjectFields(task, today);
        const remoteStatusName = statusMap[desired.boardStatus];
        if (projectStatusEnabled && optionIds[remoteStatusName] && statusNameByIssue.get(issueNumber) !== remoteStatusName) {
          setProjectItemStatus(syncConfig, itemId, optionIds[remoteStatusName]);
          statusNameByIssue.set(issueNumber, remoteStatusName);
        }
        const current = datesByIssue.get(issueNumber) ?? {};
        if (binding.startDateFieldId) {
          if (desired.start && current.start !== desired.start) {
            setProjectItemDate(syncConfig, itemId, binding.startDateFieldId, desired.start);
          } else if (!desired.start && current.start) {
            clearProjectItemFieldValue(syncConfig, itemId, binding.startDateFieldId);
          }
        }
        if (binding.dueDateFieldId) {
          if (desired.due && current.due !== desired.due) {
            setProjectItemDate(syncConfig, itemId, binding.dueDateFieldId, desired.due);
          } else if (!desired.due && current.due) {
            clearProjectItemFieldValue(syncConfig, itemId, binding.dueDateFieldId);
          }
        }
        if (binding.completedDateFieldId) {
          if (desired.completed && current.completed !== desired.completed) {
            setProjectItemDate(syncConfig, itemId, binding.completedDateFieldId, desired.completed);
          } else if (!desired.completed && current.completed) {
            clearProjectItemFieldValue(syncConfig, itemId, binding.completedDateFieldId);
          }
        }
        datesByIssue.set(issueNumber, { ...current, start: desired.start ?? undefined, due: desired.due ?? undefined, completed: desired.completed ?? undefined });
      }
    }
  } finally {
    if (writeHandle) {
      const exported = buildExport(writeHandle.db, { tasksRoot });
      fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, 'utf8');
      for (const file of exported.taskDetailFiles) fs.writeFileSync(file.path, file.content, 'utf8');
      writeHandle.close();
    }
  }
}
