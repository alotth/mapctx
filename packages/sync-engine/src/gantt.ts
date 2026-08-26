import {
  buildEstimateSnapshot,
  durationCoverageFromAssumptions,
  durationMeasuresFromReceipt,
  isPriorFallbackEstimate,
  type DurationCoverage
} from '@mapctx/forecast';
import { planExecution, type PlannerTask } from '@mapctx/planner';
import {
  STATUS_TO_PLANNING,
  type ClaimViolation,
  type DependencyEdge,
  type EstimateSnapshot,
  type RunReceipt
} from '@mapctx/protocol';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One task as seen by the Gantt dataset builder. Deliberately narrower than the
 * store's TaskRecord or the markdown Task -- both cutover states get mapped down
 * to this before assembly, so buildGanttDataset never has to know which one it's
 * looking at.
 */
export type GanttTaskInput = {
  id: string;
  title: string;
  status: string;
  type?: string | null;
  parentId?: string | null;
  start?: string | null;
  due?: string | null;
  dependsOn?: readonly string[];
  domains?: readonly string[];
  /** Latest immutable estimate, when one has already been recorded by the store. */
  estimateSnapshot?: EstimateSnapshot | null;
  /** All receipts recorded for this task, in whatever order the store returns. Empty pre-cutover. */
  receipts: readonly RunReceipt[];
};

export type GanttForecast = {
  estimateId: string;
  method: string;
  confidence: string;
  estimatorVersion: string;
  durationP50Ms: number;
  durationP90Ms: number;
  durationCoverage: DurationCoverage;
  isPriorFallback: boolean;
};

export type GanttActual = {
  startedAt: string;
  endedAt: string;
  outcome: string;
  durationMs: number;
  changedFiles: string[];
  /** null when there is no forecast to compare against (containers/terminal tasks never get one). */
  exceedsP90: boolean | null;
  actualVsP50Ratio: number | null;
  actualVsP90Ratio: number | null;
  actualVsPlannedRatio: number | null;
};

export type GanttPlanned = {
  start: string | null;
  due: string | null;
  durationMs: number | null;
  coverage: 'full' | 'partial';
};

export type GanttCalendarWindow = {
  id: string;
  title: string;
  kind: 'epic' | 'root-task';
  start: string;
  due: string;
  durationMs: number;
  coverage: 'full' | 'partial';
  sourceTaskIds: string[];
};

export type GanttBlockedReason = {
  kind: 'workflow-gate' | 'dependency' | 'cycle' | 'status';
  message: string;
  dependencyId?: string;
  gateName?: string;
  gateStatus?: string;
};

export type GanttCollision = {
  withTaskId: string;
  domains: string[];
  paths: string[];
};

export type GanttTaskEntry = {
  id: string;
  title: string;
  status: string;
  type: string | null;
  parentId: string | null;
  wave: number | null;
  planned: GanttPlanned | null;
  blockedReasons: GanttBlockedReason[];
  collisions: GanttCollision[];
  /** null for containers (epics/parents) and terminal (done/cancelled) tasks -- neither is a dispatch unit. */
  forecast: GanttForecast | null;
  /** null unless at least one receipt exists for this task (never true pre-cutover). */
  actual: GanttActual | null;
};

export type GanttDataset = {
  generatedAt: string;
  mode: 'pre-cutover' | 'store';
  /**
   * True when every forecast in this dataset fell back to the conservative prior
   * (no historical samples anywhere). The view should say this once, at the
   * dataset level, rather than repeat an identical per-row badge on every task --
   * see T-055 Decisions Taken.
   */
  allForecastsArePriorFallback: boolean;
  tasks: GanttTaskEntry[];
  calendarWindows: GanttCalendarWindow[];
  waves: Array<{ wave: number; taskIds: string[] }>;
  waveByTaskId: Record<string, number>;
  blockedReasons: Array<{
    taskId: string;
    kind: 'workflow-gate' | 'dependency' | 'cycle' | 'status';
    message: string;
    dependencyId?: string;
    gateName?: string;
    gateStatus?: string;
  }>;
  serializedPairs: Array<{ taskAId: string; taskBId: string; domains: string[]; paths: string[] }>;
  claimViolations: Array<{ id: string; waveId: string; kind: string; taskAId: string; taskBId: string; path: string; detectedAt: string }>;
  policy: {
    scheduling: string;
    claimsAreAdvisory: boolean;
    correctnessBackstop: string;
    guarantee: string;
    explanation: string;
  };
};

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

