import {
  buildEstimateSnapshot,
  durationCoverageFromAssumptions,
  durationMeasuresFromReceipt,
  isPriorFallbackEstimate,
  parseEstimatedEffortMs,
  WORKLOAD_PRIORS,
  type DurationCoverage,
  type ForecastSample,
  type Workload
} from '@mapctx/forecast';
import { planExecution, type PlannerTask } from '@mapctx/planner';
import {
  STATUS_TO_PLANNING,
  type ClaimViolation,
  type DependencyEdge,
  type EstimateSnapshot,
  type HistorySource,
  type HistoryTier,
  type PredictedStart,
  type RunReceipt
} from '@mapctx/protocol';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const KNOWN_WORKLOADS = new Set<string>(Object.keys(WORKLOAD_PRIORS));

/** Board data may carry values outside the forecast prior set (e.g. "Medium"); treat those as undeclared. */
function normalizedWorkload(workload: string | null | undefined): Workload | undefined {
  return workload != null && KNOWN_WORKLOADS.has(workload) ? (workload as Workload) : undefined;
}

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
  workload?: string | null;
  estimatedEffort?: string | null;
  /** Missing on historic rows means legacy-human; no estimate is reinterpreted. */
  estimatedEffortSource?: 'agent-active' | 'legacy-human';
  /** Latest immutable estimate, when one has already been recorded by the store. */
  estimateSnapshot?: EstimateSnapshot | null;
  /**
   * T-102 agent-authored start prediction (schema only). Never positions a bar
   * and never feeds calibration; the view renders it distinctly from planned.
   */
  predictedStart?: PredictedStart | null;
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
  humanTimeMs: number;
  parkedTimeMs: number;
  leadTimeMs: number;
  /** T-100 owns transcript-derived measurement; receipt-only work is a stand-in. */
  activeTimeCoverage: DurationCoverage;
  changedFiles: string[];
  /** null when there is no forecast to compare against (containers/terminal tasks never get one). */
  exceedsP90: boolean | null;
  actualVsP50Ratio: number | null;
  actualVsP90Ratio: number | null;
  /** False when planned was retrospectively aligned from the same actual. */
  plannedAccuracyEligible: boolean;
  actualVsPlannedRatio: number | null;
};

export type GanttHistoryDate = {
  taskId: string;
  startedAt: string;
  endedAt: string;
  confidence: string;
  source: string | null;
  /** T-116 review 2: measured or inferred; inferred never displays as actual. */
  tier?: 'measured' | 'inferred';
  /** Aggregated active agent time across the task's approved evidence. */
  activeMs?: number | null;
};

export type GanttHistorySpan = {
  startedAt: string;
  endedAt: string;
  confidence: string;
  source: string | null;
  tier?: 'measured' | 'inferred';
  activeMs?: number | null;
};

export type GanttApproximateDate = {
  date: string;
  method: 'dependency' | 'parent' | 'task-order' | 'synthetic-schedule';
  confidence: 'medium' | 'low';
  /**
   * T-112: synthetic calendar span in ms (inclusive end = date + durationMs).
   * Point marker when null; only synthetic-schedule sets it. Never feeds
   * calibration: the UI positions the bar, forecasts ignore it.
   */
  durationMs?: number | null;
};

export type GanttPlanned = {
  start: string | null;
  due: string | null;
  durationMs: number | null;
  coverage: 'full' | 'partial' | 'duration-only';
  source: 'calendar-dates' | 'estimated-effort-agent-active' | 'estimated-effort-legacy-human' | 'aligned-from-actual';
};

