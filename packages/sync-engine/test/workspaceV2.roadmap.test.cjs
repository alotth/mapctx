const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the shipped webview source, then call the row path used by
// renderRoadmapTimeline. A dataset-only test would miss orphan renderers.
function renderLiveRow(data, status = 'ready') {
  const noop = () => {};
  const element = { classList: { toggle: noop }, addEventListener: noop };
  const context = vm.createContext({
    console,
    window: { localStorage: { getItem: () => null, setItem: noop }, addEventListener: noop },
    document: { getElementById: () => element, querySelector: () => null, addEventListener: noop },
    __dataset: { tasks: [data], claimViolations: [] },
    __boardTask: { id: data.id, title: data.title, status, type: 'feature' }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'workspace-ui', 'workspaceV2.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'workspaceV2.js' });
  return vm.runInContext(`(() => {
    ganttDataset = __dataset;
    const task = normalizeRoadmapTasks([__boardTask])[0];
    return renderRoadmapRow({ task, depth: 0 }, buildRoadmapTimeline([task]), 0);
  })()`, context);
}

function rowData(id, overrides = {}) {
  return {
    id, title: id, wave: 1, planned: null, forecast: null, actual: null,
    measurement: null, history: null, predicted: null, blockedReasons: [], collisions: [],
    ...overrides
  };
}

// Multi-task helper for the T-102 history view: chronological order plus
// epic and tier filters, through the shipped source (no substitutes).
function historyItems(boardTasks, datasetTasks, filters) {
  const noop = () => {};
  const element = { classList: { toggle: noop }, addEventListener: noop };
  const context = vm.createContext({
    console,
    window: { localStorage: { getItem: () => null, setItem: noop }, addEventListener: noop },
    document: { getElementById: () => element, querySelector: () => null, addEventListener: noop },
    __dataset: { tasks: datasetTasks, claimViolations: [] },
    __boardTasks: boardTasks,
    __filters: filters
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'workspace-ui', 'workspaceV2.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'workspaceV2.js' });
  return vm.runInContext(`(() => {
    ganttDataset = __dataset;
    const tasks = normalizeRoadmapTasks(__boardTasks);
    return historyViewItems(tasks, __filters).map(item => ({
      id: item.task.id, epoch: item.epoch, lane: item.lane, tier: item.tier, epicId: item.epicId
    }));
  })()`, context);
}

test('visible roadmap row shows agent-active Planned duration without dates', () => {
  const html = renderLiveRow(rowData('T-110', {
    planned: { start: null, due: null, durationMs: 4 * 60 * 60_000,
      coverage: 'duration-only', source: 'estimated-effort-agent-active' }
  }));
  assert.match(html, /Planned 4h · agent-active estimate/);
  assert.match(html, /Unscheduled/);
});

test('calendar dates place row while active effort remains displayed duration', () => {
  const html = renderLiveRow(rowData('T-112', {
    planned: { start: '2026-08-17', due: '2026-08-21', durationMs: 4 * 60 * 60_000,
      coverage: 'full', source: 'estimated-effort-agent-active' }
  }));
  assert.match(html, /Planned 4h · agent-active estimate/);
  assert.match(html, /calendar-span-bar planned/);
  assert.doesNotMatch(html, /Unscheduled/);
});

test('approximate date positions undated work with a visible approximation marker', () => {
  const html = renderLiveRow(rowData('T-113', {
    approximateDate: { date: '2026-04-03', method: 'parent', confidence: 'medium' }
  }), 'done');
  assert.match(html, /calendar-span-bar approximate/);
  assert.match(html, /≈ [A-Z][a-z]{2} 3/);
  assert.doesNotMatch(html, /Unscheduled|No history/);
});

test('visible row keeps legacy provenance beside ratio and labels substituted actual', () => {
  const html = renderLiveRow(rowData('T-111', {
    planned: { start: null, due: null, durationMs: 40 * 60 * 60_000,
      coverage: 'duration-only', source: 'estimated-effort-legacy-human' },
    actual: { durationMs: 2 * 60 * 60_000, activeTimeCoverage: 'substituted',
      actualVsPlannedRatio: 0.05, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T11:00:00Z' }
  }), 'review');
  assert.match(html, /Planned [^<]+ · legacy-human estimate<\/span>\s*<span[^>]*>20× under plan/);
  assert.match(html, /Actual 2h · substituted \(not measured\)/);
});

test('visible row distinguishes aligned plan and receipt-less done work', () => {
  const aligned = renderLiveRow(rowData('T-120', {
    planned: { start: null, due: null, durationMs: 2 * 60 * 60_000,
      coverage: 'duration-only', source: 'aligned-from-actual' },
    actual: { durationMs: 2 * 60 * 60_000, activeTimeCoverage: 'substituted',
      actualVsPlannedRatio: null, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T11:00:00Z' }
  }), 'done');
  assert.match(aligned, /Planned 2h · aligned from actual \/ excluded from accuracy/);
  assert.match(aligned, /aligned from actual \/ excluded/);
  assert.doesNotMatch(aligned, /under plan|over plan/);

  const absent = renderLiveRow(rowData('T-121', { measurement: { status: 'no-measurement' } }), 'done');
  assert.match(absent, /no measurement/);
  assert.doesNotMatch(absent, /Actual \d/);
});

test('visible actual coverage follows measured value when present', () => {
  const html = renderLiveRow(rowData('T-122', {
    actual: { durationMs: 60 * 60_000, activeTimeCoverage: 'measured',
      actualVsPlannedRatio: null, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T10:00:00Z' }
  }), 'review');
  assert.match(html, /Actual 1h · measured active time/);
  assert.doesNotMatch(html, /substituted \(not measured\)/);
});

test('live row shows measured human and parked separately', () => {
  const html = renderLiveRow(rowData('T-123', {
    planned: { start: null, due: null, durationMs: 3_600_000, coverage: 'duration-only', source: 'estimated-effort-agent-active' },
    actual: { durationMs: 600_000, humanTimeMs: 600_000, parkedTimeMs: 6_000_000, leadTimeMs: 7_200_000,
      activeTimeCoverage: 'measured', actualVsPlannedRatio: 1 / 6, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T11:00:00Z' }
  }), 'review');
  assert.match(html, /Planned 1h · agent-active estimate/);
  assert.match(html, /Actual 10m · measured active time/);
  assert.match(html, /Human 10m/);
  assert.match(html, /Parked 1\.7h/);
});

test('done work with measured history is positioned by tier, never unscheduled', () => {
  const html = renderLiveRow(rowData('T-130', {
    history: { source: 'codex', tier: 'measured' },
    actual: { durationMs: 3_600_000, humanTimeMs: 0, parkedTimeMs: 0, leadTimeMs: 3_600_000,
      activeTimeCoverage: 'measured', actualVsPlannedRatio: null, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T10:00:00Z' }
  }), 'done');
  assert.match(html, /calendar-span-bar actual/);
  assert.match(html, /tier-measured/);
  assert.match(html, /tier measured · codex/);
  assert.doesNotMatch(html, /Unscheduled/);
  assert.doesNotMatch(html, /Not scheduled/);
});

test('done work with inferred history is positioned and excluded from accuracy', () => {
  const html = renderLiveRow(rowData('T-131', {
    history: { source: 'opencode', tier: 'inferred' },
    actual: { durationMs: 7_200_000, humanTimeMs: 0, parkedTimeMs: 0, leadTimeMs: 7_200_000,
      activeTimeCoverage: 'substituted', actualVsPlannedRatio: null, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T11:00:00Z' }
  }), 'done');
  assert.match(html, /calendar-span-bar actual/);
  assert.match(html, /tier-inferred/);
  assert.match(html, /tier inferred · opencode/);
  assert.doesNotMatch(html, /excluded from accuracy/);
  assert.doesNotMatch(html, /Unscheduled/);
  assert.doesNotMatch(html, /Not scheduled/);
});

test('done work with dates but no receipt renders declared tier, never unscheduled', () => {
  const html = renderLiveRow(rowData('T-132', {
    planned: { start: '2026-08-17', due: '2026-08-21', durationMs: 5 * 24 * 60 * 60_000,
      coverage: 'full', source: 'calendar-dates' }
  }), 'done');
  assert.match(html, /calendar-span-bar planned/);
  assert.match(html, /tier-declared/);
  assert.match(html, /tier declared/);
  assert.doesNotMatch(html, /excluded from accuracy/);
  assert.doesNotMatch(html, /Unscheduled/);
  assert.doesNotMatch(html, /Not scheduled/);
});

test('done and cancelled work without evidence show no history; archived without dates stays unscheduled', () => {
  for (const status of ['done', 'cancelled']) {
    const html = renderLiveRow(rowData('T-133'), status);
    assert.match(html, /No history/, status);
    assert.match(html, /no-history-label/, status);
    assert.match(html, /no history/, status);
    assert.doesNotMatch(html, /Unscheduled/, status);
    assert.doesNotMatch(html, /Not scheduled/, status);
  }
  // T-112 operator decision: archived work without dates is unscheduled.
  const archived = renderLiveRow(rowData('T-133'), 'archived');
  assert.match(archived, /Unscheduled/);
  assert.doesNotMatch(archived, /No history/);
});

test('synthetic-schedule approximate renders a duration span, not a point', () => {
  const html = renderLiveRow(rowData('T-138', {
    approximateDate: { date: '2026-04-06', method: 'synthetic-schedule', confidence: 'low', durationMs: 86400000 }
  }), 'done');
  assert.match(html, /calendar-span-bar approximate/);
  assert.match(html, /≈ [A-Z][a-z]{2} 6/);
  assert.doesNotMatch(html, /Unscheduled|No history/);
});

test('unscheduled is for work not started; started work without dates has its own lane', () => {
  for (const status of ['paused', 'backlog', 'ready']) {
    const html = renderLiveRow(rowData('T-134'), status);
    assert.match(html, /Unscheduled/, status);
    assert.doesNotMatch(html, /No history/, status);
  }
  for (const status of ['doing', 'in-progress', 'review']) {
    const html = renderLiveRow(rowData('T-134'), status);
    assert.match(html, /Started · no date/, status);
    assert.doesNotMatch(html, /Unscheduled/, status);
  }
});

test('substituted actuals keep their label and never borrow the measured style', () => {
  const html = renderLiveRow(rowData('T-135', {
    actual: { durationMs: 2 * 60 * 60_000, humanTimeMs: 0, parkedTimeMs: 0, leadTimeMs: 7_200_000,
      activeTimeCoverage: 'substituted', actualVsPlannedRatio: null, actualVsP90Ratio: null,
      startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T11:00:00Z' }
  }), 'review');
  assert.match(html, /substituted \(not measured\)/);
  assert.match(html, /tier substituted \(not measured\)/);
  assert.doesNotMatch(html, /tier-measured/);
});

test('predicted starts display distinctly from planned dates and never position', () => {
  const html = renderLiveRow(rowData('T-136', {
    planned: { start: null, due: null, durationMs: 4 * 60 * 60_000,
      coverage: 'duration-only', source: 'estimated-effort-agent-active' },
    predicted: { start: '2026-10-15', method: 'manual', confidence: 'low' }
  }), 'ready');
  assert.match(html, /Planned 4h · agent-active estimate/);
  assert.match(html, /predicted-chip/);
  assert.match(html, /Predicted .* · manual \(low\)/);
  assert.doesNotMatch(html, /not a commitment/);
  // In-timeline predictions get a dashed marker but the lane never moves.
  assert.match(html, /calendar-predicted-marker/);
  assert.match(html, /Unscheduled/);
});

test('predicted marker renders distinctly once the date falls inside the timeline', () => {  const html = renderLiveRow(rowData('T-137', {
    planned: { start: '2026-08-17', due: '2026-08-21', durationMs: 4 * 60 * 60_000,
      coverage: 'full', source: 'estimated-effort-agent-active' },
    predicted: { start: '2026-08-19', method: 'heuristic', confidence: 'medium' }
  }), 'ready');
  assert.match(html, /calendar-span-bar planned/);
  assert.match(html, /calendar-predicted-marker/);
  assert.match(html, /Predicted start 2026-08-19 \(heuristic, medium confidence\)/);
});

test('history view scans chronologically and filters by epic and tier', () => {
  const board = [
    { id: 'E-001', title: 'First epic', status: 'backlog', type: 'epic' },
    { id: 'T-140', title: 'Early done', status: 'done', type: 'feature', parent: 'E-001' },
    { id: 'T-141', title: 'Later done', status: 'done', type: 'feature', parent: 'E-001' },
    { id: 'E-002', title: 'Second epic', status: 'backlog', type: 'epic' },
    { id: 'T-142', title: 'Middle done', status: 'done', type: 'feature', parent: 'E-002' },
    { id: 'T-143', title: 'No evidence', status: 'done', type: 'feature' }
  ];
  const dataset = [
    rowData('E-001', {}),
    rowData('T-140', {
      history: { source: 'codex', tier: 'measured' },
      actual: { durationMs: 3_600_000, activeTimeCoverage: 'measured',
        startedAt: '2026-08-10T09:00:00Z', endedAt: '2026-08-10T10:00:00Z' }
    }),
    rowData('T-141', {
      history: { source: 'git', tier: 'inferred' },
      actual: { durationMs: 3_600_000, activeTimeCoverage: 'substituted',
        startedAt: '2026-08-20T09:00:00Z', endedAt: '2026-08-20T10:00:00Z' }
    }),
    rowData('E-002', {}),
    rowData('T-142', {
      planned: { start: '2026-08-15', due: '2026-08-16', durationMs: 2 * 24 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    }),
    rowData('T-143', {})
  ];

  const all = historyItems(board, dataset, { epic: 'all', tier: 'all' });
  const dated = all.filter(item => item.epoch !== null).map(item => item.id);
  assert.deepEqual(dated, ['T-140', 'T-142', 'T-141']);
  assert.equal(all.find(item => item.id === 'T-143').lane, 'no-history');

  const epicOnly = historyItems(board, dataset, { epic: 'E-002', tier: 'all' });
  assert.deepEqual(epicOnly.map(item => item.id), ['T-142', 'E-002']);

  const tierOnly = historyItems(board, dataset, { epic: 'all', tier: 'measured' });
  assert.deepEqual(tierOnly.map(item => item.id), ['T-140']);

  const noHistory = historyItems(board, dataset, { epic: 'all', tier: 'no-history' });
  assert.ok(noHistory.some(item => item.id === 'T-143'));
  assert.ok(!noHistory.some(item => item.id === 'T-140'));
});

// T-113 epic groups carry their own period: first related span to last done
// (or today when work is still open), ignoring halted members entirely.
function epicGroups(boardTasks, datasetTasks) {
  const noop = () => {};
  const element = { classList: { toggle: noop }, addEventListener: noop };
  const context = vm.createContext({
    console,
    window: { localStorage: { getItem: () => null, setItem: noop }, addEventListener: noop },
    document: { getElementById: () => element, querySelector: () => null, addEventListener: noop },
    __dataset: { tasks: datasetTasks, claimViolations: [] },
    __boardTasks: boardTasks
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'workspace-ui', 'workspaceV2.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'workspaceV2.js' });
  return vm.runInContext(`(() => {
    ganttDataset = __dataset;
    roadmapGroupMode = 'epic';
    return groupRoadmapTasksByEpic(normalizeRoadmapTasks(__boardTasks)).map(group => ({
      id: group.id, title: group.title, meta: group.meta, progress: group.progress,
      rangeStart: group.rangeStart ? group.rangeStart.toISOString().slice(0, 10) : null,
      rangeEnd: group.rangeEnd ? group.rangeEnd.toISOString().slice(0, 10) : null
    }));
  })()`, context);
}

test('epic group period spans related work, extends to today while open, skips halted', () => {
  const board = [
    { id: 'E-100', title: 'Epic', status: 'backlog', type: 'epic' },
    { id: 'T-200', title: 'First done', status: 'done', type: 'feature', parent: 'E-100' },
    { id: 'T-201', title: 'Last done', status: 'done', type: 'feature', parent: 'E-100' },
    { id: 'T-202', title: 'Still backlog', status: 'backlog', type: 'feature', parent: 'E-100' },
    { id: 'T-203', title: 'Paused with dates', status: 'paused', type: 'feature', parent: 'E-100' }
  ];
  const dataset = [
    rowData('E-100', {}),
    rowData('T-200', {
      planned: { start: '2026-03-03', due: '2026-03-04', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    }),
    rowData('T-201', {
      planned: { start: '2026-03-06', due: '2026-03-07', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    }),
    rowData('T-202', {}),
    rowData('T-203', {
      planned: { start: '2026-03-01', due: '2026-03-02', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    })
  ];
  const groups = epicGroups(board, dataset);
  const epic = groups.find(group => group.id === 'epic:E-100');
  const today = new Date().toISOString().slice(0, 10);
  // Paused Mar 1 must not pull the start; open backlog extends the end to today.
  assert.equal(epic.rangeStart, '2026-03-03');
  assert.equal(epic.rangeEnd, today);
  assert.match(epic.meta, /Mar 3/);
  assert.match(epic.meta, /5 tasks/);
});

test('epic group of only done work ends at the last span', () => {
  const board = [
    { id: 'E-101', title: 'Finished epic', status: 'done', type: 'epic' },
    { id: 'T-210', title: 'Done one', status: 'done', type: 'feature', parent: 'E-101' },
    { id: 'T-211', title: 'Done two', status: 'done', type: 'feature', parent: 'E-101' }
  ];
  const dataset = [
    rowData('E-101', {}),
    rowData('T-210', {
      planned: { start: '2026-03-03', due: '2026-03-04', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    }),
    rowData('T-211', {
      planned: { start: '2026-03-06', due: '2026-03-07', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    })
  ];
  const groups = epicGroups(board, dataset);
  const epic = groups.find(group => group.id === 'epic:E-101');
  assert.equal(epic.rangeStart, '2026-03-03');
  assert.equal(epic.rangeEnd, '2026-03-07');
  assert.match(epic.meta, /Mar 3 → Mar 7/);
});

test('epic period spanning years shows both years', () => {  const board = [
    { id: 'E-102', title: 'Cross-year epic', status: 'done', type: 'epic' },
    { id: 'T-220', title: 'Old done', status: 'done', type: 'feature', parent: 'E-102' },
    { id: 'T-221', title: 'New done', status: 'done', type: 'feature', parent: 'E-102' }
  ];
  const dataset = [
    rowData('E-102', {}),
    rowData('T-220', {
      planned: { start: '2025-09-15', due: '2025-09-16', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    }),
    rowData('T-221', {
      planned: { start: '2026-07-30', due: '2026-07-31', durationMs: 16 * 60 * 60_000,
        coverage: 'full', source: 'calendar-dates' }
    })
  ];
  const groups = epicGroups(board, dataset);
  const epic = groups.find(group => group.id === 'epic:E-102');
  assert.equal(epic.rangeStart, '2025-09-15');
  assert.equal(epic.rangeEnd, '2026-07-31');
  assert.match(epic.meta, /Sep 15 2025 → Jul 31 2026/);
});

test('cancelled work counts as concluded in group progress', () => {
  const board = [
    { id: 'E-103', title: 'Epic', status: 'backlog', type: 'epic' },
    { id: 'T-230', title: 'Done', status: 'done', type: 'feature', parent: 'E-103' },
    { id: 'T-231', title: 'Cancelled', status: 'cancelled', type: 'feature', parent: 'E-103' },
    { id: 'T-232', title: 'Paused', status: 'paused', type: 'feature', parent: 'E-103' }
  ];
  const dataset = [
    rowData('E-103', {}),
    rowData('T-230', {}),
    rowData('T-231', {}),
    rowData('T-232', {})
  ];
  const groups = epicGroups(board, dataset);
  const epic = groups.find(group => group.id === 'epic:E-103');
  // done + cancelled conclude; paused stays open and the epic container
  // is not work: 2/3.
  assert.equal(epic.progress, 2 / 3);
  assert.match(epic.meta, /67% complete/);
});

// T-116 review attempt 3: a historySpan positions the timeline bar, but the
// tier must survive into the bar label and hover text -- inferred history
// must never read as Measured/Actual.
test('history timeline bar keeps its tier: inferred is not labelled Actual/Measured', () => {
  const inferred = renderLiveRow(rowData('T-150', {
    historySpan: { startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T11:00:00Z', source: 'codex', confidence: 'low', tier: 'inferred' }
  }), 'done');
  assert.match(inferred, /calendar-span-bar actual/);
  assert.match(inferred, /Inferred session history \(low confidence; codex\)/);
  assert.doesNotMatch(inferred, /Measured session history/);
  assert.doesNotMatch(inferred, />Actual</);

  const measured = renderLiveRow(rowData('T-151', {
    historySpan: { startedAt: '2026-08-17T09:00:00Z', endedAt: '2026-08-17T10:00:00Z', source: 'opencode', confidence: 'high', tier: 'measured' }
  }), 'done');
  assert.match(measured, /calendar-span-bar actual/);
  assert.match(measured, /Measured session history \(high confidence; opencode\)/);
  assert.doesNotMatch(measured, /Inferred session history/);
});