function normalizedTaskStatus(status: string): string {
  return STATUS_TO_PLANNING[status] ?? (status === 'in_progress' ? 'in-progress' : status);
}

/** Mirrors the container detection duplicated in mapctx-cli.test.ts: an epic, or anything with children. */
function detectContainerIds(tasks: readonly GanttTaskInput[]): Set<string> {
  const parentIds = new Set(tasks.filter(task => task.parentId).map(task => task.parentId as string));
  return new Set(tasks.filter(task => task.type === 'epic' || parentIds.has(task.id)).map(task => task.id));
}

function latestReceipt(receipts: readonly RunReceipt[]): RunReceipt | undefined {
  const sorted = [...receipts].sort((a, b) => {
    const ended = Date.parse(a.endedAt) - Date.parse(b.endedAt);
    if (ended) return ended;
    return a.attempt - b.attempt;
  });
  return sorted[sorted.length - 1];
}

function plannedForTask(task: GanttTaskInput): GanttPlanned | null {
  if (!task.start && !task.due) return null;
  const startMs = task.start ? Date.parse(`${task.start}T00:00:00.000Z`) : Number.NaN;
  const dueMs = task.due ? Date.parse(`${task.due}T00:00:00.000Z`) : Number.NaN;
  const durationMs = Number.isFinite(startMs) && Number.isFinite(dueMs) && dueMs >= startMs
    ? dueMs - startMs + ONE_DAY_MS
    : null;
  return {
    start: task.start ?? null,
    due: task.due ?? null,
    durationMs,
    coverage: task.start && task.due ? 'full' : 'partial'
  };
}