export type GanttMeasurement = {
  status: 'receipt-substituted' | 'receipt-measured' | 'receipt-no-agent-observation' | 'no-measurement';
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

export type GanttHistory = {
  source: HistorySource;
  tier: HistoryTier;
};

export type GanttPredicted = {
  start: string;
  method: string;
  confidence: string;
};

export type GanttTaskEntry = {
  id: string;
  title: string;
  status: string;
  type: string | null;
  parentId: string | null;
  wave: number | null;
  planned: GanttPlanned | null;
  /** Done work with no receipt is explicitly not a zero-duration sample. */
  measurement: GanttMeasurement | null;
  /**
   * T-102: history evidence of the latest receipt (T-101 backfill or live).
   * Read, never recomputed: inferred/declared tiers stay out of calibration
   * via the sample's historyTier (same rule as aligned-from-actual). Null =
   * no receipt linkage; done tasks without it render "no history".
   */
  history: GanttHistory | null;
  /** T-102 prediction passthrough (display only, never positions). */
  predicted: GanttPredicted | null;
  blockedReasons: GanttBlockedReason[];
  collisions: GanttCollision[];
  /** null for containers (epics/parents); terminal tasks receive retrospective baselines. */
  forecast: GanttForecast | null;
  /** null unless at least one receipt exists for this task. */
  actual: GanttActual | null;
  /** Exact session bounds recovered from local history, separate from receipts. */
  historySpan: GanttHistorySpan | null;
  /** Read-only date estimate. Never copied into task start/due fields. */
  approximateDate: GanttApproximateDate | null;
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

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'archived']);

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

