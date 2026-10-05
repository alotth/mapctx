import assert from 'node:assert/strict';
import test from 'node:test';
import type { EstimateSnapshot, RunReceipt } from '@mapctx/protocol';
import { buildGanttDataset } from './gantt';

const receipt: RunReceipt = {
  schemaVersion: 1,
  dispatchId: '9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc',
  attempt: 1,
  outcome: 'completed',
  startedAt: '2026-08-17T09:00:00.000Z',
  endedAt: '2026-08-17T11:00:00.000Z',
  changedFiles: ['packages/sync-engine/src/gantt.ts'],
  usageEvents: [],
  evidence: [],
  failure: null
};

test('Gantt exposes measured agent, human, parked, and lead figures independently', () => {
  const measuredReceipt: RunReceipt = {
    ...receipt,
    timeEvidence: {
      schemaVersion: 1, source: 'claude-jsonl',
      policy: { idleThresholdMs: 600_000, reviewThresholdMs: 900_000, parkedThresholdMs: 7_200_000, timeZone: 'UTC' },
      intervals: [
        { start: '2026-08-17T09:00:00.000Z', end: '2026-08-17T09:10:00.000Z', owner: 'agent', kind: 'active' },
        { start: '2026-08-17T09:10:00.000Z', end: '2026-08-17T09:20:00.000Z', owner: 'human', kind: 'review' },
        { start: '2026-08-17T09:20:00.000Z', end: '2026-08-17T11:00:00.000Z', owner: 'human', kind: 'parked' }
      ]
    }
  };
  const dataset = buildGanttDataset({ mode: 'store', tasks: [{ id: 'T-100', title: 'Intervals', status: 'review', estimatedEffort: '1h', estimatedEffortSource: 'agent-active', receipts: [measuredReceipt] }], dependencyEdges: [] });
  const task = dataset.tasks[0];
  assert.equal(task.planned?.durationMs, 3_600_000);
  assert.equal(task.actual?.durationMs, 600_000);
  assert.equal(task.actual?.humanTimeMs, 600_000);
  assert.equal(task.actual?.parkedTimeMs, 6_000_000);
  assert.equal(task.actual?.leadTimeMs, 7_200_000);
  assert.equal(task.actual?.activeTimeCoverage, 'measured');
});

test('Gantt keeps recovered session dates exact and infers missing dates from dependencies and siblings', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      { id: 'E-001', title: 'Epic', status: 'done', type: 'epic', receipts: [] },
      { id: 'T-010', title: 'Earlier sibling', status: 'done', parentId: 'E-001', start: '2026-04-01', receipts: [] },
      { id: 'T-011', title: 'Missing sibling date', status: 'done', parentId: 'E-001', receipts: [] },
      { id: 'T-012', title: 'Later sibling', status: 'done', parentId: 'E-001', start: '2026-04-05', receipts: [] },
      { id: 'T-013', title: 'Depends on later sibling', status: 'ready', parentId: 'E-001', receipts: [] },
      { id: 'T-014', title: 'Recovered session', status: 'done', receipts: [] },
      { id: 'T-015', title: 'Depends on approximate sibling', status: 'ready', parentId: 'E-001', receipts: [] }
    ],
    dependencyEdges: [
      { fromTaskId: 'T-013', toTaskId: 'T-012', kind: 'depends-on' },
      { fromTaskId: 'T-015', toTaskId: 'T-011', kind: 'depends-on' }
    ],
    historyDates: [{
      taskId: 'T-014', startedAt: '2026-04-08T09:00:00.000Z', endedAt: '2026-04-08T10:00:00.000Z',
      confidence: 'high', source: 'codex'
    }]
  });
  const byId = new Map(dataset.tasks.map(task => [task.id, task]));
  // T-112: done work without evidence gets a synthetic-schedule block instead
  // of parent interpolation; not-done work keeps dependency inheritance
  // (now starting after the synthetic block ends).
  assert.equal(byId.get('T-011')?.approximateDate?.date, '2026-04-06');
  assert.equal(byId.get('T-011')?.approximateDate?.method, 'synthetic-schedule');
  assert.equal(byId.get('T-011')?.approximateDate?.confidence, 'low');
  assert.equal(byId.get('T-013')?.approximateDate?.date, '2026-04-06');
  assert.equal(byId.get('T-013')?.approximateDate?.method, 'dependency');
  assert.equal(byId.get('T-015')?.approximateDate?.date, '2026-04-08');
  assert.equal(byId.get('T-015')?.approximateDate?.method, 'dependency');
  assert.equal(byId.get('T-014')?.historySpan?.startedAt, '2026-04-08T09:00:00.000Z');
  assert.equal(byId.get('T-014')?.approximateDate, null);
});