function buildCalendarWindows(tasks: readonly GanttTaskInput[]): GanttCalendarWindow[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string, GanttTaskInput[]>();
  for (const task of tasks) {
    if (!task.parentId || !byId.has(task.parentId)) continue;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }

  const candidates = tasks.filter(task => task.type === 'epic' || !task.parentId || !byId.has(task.parentId));
  return candidates.flatMap(candidate => {
    const source: GanttTaskInput[] = [];
    const visit = (task: GanttTaskInput, seen: Set<string>) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      source.push(task);
      for (const child of children.get(task.id) ?? []) visit(child, seen);
    };
    visit(candidate, new Set());

    const activeSources = source.filter(task => !TERMINAL_STATUSES.has(normalizedTaskStatus(task.status)));
    const starts = activeSources.flatMap(task => task.start ? [task.start] : []).sort();
    const dues = activeSources.flatMap(task => task.due ? [task.due] : []).sort();
    if (!starts.length && !dues.length) return [];
    const start = starts[0] ?? dues[0];
    const due = dues[dues.length - 1] ?? starts[starts.length - 1] ?? start;
    const startMs = Date.parse(`${start}T00:00:00.000Z`);
    const dueMs = Date.parse(`${due}T00:00:00.000Z`);
    return [{
      id: candidate.id,
      title: candidate.title,
      kind: candidate.type === 'epic' ? 'epic' as const : 'root-task' as const,
      start,
      due,
      durationMs: Math.max(ONE_DAY_MS, dueMs - startMs + ONE_DAY_MS),
      coverage: starts.length && dues.length ? 'full' as const : 'partial' as const,
      sourceTaskIds: activeSources.filter(task => task.start || task.due).map(task => task.id).sort()
    }];
  }).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function buildGanttDataset(input: {
  tasks: readonly GanttTaskInput[];
  dependencyEdges: readonly DependencyEdge[];
  claimViolations?: readonly ClaimViolation[];
  mode: 'pre-cutover' | 'store';
  generatedAt?: string;
}): GanttDataset {
  // dependencyEdges is the single source of truth fed to the planner here, same
  // as `mapctx plan`: task.dependsOn is display-only on GanttTaskEntry's source
  // input and is never also handed to planExecution, so a dependency is never
  // counted twice (see T-063).
  const report = planExecution({
    tasks: input.tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      type: task.type as PlannerTask['type'],
      parent: task.parentId ?? null,
      domains: [...(task.domains ?? [])]
    })),
    dependencyEdges: input.dependencyEdges
  });

  const containerIds = detectContainerIds(input.tasks);

  const blockedReasonsByTask = new Map<string, GanttBlockedReason[]>();
  for (const reason of report.blockedReasons) {
    const list = blockedReasonsByTask.get(reason.taskId) ?? [];
    list.push({
      kind: reason.kind,
      message: reason.message,
      dependencyId: reason.dependencyId,
      gateName: reason.gateName,
      gateStatus: reason.gateStatus
    });
    blockedReasonsByTask.set(reason.taskId, list);
  }

  const collisionsByTask = new Map<string, GanttCollision[]>();
  for (const pair of report.serializedPairs) {
    const a = collisionsByTask.get(pair.taskAId) ?? [];
    a.push({ withTaskId: pair.taskBId, domains: [...pair.domains], paths: [...pair.paths] });
    collisionsByTask.set(pair.taskAId, a);
    const b = collisionsByTask.get(pair.taskBId) ?? [];
    b.push({ withTaskId: pair.taskAId, domains: [...pair.domains], paths: [...pair.paths] });
    collisionsByTask.set(pair.taskBId, b);
  }

  let forecastCount = 0;
  let priorFallbackCount = 0;

  const taskEntries: GanttTaskEntry[] = input.tasks.map(task => {
    const isContainer = containerIds.has(task.id);
    const isTerminal = TERMINAL_STATUSES.has(normalizedTaskStatus(task.status));

    let forecast: GanttForecast | null = null;
    if (!isContainer && !isTerminal) {
      const snapshot = task.estimateSnapshot ?? buildEstimateSnapshot(task.id, task.receipts.map(receipt => ({
        duration: durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt)
      })));
      const isPrior = isPriorFallbackEstimate(snapshot);
      forecastCount += 1;
      if (isPrior) priorFallbackCount += 1;
      forecast = {
        estimateId: snapshot.estimateId,
        method: snapshot.method,
        confidence: snapshot.confidence,
        estimatorVersion: snapshot.estimatorVersion,
        durationP50Ms: snapshot.durationP50Ms,
        durationP90Ms: snapshot.durationP90Ms,
        durationCoverage: snapshot.durationCoverage ?? durationCoverageFromAssumptions(snapshot.assumptions),
        isPriorFallback: isPrior
      };
    }

    let actual: GanttActual | null = null;
    const planned = plannedForTask(task);
    const receipt = latestReceipt(task.receipts);
    if (receipt) {
      const durationMs = Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt);
      const p50 = forecast?.durationP50Ms ?? null;
      const p90 = forecast?.durationP90Ms ?? null;
      actual = {
        startedAt: receipt.startedAt,
        endedAt: receipt.endedAt,
        outcome: receipt.outcome,
        durationMs,
        changedFiles: [...receipt.changedFiles],
        exceedsP90: p90 === null ? null : durationMs > p90,
        actualVsP50Ratio: p50 ? durationMs / p50 : null,
        actualVsP90Ratio: p90 ? durationMs / p90 : null,
        actualVsPlannedRatio: planned?.durationMs ? durationMs / planned.durationMs : null
      };
    }

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      type: task.type ?? null,
      parentId: task.parentId ?? null,
      wave: report.waveByTaskId[task.id] ?? null,
      planned,
      blockedReasons: blockedReasonsByTask.get(task.id) ?? [],
      collisions: collisionsByTask.get(task.id) ?? [],
      forecast,
      actual
    };
  });

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode,
    allForecastsArePriorFallback: forecastCount > 0 && priorFallbackCount === forecastCount,
    tasks: taskEntries,
    calendarWindows: buildCalendarWindows(input.tasks),
    waves: report.waves.map(wave => ({ wave: wave.wave, taskIds: [...wave.taskIds] })),
    waveByTaskId: report.waveByTaskId,
    blockedReasons: report.blockedReasons,
    serializedPairs: report.serializedPairs.map(pair => ({
      taskAId: pair.taskAId,
      taskBId: pair.taskBId,
      domains: [...pair.domains],
      paths: [...pair.paths]
    })),
    claimViolations: (input.claimViolations ?? []).map(violation => ({
      id: violation.id,
      waveId: violation.waveId,
      kind: violation.kind,
      taskAId: violation.taskAId,
      taskBId: violation.taskBId,
      path: violation.path,
      detectedAt: violation.detectedAt
    })),
    policy: report.policy
  };
}