function plannedForTask(task: GanttTaskInput, receipt: RunReceipt | undefined): GanttPlanned | null {
  const hasPlacement = Boolean(task.start || task.due);
  const startMs = task.start ? Date.parse(`${task.start}T00:00:00.000Z`) : Number.NaN;
  const dueMs = task.due ? Date.parse(`${task.due}T00:00:00.000Z`) : Number.NaN;
  const calendarDurationMs = Number.isFinite(startMs) && Number.isFinite(dueMs) && dueMs >= startMs
    ? dueMs - startMs + ONE_DAY_MS
    : null;

  // Calendar dates place the bar. A valid effort owns planned duration and
  // variance even when those dates exist; this keeps calendar span separate
  // from agent-active time.
  const estimatedDurationMs = task.estimatedEffort ? parseEstimatedEffortMs(task.estimatedEffort) : null;
  if (estimatedDurationMs !== null) {
    return {
      start: task.start ?? null,
      due: task.due ?? null,
      durationMs: estimatedDurationMs,
      coverage: task.start && task.due ? 'full' : hasPlacement ? 'partial' : 'duration-only',
      source: task.estimatedEffortSource === 'agent-active'
        ? 'estimated-effort-agent-active'
        : 'estimated-effort-legacy-human'
    };
  }

  // Missing or invalid effort falls back to calendar span for duration. The
  // source makes that fallback explicit rather than presenting it as effort.
  if (hasPlacement) {
    return {
      start: task.start ?? null,
      due: task.due ?? null,
      durationMs: calendarDurationMs,
      coverage: task.start && task.due ? 'full' : 'partial',
      source: 'calendar-dates'
    };
  }

  // Alignment is retrospective only: preserve an honest planned-looking bar
  // for completed history, but never feed its trivially-1 ratio into accuracy.
  if (normalizedTaskStatus(task.status) === 'done' && receipt) {
    const duration = durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { timeEvidence: receipt.timeEvidence });
    if (duration.activeTimeCoverage === 'none') return null;
    return {
      start: null,
      due: null,
      durationMs: duration.activeTimeMs,
      coverage: 'duration-only',
      source: 'aligned-from-actual'
    };
  }
  return null;
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
  historyDates?: readonly GanttHistoryDate[];
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
  const historyDates = new Map((input.historyDates ?? []).map(item => [item.taskId, item]));

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
  // A done task with no receipt emits no sample at all. Zero is not a
  // measurement, so it must not dilute duration pools. T-102: samples carry
  // their receipt's historyTier so inferred/declared/no-history backfills
  // never calibrate (estimate.hasAgentObservation enforces the exclusion).
  const pooledSamples: ForecastSample[] = input.tasks.flatMap(task => task.receipts.map(receipt => ({
    duration: durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { timeEvidence: receipt.timeEvidence }),
    timePolicy: receipt.timeEvidence?.policy,
    historyTier: receipt.historyTier,
    workload: normalizedWorkload(task.workload)
  })));

  const taskEntries: GanttTaskEntry[] = input.tasks.map(task => {
    const isContainer = containerIds.has(task.id);
    const isTerminal = TERMINAL_STATUSES.has(normalizedTaskStatus(task.status));

    let forecast: GanttForecast | null = null;
    if (!isContainer) {
      const ownSamples = task.receipts.map(receipt => ({
        duration: durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { timeEvidence: receipt.timeEvidence }),
        timePolicy: receipt.timeEvidence?.policy,
        historyTier: receipt.historyTier,
        workload: normalizedWorkload(task.workload)
      }));
      const samples = ownSamples.length > 0 ? ownSamples : pooledSamples;
      const snapshot = task.estimateSnapshot ?? buildEstimateSnapshot(task.id, samples, {
        workload: normalizedWorkload(task.workload)
      });
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
    const receipt = latestReceipt(task.receipts);
    const planned = plannedForTask(task, receipt);
    const receiptDuration = receipt ? durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { timeEvidence: receipt.timeEvidence, readyAt: task.start ?? receipt.startedAt }) : null;
    const measurement: GanttMeasurement | null = receipt
      ? { status: receiptDuration?.activeTimeCoverage === 'measured' ? 'receipt-measured'
        : receiptDuration?.activeTimeCoverage === 'none' ? 'receipt-no-agent-observation' : 'receipt-substituted' }
      : normalizedTaskStatus(task.status) === 'done'
        ? { status: 'no-measurement' }
        : null;
    if (receipt) {
      const duration = receiptDuration!;
      const durationMs = duration.activeTimeMs;
      const p50 = forecast?.durationP50Ms ?? null;
      const p90 = forecast?.durationP90Ms ?? null;
      actual = {
        startedAt: receipt.startedAt,
        endedAt: receipt.endedAt,
        outcome: receipt.outcome,
        durationMs,
        humanTimeMs: duration.humanTimeMs ?? 0,
        parkedTimeMs: duration.parkedTimeMs ?? 0,
        leadTimeMs: duration.leadTimeMs,
        activeTimeCoverage: duration.activeTimeCoverage,
        changedFiles: [...receipt.changedFiles],
        exceedsP90: duration.activeTimeCoverage === 'none' || p90 === null ? null : durationMs > p90,
        actualVsP50Ratio: duration.activeTimeCoverage !== 'none' && p50 ? durationMs / p50 : null,
        actualVsP90Ratio: duration.activeTimeCoverage !== 'none' && p90 ? durationMs / p90 : null,
        plannedAccuracyEligible: duration.activeTimeCoverage !== 'none' && planned?.durationMs !== null && planned?.durationMs !== undefined && planned.source !== 'aligned-from-actual',
        actualVsPlannedRatio: duration.activeTimeCoverage !== 'none' && planned?.durationMs && planned.source !== 'aligned-from-actual'
          ? durationMs / planned.durationMs
          : null
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
      measurement,
      // Read from the latest receipt; never recompute linkage here.
      history: receipt?.historySource && receipt?.historyTier
        ? { source: receipt.historySource, tier: receipt.historyTier }
        : null,
      predicted: task.predictedStart
        ? { start: task.predictedStart.start, method: task.predictedStart.method, confidence: task.predictedStart.confidence }
        : null,
      blockedReasons: blockedReasonsByTask.get(task.id) ?? [],
      collisions: collisionsByTask.get(task.id) ?? [],
      forecast,
      actual,
      historySpan: !receipt && historyDates.has(task.id) ? {
        startedAt: historyDates.get(task.id)!.startedAt,
        endedAt: historyDates.get(task.id)!.endedAt,
        confidence: historyDates.get(task.id)!.confidence,
        source: historyDates.get(task.id)!.source,
        tier: historyDates.get(task.id)!.tier ?? 'measured',
        activeMs: historyDates.get(task.id)!.activeMs ?? null
      } : null,
      approximateDate: null
    };
  });

  inferSyntheticSchedule(input.tasks, input.dependencyEdges, taskEntries);
  inferApproximateDates(input.tasks, input.dependencyEdges, taskEntries);

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

function taskNumber(id: string): { prefix: string; number: number } | null {
  const match = /^(.*?)-(\d+)$/.exec(id);
  return match ? { prefix: match[1], number: Number(match[2]) } : null;
}

