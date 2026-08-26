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
