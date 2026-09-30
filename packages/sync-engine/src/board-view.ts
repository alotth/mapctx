// Shared board-view mapping for the kanban dataset (T-094). Both the
// `mapctx board --json` CLI command and the workspace server's buildModel
// consume these pure functions so the JSON the UI renders is identical in
// store-authority and pre-cutover repos. Thread data is deliberately absent:
// the server enriches tasks with readTaskThread() after this mapping.
import { STATUS_TO_PLANNING } from '@mapctx/protocol';
import type { TaskRecord } from '@mapctx/store';
import type { Task } from './types';

export type WorkspaceModel = 'legacy-sections' | 'v2-status' | 'mixed' | 'unknown' | 'store';

export type WorkspaceThreadRunView = {
  runId: string;
  runtime?: string;
  agentProfile?: string;
  model?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  costUsd?: number;
  result?: string;
  tokenUsage?: {
    input?: number;
    output?: number;
    total?: number;
  };
};

export type WorkspaceTaskView = {
  id: string;
  title: string;
  status: string;
  type?: string;
  parent?: string;
  subIssueProgress?: string;
  milestone?: string;
  startDate?: string;
  dueDate?: string;
  completed?: string;
  updated?: string;
  priority?: string;
  workload?: string;
  tags?: string[];
  assignees?: string[];
  detailPath?: string;
  dependsOn?: string[];
  thread: {
    exists: boolean;
    summaryMarkdown?: string;
    threadMarkdown?: string;
    summaryPreview?: string;
    status?: string;
    lastRuntime?: string;
    lastAgentProfile?: string;
    lastModel?: string;
    lastRunId?: string;
    latestRunStatus?: string;
    latestRunResult?: string;
    latestRunStartedAt?: string;
    latestRunEndedAt?: string;
    runCount: number;
    costUsd?: number;
    runs: WorkspaceThreadRunView[];
  };
};

/** Board-view task before the server adds thread enrichment. */
export type WorkspaceTaskSummary = Omit<WorkspaceTaskView, 'thread'>;

const PLANNING_TO_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_TO_PLANNING).map(([status, planningState]) => [planningState, status])
);

/**
 * Lenient counterpart of export.ts's planningStateToStatus: the checkpoint
 * must be lossless and throws on unmapped states, while the board view just
 * renders an unknown planning state as its own column.
 */
export function planningStateToBoardStatus(planningState: string): string {
  return PLANNING_TO_STATUS[planningState] ?? planningState;
}

export function detectWorkspaceModel(markdownText: string): WorkspaceModel {
  const hasSingleTasksSection = /^##\s+Tasks\s*$/im.test(markdownText);
  const hasStatusProperty = /^\s{2}-\s+status:\s*[^\s].*$/im.test(markdownText);
  const hasLegacySections = /^##\s+(Backlog|Doing|Review|Done|Paused)\s*$/im.test(markdownText);

  if (hasSingleTasksSection && hasStatusProperty && hasLegacySections) {return 'mixed';}
  if (hasSingleTasksSection && hasStatusProperty) {return 'v2-status';}
  if (hasLegacySections) {return 'legacy-sections';}
  return 'unknown';
}

export function toWorkspaceTaskView(task: Task): WorkspaceTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    parent: task.parent,
    subIssueProgress: task.subIssueProgress,
    milestone: task.milestone,
    startDate: task.start,
    dueDate: task.due,
    completed: task.completed || undefined,
    updated: task.updated,
    priority: task.priority,
    workload: task.workload,
    tags: task.tags,
    assignees: task.assignees,
    detailPath: task.detail,
    dependsOn: task.dependsOn
  };
}

/**
 * Mirrors export.ts's renderTaskBlock field mapping so the board view and the
 * regenerated TASKS.md checkpoint can never disagree about store content.
 */
export function toWorkspaceTaskViewFromStoreRecord(
  task: TaskRecord,
  dependsOn: string[],
  subIssueProgress: string | null
): WorkspaceTaskSummary {
  return {
    id: task.taskId,
    title: task.title,
    status: planningStateToBoardStatus(task.planningState),
    type: task.type ?? undefined,
    parent: task.parentTaskId ?? undefined,
    subIssueProgress: subIssueProgress ?? undefined,
    milestone: task.milestone ?? undefined,
    startDate: task.startDate ?? undefined,
    dueDate: task.dueDate ?? undefined,
    completed: task.completedOn ?? undefined,
    updated: task.updatedOn ?? undefined,
    priority: task.priority ?? undefined,
    workload: task.workload ?? undefined,
    tags: task.tags,
    assignees: task.assignees,
    detailPath: task.detailPath ?? undefined,
    dependsOn
  };
}

/** Same derivation as export.ts's deriveSubIssueProgress (children done/total). */
export function deriveSubIssueProgress(taskId: string, tasks: TaskRecord[]): string | null {
  const children = tasks.filter(t => t.parentTaskId === taskId);
  if (children.length === 0) {return null;}
  const done = children.filter(t => t.planningState === 'done').length;
  return `${done}/${children.length}`;
}