function entryAnchor(entry: GanttTaskEntry | undefined): { start: number; end: number } | null {
  if (!entry) return null;
  const start = entry.actual?.startedAt ?? entry.historySpan?.startedAt ?? entry.planned?.start;
  const end = entry.actual?.endedAt ?? entry.historySpan?.endedAt ?? entry.planned?.due ?? start;
  const startMs = start ? Date.parse(start) : Number.NaN;
  const endMs = end ? Date.parse(end) : Number.NaN;
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { start: startMs, end: endMs } : null;
}

function dayKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * T-112 synthetic backfill for done work without evidence. Done tasks that
 * have no anchor (no receipt, no history span, no planned dates) would
 * otherwise be interpolated between far-apart anchors by task number, which
 * produced absurd positions (e.g. future dates). Instead they are laid out
 * sequentially backwards from the earliest measured evidence: topological
 * order (prerequisites first, task number breaks ties), one calendar block
 * per task sized by difficulty. The result is honest speculation --
 * method `synthetic-schedule`, confidence low -- and never feeds calibration.
 */
const SYNTHETIC_AGENT_DAY_MS = 8 * 60 * 60_000;
const SYNTHETIC_WORKLOAD_DAYS: Record<string, number> = { Easy: 1, Normal: 2, Hard: 4, Extreme: 8 };

function syntheticDaysFor(input: GanttTaskInput): number {
  if (input.estimatedEffort) {
    const ms = parseEstimatedEffortMs(input.estimatedEffort);
    if (Number.isFinite(ms) && (ms as number) > 0) {
      return Math.max(1, Math.ceil((ms as number) / SYNTHETIC_AGENT_DAY_MS));
    }
  }
  const workload = normalizedWorkload(input.workload);
  if (workload) return SYNTHETIC_WORKLOAD_DAYS[workload] ?? 2;
  return 2;
}

function inferSyntheticSchedule(
  tasks: readonly GanttTaskInput[],
  dependencyEdges: readonly DependencyEdge[],
  entries: GanttTaskEntry[]
): void {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const inputById = new Map(tasks.map(task => [task.id, task]));
  const scope = entries.filter(entry => {
    const input = inputById.get(entry.id);
    if (!input || String(input.status || '').toLowerCase() !== 'done') return false;
    if (entryAnchor(entry) || entry.planned?.start || entry.planned?.due) return false;
    return true;
  });
  if (!scope.length) return;

  // Anchor: earliest measured evidence; synthetic work ends the day before.
  // Fallbacks keep the layout total (planned dates, then today) instead of
  // collapsing everything onto one day.
  const measuredStarts = entries.flatMap(entry =>
    [entry.actual?.startedAt, entry.historySpan?.startedAt]
      .map(value => (value ? Date.parse(value) : Number.NaN))
      .filter(value => Number.isFinite(value))
  );
  const plannedStarts = entries.flatMap(entry =>
    [entry.planned?.start]
      .map(value => (value ? Date.parse(value) : Number.NaN))
      .filter(value => Number.isFinite(value))
  );
  const anchor = measuredStarts.length ? Math.min(...measuredStarts)
    : plannedStarts.length ? Math.min(...plannedStarts)
      : Date.now();
  let cursor = Date.parse(dayKey(anchor - ONE_DAY_MS) + 'T00:00:00.000Z');

  // Prerequisites (edge toTaskId) come before their dependents (fromTaskId).
  const prerequisitesOf = new Map<string, string[]>();
  for (const edge of dependencyEdges) {
    const list = prerequisitesOf.get(edge.fromTaskId) ?? [];
    list.push(edge.toTaskId);
    prerequisitesOf.set(edge.fromTaskId, list);
  }
  const inScope = new Set(scope.map(entry => entry.id));
  const pendingPrereqs = new Map<string, number>();
  for (const entry of scope) {
    pendingPrereqs.set(entry.id, (prerequisitesOf.get(entry.id) ?? []).filter(id => inScope.has(id)).length);
  }
  const numberOf = (id: string): number => taskNumber(id)?.number ?? Number.MAX_SAFE_INTEGER;
  const ordered: GanttTaskEntry[] = [];
  const ready = scope.filter(entry => (pendingPrereqs.get(entry.id) ?? 0) === 0)
    .sort((a, b) => numberOf(a.id) - numberOf(b.id) || a.id.localeCompare(b.id));
  const dependentsOf = new Map<string, string[]>();
  for (const edge of dependencyEdges) {
    if (!inScope.has(edge.fromTaskId) || !inScope.has(edge.toTaskId)) continue;
    const list = dependentsOf.get(edge.toTaskId) ?? [];
    list.push(edge.fromTaskId);
    dependentsOf.set(edge.toTaskId, list);
  }
  const queue = [...ready];
  const emitted = new Set<string>();
  while (queue.length) {
    const next = queue.shift()!;
    if (emitted.has(next.id)) continue;
    emitted.add(next.id);
    ordered.push(next);
    for (const dependent of dependentsOf.get(next.id) ?? []) {
      const remaining = (pendingPrereqs.get(dependent) ?? 1) - 1;
      pendingPrereqs.set(dependent, remaining);
      if (remaining <= 0 && !emitted.has(dependent)) {
        queue.push(byId.get(dependent)!);
        queue.sort((a, b) => numberOf(a.id) - numberOf(b.id) || a.id.localeCompare(b.id));
      }
    }
  }
  // Cycles (or edges to missing tasks) fall back to plain task-number order.
  for (const entry of [...scope].sort((a, b) => numberOf(a.id) - numberOf(b.id) || a.id.localeCompare(b.id))) {
    if (!emitted.has(entry.id)) {
      emitted.add(entry.id);
      ordered.push(entry);
    }
  }

  // Walk backwards: the last task in topological order ends at the anchor.
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const entry = ordered[index];
    const days = Math.max(1, syntheticDaysFor(inputById.get(entry.id)!));
    const end = cursor;
    const start = end - (days - 1) * ONE_DAY_MS;
    entry.approximateDate = {
      date: dayKey(start),
      method: 'synthetic-schedule',
      confidence: 'low',
      durationMs: (days - 1) * ONE_DAY_MS
    };
    cursor = start - ONE_DAY_MS;
  }
}