test('synthetic schedule lays done work backwards from measured evidence by difficulty', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      { id: 'T-001', title: 'Easy done', status: 'done', workload: 'Easy', receipts: [] },
      { id: 'T-002', title: 'Hard done', status: 'done', workload: 'Hard', receipts: [] },
      { id: 'T-003', title: 'Normal done with effort', status: 'done', workload: 'Normal', estimatedEffort: '2d', receipts: [] },
      { id: 'T-004', title: 'Paused without evidence', status: 'paused', workload: 'Hard', receipts: [] },
      { id: 'T-005', title: 'Done with dates', status: 'done', start: '2026-01-05', receipts: [] },
      {
        id: 'T-006', title: 'Measured', status: 'done', receipts: [{
          schemaVersion: 1, dispatchId: '9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc', attempt: 1,
          outcome: 'completed', startedAt: '2026-04-08T09:00:00.000Z', endedAt: '2026-04-08T10:00:00.000Z',
          changedFiles: [], usageEvents: [], evidence: [], failure: null
        }]
      }
    ],
    dependencyEdges: [{ fromTaskId: 'T-002', toTaskId: 'T-001', kind: 'depends-on' }]
  });
  const synthById = new Map(dataset.tasks.map(task => [task.id, task]));
  // Anchor is 2026-04-08: layout ends 2026-04-07 and walks backwards in
  // topological order (T-001 before its dependent T-002).
  // T-003: 2d effort = 2 calendar days -> Apr 6-7.
  assert.equal(synthById.get('T-003')?.approximateDate?.date, '2026-04-06');
  assert.equal(synthById.get('T-003')?.approximateDate?.method, 'synthetic-schedule');
  assert.equal(synthById.get('T-003')?.approximateDate?.durationMs, 1 * 24 * 60 * 60_000);
  // T-002: Hard = 4 days -> Apr 2-5; T-001: Easy = 1 day -> Apr 1.
  assert.equal(synthById.get('T-002')?.approximateDate?.date, '2026-04-02');
  assert.equal(synthById.get('T-002')?.approximateDate?.durationMs, 3 * 24 * 60 * 60_000);
  assert.equal(synthById.get('T-001')?.approximateDate?.date, '2026-04-01');
  assert.equal(synthById.get('T-001')?.approximateDate?.durationMs, 0);
  // Paused work and dated work are out of scope.
  assert.equal(synthById.get('T-004')?.approximateDate, null);
  assert.equal(synthById.get('T-005')?.approximateDate, null);
  assert.equal(synthById.get('T-006')?.approximateDate, null);
});

const measuredEstimate: EstimateSnapshot = {
  estimateId: '12345678-90ab-4cde-8f01-23456789abcd',
  taskId: 'T-002',
  createdAt: '2026-08-17T08:00:00.000Z',
  method: 'historical-baseline',
  confidence: 'medium',
  estimatorVersion: 'forecast-v1',
  idleThresholdMs: 600_000,
  costCoverage: 'none',
  durationP50Ms: 30 * 60_000,
  durationP90Ms: 60 * 60_000,
  inputTokensP50: 0,
  inputTokensP90: 0,
  outputTokensP50: 0,
  outputTokensP90: 0,
  cacheTokensP50: 0,
  cacheTokensP90: 0,
  shadowMicrosP50: 0,
  shadowMicrosP90: 0,
  assumptions: ['duration coverage: measured']
};

test('pre-cutover dataset is honest about prior forecasts, blockers, and absent active dates', () => {
  const dataset = buildGanttDataset({
    generatedAt: '2026-08-17T12:00:00.000Z',
    mode: 'pre-cutover',
    tasks: [
      { id: 'E-001', title: 'Epic', status: 'backlog', type: 'epic', start: null, due: null, receipts: [] },
      { id: 'T-001', title: 'Ready work', status: 'backlog', parentId: 'E-001', start: null, due: null, receipts: [] },
      { id: 'T-003', title: 'Paused work', status: 'paused', parentId: 'E-001', start: null, due: null, receipts: [] },
      { id: 'T-004', title: 'Old dated work', status: 'done', parentId: 'E-001', start: '2026-01-01', due: '2026-01-02', receipts: [] }
    ],
    dependencyEdges: []
  });

  assert.equal(dataset.generatedAt, '2026-08-17T12:00:00.000Z');
  assert.equal(dataset.calendarWindows.length, 0, 'completed historical dates are not current delivery commitments');
  assert.equal(dataset.allForecastsArePriorFallback, true);
  assert.equal(dataset.tasks.find(task => task.id === 'E-001')?.forecast, null, 'epics are containers, not dispatch estimates');
  assert.equal(dataset.tasks.find(task => task.id === 'T-001')?.forecast?.method, 'expert-guess');
  assert.match(dataset.tasks.find(task => task.id === 'T-003')?.blockedReasons[0]?.message ?? '', /status is paused/);
});