function inferApproximateDates(
  tasks: readonly GanttTaskInput[],
  dependencyEdges: readonly DependencyEdge[],
  entries: GanttTaskEntry[]
): void {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const inputById = new Map(tasks.map(task => [task.id, task]));
  const dependents = new Map<string, string[]>();
  for (const edge of dependencyEdges) {
    const list = dependents.get(edge.fromTaskId) ?? [];
    list.push(edge.toTaskId);
    dependents.set(edge.fromTaskId, list);
  }
  // T-112: halted and terminal work is never positioned by guess. Paused and
  // archived tasks without dates stay unscheduled (operator decision);
  // cancelled without evidence keeps the "no history" lane. Only live
  // (backlog/ready/doing/review) and done work is interpolated.
  const isPositionable = (entry: GanttTaskEntry): boolean =>
    !['paused', 'archived', 'cancelled'].includes(String(entry.status || '').toLowerCase());
  const candidates = entries.filter(entry => isPositionable(entry) && !entryAnchor(entry) && !entry.planned?.start && !entry.planned?.due)
    .map(entry => ({ entry, identity: taskNumber(entry.id) }))
    .filter(item => item.identity)
    .sort((a, b) => a.identity!.number - b.identity!.number);

  // Resolve the stronger local signals first. A dependency places work after
  // its prerequisite; siblings inherit/interpolate within their parent's range.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const item of candidates) {
      if (item.entry.approximateDate) continue;
      const predecessorAnchors = (dependents.get(item.entry.id) ?? [])
        .map(id => entryAnchor(byId.get(id)))
        .filter((anchor): anchor is { start: number; end: number } => Boolean(anchor));
      if (predecessorAnchors.length) {
        const latest = Math.max(...predecessorAnchors.map(anchor => anchor.end));
        item.entry.approximateDate = { date: dayKey(latest + ONE_DAY_MS), method: 'dependency', confidence: 'medium' };
        continue;
      }
      const parentId = inputById.get(item.entry.id)?.parentId;
      if (!parentId) continue;
      const siblingAnchors = entries.flatMap(sibling => {
        if (sibling.id === item.entry.id || inputById.get(sibling.id)?.parentId !== parentId) return [];
        const anchor = entryAnchor(sibling);
        const identity = taskNumber(sibling.id);
        return anchor && identity && identity.prefix === item.identity!.prefix ? [{ number: identity.number, date: anchor.start }] : [];
      }).sort((a, b) => a.number - b.number);
      const lower = [...siblingAnchors].reverse().find(anchor => anchor.number < item.identity!.number);
      const upper = siblingAnchors.find(anchor => anchor.number > item.identity!.number);
      if (lower && upper && upper.date >= lower.date) {
        const ratio = (item.identity!.number - lower.number) / (upper.number - lower.number);
        item.entry.approximateDate = { date: dayKey(lower.date + (upper.date - lower.date) * ratio), method: 'parent', confidence: 'medium' };
      } else if (lower || upper) {
        item.entry.approximateDate = { date: dayKey((lower ?? upper)!.date), method: 'parent', confidence: 'medium' };
      } else {
        const parentAnchor = entryAnchor(byId.get(parentId));
        if (parentAnchor) item.entry.approximateDate = { date: dayKey(parentAnchor.start), method: 'parent', confidence: 'medium' };
      }
    }
  }

  // Task number is deliberately weakest: only interpolate between chronological
  // anchors when their dates agree with ID order. Otherwise use nearest anchor.
  for (const item of candidates) {
    if (item.entry.approximateDate) continue;
    const anchors = entries.flatMap(entry => {
      const anchor = entryAnchor(entry);
      const identity = taskNumber(entry.id);
      return anchor && identity && identity.prefix === item.identity!.prefix
        ? [{ number: identity.number, date: anchor.start }]
        : [];
    }).sort((a, b) => a.number - b.number);
    const lower = [...anchors].reverse().find(anchor => anchor.number < item.identity!.number);
    const upper = anchors.find(anchor => anchor.number > item.identity!.number);
    let time: number | null = null;
    if (lower && upper && upper.date >= lower.date) {
      const ratio = (item.identity!.number - lower.number) / (upper.number - lower.number);
      time = lower.date + (upper.date - lower.date) * ratio;
    } else if (lower || upper) {
      time = (lower ?? upper)!.date;
    }
    if (time !== null) item.entry.approximateDate = { date: dayKey(time), method: 'task-order', confidence: 'low' };
  }

  // Let dependency chains inherit a date once their prerequisite has its own
  // approximate position. Dependency remains stronger than weak task numbering.
  for (let pass = 0; pass < candidates.length; pass += 1) {
    let changed = false;
    for (const item of candidates) {
      // T-112: synthetic-schedule blocks are the final answer for done work
      // without evidence; dependency inheritance must not move them.
      if (item.entry.approximateDate?.method === 'synthetic-schedule') continue;
      const prerequisiteDates = (dependents.get(item.entry.id) ?? []).flatMap(id => {
        const prerequisite = byId.get(id);
        const exact = entryAnchor(prerequisite);
        if (exact) return [exact.end];
        const approximate = prerequisite?.approximateDate?.date;
        const approximateMs = approximate ? Date.parse(`${approximate}T00:00:00.000Z`) : Number.NaN;
        // T-112: synthetic blocks occupy a span; dependents start after its end.
        const approximateEnd = Number.isFinite(approximateMs)
          ? approximateMs + Math.max(0, Number(prerequisite?.approximateDate?.durationMs) || 0)
          : Number.NaN;
        return Number.isFinite(approximateEnd) ? [approximateEnd] : [];
      });
      if (!prerequisiteDates.length) continue;
      const date = dayKey(Math.max(...prerequisiteDates) + ONE_DAY_MS);
      if (item.entry.approximateDate?.date === date && item.entry.approximateDate.method === 'dependency') continue;
      item.entry.approximateDate = { date, method: 'dependency', confidence: 'medium' };
      changed = true;
    }
    if (!changed) break;
  }
}