test('dataset carries calendar commitments, measured forecast provenance, actual variance, and claim violations', () => {
  const dataset = buildGanttDataset({
    generatedAt: '2026-08-17T12:00:00.000Z',
    mode: 'store',
    tasks: [
      { id: 'E-002', title: 'Delivery epic', status: 'backlog', type: 'epic', receipts: [] },
      {
        id: 'T-002',
        title: 'Measured task',
        status: 'review',
        parentId: 'E-002',
        start: '2026-08-17',
        due: '2026-08-17',
        estimateSnapshot: measuredEstimate,
        receipts: [receipt]
      }
    ],
    dependencyEdges: [],
    claimViolations: [{
      id: 'ffff6666-0000-4111-8222-333377778888',
      waveId: 'eeee5555-ffff-4000-8111-222266667777',
      kind: 'collision',
      taskAId: 'T-002',
      taskBId: 'T-099',
      path: 'packages/sync-engine/src/gantt.ts',
      source: 'derived-from-receipts',
      detectedAt: '2026-08-17T11:05:00.000Z'
    }]
  });

  const task = dataset.tasks.find(item => item.id === 'T-002');
  assert.equal(dataset.calendarWindows.length, 1);
  assert.deepEqual(dataset.calendarWindows[0].sourceTaskIds, ['T-002']);
  assert.equal(task?.forecast?.durationCoverage, 'measured');
  assert.equal(task?.forecast?.isPriorFallback, false);
  assert.equal(task?.actual?.exceedsP90, true);
  assert.equal(task?.actual?.actualVsP90Ratio, 2);
  assert.equal(task?.actual?.actualVsPlannedRatio, 2 / 24);
  assert.equal(dataset.claimViolations[0].taskAId, 'T-002');
});

test('Gantt prefers durable snapshot duration coverage over legacy assumption text', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [{
      id: 'T-010',
      title: 'Coverage disagreement',
      status: 'ready',
      estimateSnapshot: { ...measuredEstimate, taskId: 'T-010', durationCoverage: 'substituted' },
      receipts: []
    }],
    dependencyEdges: []
  });
  assert.equal(dataset.tasks[0].forecast?.durationCoverage, 'substituted');
});

test('pools workload receipts for active forecasts and gives terminal work a retrospective baseline', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      { id: 'T-090', title: 'Measured done', status: 'done', workload: 'Hard', receipts: [receipt] },
      { id: 'T-091', title: 'Next hard task', status: 'ready', workload: 'Hard', receipts: [] },
      { id: 'T-092', title: 'Off-scale workload', status: 'ready', workload: 'Medium', receipts: [] }
    ],
    dependencyEdges: []
  });

  const done = dataset.tasks.find(task => task.id === 'T-090');
  const next = dataset.tasks.find(task => task.id === 'T-091');
  assert.equal(dataset.allForecastsArePriorFallback, false);
  assert.equal(done?.forecast?.method, 'historical-baseline');
  assert.equal(next?.forecast?.method, 'historical-baseline');
  assert.ok(dataset.tasks.find(task => task.id === 'T-092')?.forecast, 'unknown workload value falls back to default prior instead of throwing');
  assert.equal(done?.actual?.actualVsP50Ratio, 1);
  assert.equal(done?.actual?.actualVsP90Ratio, 1);
});

test('Gantt renders duration-only planned effort from both agent-active and legacy sources', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      {
        id: 'T-110', title: 'New estimate', status: 'review', workload: 'Normal',
        estimatedEffort: '0.5d', estimatedEffortSource: 'agent-active', receipts: [receipt]
      },
      {
        id: 'T-111', title: 'Historical estimate', status: 'ready', workload: 'Normal',
        estimatedEffort: '1w', estimatedEffortSource: 'legacy-human', receipts: []
      }
    ],
    dependencyEdges: []
  });

  const active = dataset.tasks.find(task => task.id === 'T-110');
  const legacy = dataset.tasks.find(task => task.id === 'T-111');
  assert.deepEqual(active?.planned, {
    start: null, due: null, durationMs: 4 * 60 * 60_000,
    coverage: 'duration-only', source: 'estimated-effort-agent-active'
  });
  assert.equal(active?.actual?.actualVsPlannedRatio, 0.5, 'receipt active time is compared in the same unit');
  assert.equal(active?.actual?.activeTimeCoverage, 'substituted', 'T-100 owns measured interval extraction');
  assert.equal(legacy?.planned?.durationMs, 40 * 60 * 60_000);
  assert.equal(legacy?.planned?.source, 'estimated-effort-legacy-human');
});

test('Gantt uses dates for placement but valid effort for planned duration and variance', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      {
        id: 'T-112', title: 'Placed active plan', status: 'review', workload: 'Normal',
        start: '2026-08-17', due: '2026-08-21',
        estimatedEffort: '0.5d', estimatedEffortSource: 'agent-active', receipts: [receipt]
      },
      {
        id: 'T-113', title: 'Calendar fallback', status: 'ready', workload: 'Normal',
        start: '2026-08-17', due: '2026-08-18',
        estimatedEffort: 'tomorrow', estimatedEffortSource: 'agent-active', receipts: []
      }
    ],
    dependencyEdges: []
  });

  const active = dataset.tasks.find(task => task.id === 'T-112');
  assert.deepEqual(active?.planned, {
    start: '2026-08-17', due: '2026-08-21', durationMs: 4 * 60 * 60_000,
    coverage: 'full', source: 'estimated-effort-agent-active'
  });
  assert.equal(active?.actual?.actualVsPlannedRatio, 0.5, '2h actual compares with 4h effort, not five calendar days');

  const fallback = dataset.tasks.find(task => task.id === 'T-113');
  assert.equal(fallback?.planned?.durationMs, 2 * 24 * 60 * 60_000);
  assert.equal(fallback?.planned?.source, 'calendar-dates');
});

test('aligned plans and receipt-less done tasks are excluded from accuracy and duration measurement', () => {
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      { id: 'T-120', title: 'Aligned history', status: 'done', workload: 'Normal', estimatedEffort: '', receipts: [receipt] },
      { id: 'T-121', title: 'No receipt history', status: 'done', workload: 'Normal', estimatedEffort: '', receipts: [] }
    ],
    dependencyEdges: []
  });

  const aligned = dataset.tasks.find(task => task.id === 'T-120');
  const absent = dataset.tasks.find(task => task.id === 'T-121');
  assert.equal(aligned?.planned?.source, 'aligned-from-actual');
  assert.equal(aligned?.planned?.durationMs, aligned?.actual?.durationMs);
  assert.equal(aligned?.actual?.actualVsPlannedRatio, null);
  assert.equal(aligned?.actual?.plannedAccuracyEligible, false);
  assert.deepEqual(absent?.measurement, { status: 'no-measurement' });
  assert.equal(absent?.actual, null);
});

test('T-102 history tier rides the latest receipt and inferred backfills never calibrate', () => {
  const measured: RunReceipt = {
    ...receipt,
    timeEvidence: {
      schemaVersion: 1, source: 'claude-jsonl',
      policy: { idleThresholdMs: 600_000, reviewThresholdMs: 900_000, parkedThresholdMs: 7_200_000, timeZone: 'UTC' },
      intervals: [
        { start: '2026-08-17T09:00:00.000Z', end: '2026-08-17T10:00:00.000Z', owner: 'agent', kind: 'active' }
      ]
    }
  };
  const inferred: RunReceipt = {
    ...receipt,
    dispatchId: 'aaaaaaaa-6c18-4a0f-b3d5-11aa22bb33cc',
    historySource: 'codex',
    historyTier: 'inferred'
  };
  const dataset = buildGanttDataset({
    mode: 'store',
    tasks: [
      {
        id: 'T-130', title: 'Measured backfill', status: 'done', workload: 'Normal',
        receipts: [{ ...measured, dispatchId: 'bbbbbbbb-6c18-4a0f-b3d5-11aa22bb33cc', historySource: 'codex', historyTier: 'measured' }]
      },
      { id: 'T-131', title: 'Inferred backfill', status: 'done', workload: 'Normal', receipts: [inferred] },
      {
        id: 'T-132', title: 'Predicted future', status: 'ready', workload: 'Normal',
        predictedStart: { start: '2026-10-15', method: 'manual', confidence: 'low' }, receipts: []
      }
    ],
    dependencyEdges: []
  });

  const measuredEntry = dataset.tasks.find(task => task.id === 'T-130');
  const inferredEntry = dataset.tasks.find(task => task.id === 'T-131');
  const predictedEntry = dataset.tasks.find(task => task.id === 'T-132');
  assert.deepEqual(measuredEntry?.history, { source: 'codex', tier: 'measured' });
  assert.deepEqual(inferredEntry?.history, { source: 'codex', tier: 'inferred' });
  assert.equal(predictedEntry?.history, null);
  assert.deepEqual(predictedEntry?.predicted, { start: '2026-10-15', method: 'manual', confidence: 'low' });
  assert.equal(measuredEntry?.forecast?.isPriorFallback, false, 'measured history calibrates');
  assert.equal(measuredEntry?.forecast?.durationP50Ms, 3_600_000);
  assert.equal(inferredEntry?.forecast?.isPriorFallback, true, 'inferred backfill never calibrates');
  assert.notEqual(inferredEntry?.forecast?.durationP50Ms, 7_200_000, 'prior kept, wall-clock stand-in ignored');
});
