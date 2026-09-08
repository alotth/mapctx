const hasVsCodeApi = typeof acquireVsCodeApi === 'function';
const vscode = hasVsCodeApi
  ? acquireVsCodeApi()
  : { postMessage: (message) => console.info('workspaceV2 message', message) };

let board = {
  title: 'Workspace V2',
  columns: [],
  tasks: [],
  mode: 'unknown',
  workspaceTargets: [],
  projects: [],
  activeTargetId: null,
  activeProjectId: null
};

const VIEW_MODES = ['kanban', 'roadmap', 'execution'];
let activeView = normalizeView(window.localStorage?.getItem('mapctx:activeView'));
let railExpanded = window.localStorage?.getItem('mapctx:railExpanded') === 'true';
let projectFormMode = 'create';
let editingTargetId = null;
let editingTargetType = null;
let pendingExecutionTaskId = null;
let pendingExecutionRunId = null;

const ROADMAP_GROUP_MODES = ['wave', 'epic'];
let roadmapGroupMode = normalizeRoadmapGroupMode(window.localStorage?.getItem('mapctx:roadmapGroupMode'));
let roadmapAllCollapsed = window.localStorage?.getItem('mapctx:roadmapAllCollapsed') === 'true';
const roadmapCollapsedGroups = new Set();
const executionFilters = {
  from: window.localStorage?.getItem('mapctx:executionFrom') || '',
  to: window.localStorage?.getItem('mapctx:executionTo') || ''
};

const DEFAULT_STATUS_ORDER = ['backlog', 'ready-for-do', 'doing', 'review', 'done', 'paused'];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_PADDING_DAYS = 7;
// Shortest duration a task-bar in the duration lane is still drawn as: real
// durations here run from minutes to multi-day (measured ~28x shorter than
// authored estimatedEffort on this board -- see T-055 Decisions Taken), and a
// log scale sends anything at/under this to log(0). Below the floor we still
// show a real (labeled) minimum-width bar rather than let the scale decide.
const DURATION_LOG_FLOOR_MS = 60 * 1000;

let ganttDataset = null;
let ganttDatasetError = null;
let ganttDatasetLoading = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeStatus(status) {
  if (!status) {
    return '';
  }
  return String(status).trim().toLowerCase();
}

function normalizeRoadmapGroupMode(value) {
  return ROADMAP_GROUP_MODES.includes(value) ? value : 'wave';
}

function normalizeView(value) {
  return VIEW_MODES.includes(value) ? value : 'kanban';
}

function displayStatus(status) {
  const s = normalizeStatus(status);
  if (!s) {
    return 'Unknown';
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function taskDisplayTitle(task) {
  const title = String(task.title || '').trim();
  const id = String(task.id || '').trim();
  if (!id) {
    return title;
  }
  return title.replace(new RegExp(`^\\[${escapeRegExp(id)}\\]\\s*`), '');
}

function renderTaskLabel(task) {
  const id = task.id || '-';
  const title = taskDisplayTitle(task);
  return `[${escapeHtml(id)}] ${escapeHtml(title)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssToken(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function setView(view) {
  activeView = normalizeView(view);
  window.localStorage?.setItem('mapctx:activeView', activeView);
  document.getElementById('tab-kanban').classList.toggle('active', activeView === 'kanban');
  document.getElementById('tab-roadmap').classList.toggle('active', activeView === 'roadmap');
  document.getElementById('tab-execution').classList.toggle('active', activeView === 'execution');
  document.getElementById('kanban-view').classList.toggle('active', activeView === 'kanban');
  document.getElementById('roadmap-view').classList.toggle('active', activeView === 'roadmap');
  document.getElementById('execution-view').classList.toggle('active', activeView === 'execution');
}

function projectInitials(target) {
  const label = String(target.name || target.id || '?').trim();
  const words = label.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return label.slice(0, 2).toUpperCase() || '?';
}

function projectCountLabel(value) {
  const count = Number(value || 0);
  if (count > 99) {
    return '99+';
  }
  return String(count);
}

function projectAccent(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '';
}

function compactPath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'No folder linked';
  }
  const parts = text.split('/').filter(Boolean);
  if (parts.length <= 3) {
    return text;
  }
  return `…/${parts.slice(-3).join('/')}`;
}

function targetMetaLabel(target, type) {
  const count = Number(target.taskCount || 0);
  const taskLabel = `${count} task${count === 1 ? '' : 's'}`;
  const file = target.tasksFile || 'TASKS.md';
  if (target.hasTasksFile === false) {
    return `${type === 'organization' ? 'Organization' : 'Project'} · no TASKS.md`;
  }
  return `${type === 'organization' ? 'Organization' : 'Project'} · ${taskLabel} · ${file}`;
}

function applyRailState() {
  const shell = document.querySelector('.workspace-shell');
  const toggle = document.getElementById('rail-toggle');
  if (!shell || !toggle) {
    return;
  }
  shell.classList.toggle('rail-expanded', railExpanded);
  toggle.setAttribute('aria-pressed', railExpanded ? 'true' : 'false');
  toggle.setAttribute('aria-label', railExpanded ? 'Collapse sidebar' : 'Expand sidebar');
}

function setRailExpanded(value) {
  railExpanded = Boolean(value);
  window.localStorage?.setItem('mapctx:railExpanded', railExpanded ? 'true' : 'false');
  applyRailState();
}

function renderProjects() {
  const root = document.getElementById('project-rail-list');
  if (!root) {
    return;
  }

  const targets = board.workspaceTargets || board.projects || [];
  if (!targets.length) {
    root.innerHTML = '<div class="project-empty" aria-hidden="true"></div>';
    return;
  }

  root.innerHTML = targets.map((target) => {
    const targetId = target.targetId || target.id;
    const type = target.type === 'organization' ? 'organization' : 'project';
    const active = Boolean(target.active || targetId === board.activeTargetId || target.id === board.activeProjectId);
    const accent = projectAccent(target.accent);
    const style = accent ? ` style="--project-accent:${accent}"` : '';
    const icon = target.iconUrl
      ? `<img src="${escapeHtml(target.iconUrl)}" alt="" loading="lazy">`
      : `<span>${escapeHtml(projectInitials(target))}</span>`;
    const taskCount = projectCountLabel(target.taskCount);
    const kindLabel = type === 'organization' ? 'Org' : 'Project';
    const title = `${kindLabel}: ${target.name || target.id} - ${target.taskCount || 0} tasks`;
    const hierarchyClass = target.organizationId ? 'child' : 'root';
    const disabled = target.hasTasksFile === false;
    const selectAttr = disabled ? `data-target-disabled="${escapeHtml(targetId)}"` : `data-select-target="${escapeHtml(targetId)}"`;
    return `
      <div class="project-target-row ${type} ${hierarchyClass}">
        <button
          class="project-tile ${type} ${hierarchyClass} ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}"
          ${selectAttr}
          type="button"
          aria-label="${escapeHtml(title)}"
          aria-pressed="${active ? 'true' : 'false'}"
          title="${escapeHtml(title)}"${style}>
          <span class="project-avatar">${icon}</span>
          <span class="project-label">
            <span class="project-name">${escapeHtml(target.name || target.id)}</span>
            <span class="project-meta">${escapeHtml(targetMetaLabel(target, type))}</span>
            <span class="project-path">${escapeHtml(compactPath(target.path))}</span>
          </span>
          <span class="project-kind" aria-hidden="true">${type === 'organization' ? 'O' : 'P'}</span>
          <span class="project-count">${escapeHtml(taskCount)}</span>
        </button>
      </div>
    `;
  }).join('');
}

function renderKanban() {
  const root = document.getElementById('kanban-view');
  const useStatusGrouping = board.mode === 'v2-status' || board.mode === 'mixed';
  const effectiveColumns = useStatusGrouping ? groupColumnsFromStatus(board.tasks || []) : (board.columns || []);

  if (!effectiveColumns || effectiveColumns.length === 0) {
    root.innerHTML = '<p class="empty">No columns found.</p>';
    return;
  }

  const columnsHtml = effectiveColumns.map(col => {
      const cards = col.tasks.map(task => {
        const tags = task.tags && task.tags.length > 0 ? task.tags.map(t => `<span class="pill">${escapeHtml(t)}</span>`).join('') : '';
        const typePill = task.type ? `<span class="pill">${escapeHtml(task.type)}</span>` : '';
        const thread = task.thread && task.thread.exists ? renderThreadBadges(task.thread) : '';
        const summary = task.thread && task.thread.summaryPreview
          ? `<div class="thread-summary">${escapeHtml(task.thread.summaryPreview)}</div>`
          : '';
        const openDetail = task.detailPath
          ? `<button class="open-link" data-open-detail="${escapeHtml(task.id)}" type="button">Details</button>`
          : '';
      return `
        <article class="card ${task.thread && task.thread.exists ? 'has-thread' : ''}">
          <div class="card-title">${renderTaskLabel(task)}</div>
          <div class="card-meta">
            ${task.priority ? `<span class="pill">${escapeHtml(task.priority)}</span>` : ''}
            ${task.workload ? `<span class="pill">${escapeHtml(task.workload)}</span>` : ''}
            ${typePill}
            ${task.dueDate ? `<span class="pill">Due ${escapeHtml(task.dueDate)}</span>` : ''}
            ${tags}
            ${thread}
            ${openDetail}
          </div>
          ${summary}
        </article>
      `;
    }).join('');

    return `
      <section class="col">
        <div class="col-head">
          <h3>${escapeHtml(col.title)}</h3>
          <span class="count">${col.tasks.length}</span>
        </div>
        <div class="cards">${cards || '<p class="empty">No tasks</p>'}</div>
      </section>
    `;
  }).join('');

  root.innerHTML = `<div class="kanban-grid">${columnsHtml}</div>`;
}

async function loadGanttDataset() {
  if (ganttDatasetLoading || ganttDataset) return;
  ganttDatasetLoading = true;
  ganttDatasetError = null;
  if (hasVsCodeApi) {
    ganttDatasetLoading = false;
    ganttDatasetError = 'Planning Gantt runs in `mapctx workspace`; the VS Code webview keeps Kanban and task detail only.';
    renderRoadmap();
    return;
  }
  try {
    const response = await fetch('/api/gantt', { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    ganttDataset = await response.json();
  } catch (error) {
    ganttDatasetError = error instanceof Error ? error.message : String(error);
  } finally {
    ganttDatasetLoading = false;
    renderRoadmap();
  }
}

function renderRoadmap() {
  const root = document.getElementById('roadmap-view');
  const rawTasks = board.tasks || [];
  if (!rawTasks.length) {
    root.innerHTML = '<p class="empty">No tasks found for this roadmap.</p>';
    return;
  }

  if (!ganttDataset) {
    root.innerHTML = ganttDatasetError
      ? `<p class="modal-error">Could not load the Gantt dataset: ${escapeHtml(ganttDatasetError)}</p>`
      : '<p class="empty">Loading plan, forecast, and actuals&hellip;</p>';
    if (!ganttDatasetError) loadGanttDataset();
    return;
  }

  const tasks = normalizeRoadmapTasks(rawTasks);
  const calendarWindows = ganttDataset.calendarWindows || [];
  const groups = groupRoadmapTasks(tasks);
  syncRoadmapCollapsedGroups(groups);
  const summary = roadmapSummary(tasks, groups);
  const groupMetricLabel = roadmapGroupMode === 'epic' ? 'groups' : 'waves';
  const timelineLabel = roadmapGroupMode === 'epic' ? 'Epic / task' : 'Execution order';
  const maxDurationMs = maxDurationAcrossDataset(ganttDataset);

  root.innerHTML = `
    <div class="roadmap-layout">
      <section class="roadmap-hero" aria-label="Roadmap summary">
        <div class="roadmap-hero-copy">
          <span class="roadmap-kicker">Delivery plan</span>
          <strong>${escapeHtml(summary.finishLabel)}</strong>
          <span>${escapeHtml(summary.rangeLabel)}</span>
        </div>
        <div class="roadmap-metrics">
          <div><strong>${summary.total}</strong><span>tasks</span></div>
          <div><strong>${summary.withForecast}</strong><span>forecasted</span></div>
          <div><strong>${summary.withActual}</strong><span>with actuals</span></div>
          <div><strong>${summary.groups}</strong><span>${escapeHtml(groupMetricLabel)}</span></div>
        </div>
        ${renderRoadmapControls()}
        <div class="roadmap-legend" aria-label="Roadmap legend">
          <span><i class="legend-dot planned"></i> planned (authored, epic/root level)</span>
          <span><i class="legend-dot forecast"></i> forecast range (P50&ndash;P90)</span>
          <span><i class="legend-dot actual"></i> actual (measured)</span>
          <span><i class="legend-line"></i> today</span>
        </div>
      </section>
      ${renderForecastConfidenceBanner(ganttDataset)}
      <div class="roadmap-surface" tabindex="0" aria-label="Roadmap timeline">
        ${renderCalendarChannel(calendarWindows)}
        <div class="duration-lane-header">
          <span>${escapeHtml(timelineLabel)}</span>
          <span class="duration-lane-header-scale">Duration lane &mdash; shared log scale, floor &lt;1m</span>
        </div>
        ${renderDurationAxis(maxDurationMs)}
        ${renderRoadmapGroups(groups, maxDurationMs)}
      </div>
    </div>
  `;
}

function renderForecastConfidenceBanner(dataset) {
  if (!dataset.allForecastsArePriorFallback) return '';
  const prior = (dataset.tasks || []).find(task => task.forecast?.isPriorFallback)?.forecast;
  const priorLabel = prior
    ? ` (P50 ${formatDurationMs(prior.durationP50Ms)} / P90 ${formatDurationMs(prior.durationP90Ms)})`
    : '';
  return `
    <div class="gantt-banner gantt-banner-prior" role="note">
      No calibrated estimates yet &mdash; every forecast below derives from the same default prior
      ${escapeHtml(priorLabel)}, not measured data.
    </div>
  `;
}

function renderCalendarChannel(calendarWindows) {
  if (!calendarWindows.length) {
    return `
      <div class="calendar-channel calendar-channel-empty">
        <span>No delivery dates committed yet.</span>
        <span class="calendar-channel-hint">Planned dates appear here once an epic or root task is authored with a start/due date.</span>
      </div>
    `;
  }

  const items = calendarWindows.map((window) => ({
    ...window,
    startDate: parseDate(window.start),
    dueDate: parseDate(window.due)
  })).filter((window) => window.startDate && window.dueDate);
  const range = getDateRange(items.map((item) => ({ start: item.startDate, end: item.dueDate })));
  return `
    <div class="calendar-channel">
      <div class="timeline-header">
        <div class="timeline-label">Committed delivery dates</div>
        <div class="timeline-grid">${renderTicks(range)}</div>
      </div>
      ${items.map((item) => renderCalendarRow(item, range)).join('')}
    </div>
  `;
}

function renderCalendarRow(item, range) {
  const durationLabel = formatDurationMs(item.durationMs);
  return `
    <div class="calendar-row">
      <div class="calendar-row-label">
        <button class="task-label-main" data-open-detail="${escapeHtml(item.id)}" type="button">
          <span><span class="task-id">[${escapeHtml(item.id)}]</span> ${escapeHtml(item.title)}</span>
          <span class="task-status">${escapeHtml(item.kind)} / ${escapeHtml(item.coverage)} dates / ${escapeHtml(durationLabel)}</span>
        </button>
      </div>
      <div class="calendar-row-bar-area">
        ${renderGridLines(range)}
        ${renderTodayLine(range)}
        ${renderCalendarRangeBar(item, range)}
      </div>
    </div>
  `;
}

function renderRoadmapControls() {
  const modeButtons = ROADMAP_GROUP_MODES.map((mode) => {
    const active = roadmapGroupMode === mode;
    return `
      <button
        class="roadmap-control-button ${active ? 'active' : ''}"
        data-roadmap-group-mode="${escapeHtml(mode)}"
        type="button"
        aria-pressed="${active ? 'true' : 'false'}">
        ${escapeHtml(mode === 'epic' ? 'Epic' : 'Wave')}
      </button>
    `;
  }).join('');

  return `
    <div class="roadmap-controls" aria-label="Roadmap controls">
      <div class="roadmap-toggle" role="group" aria-label="Group roadmap by">
        ${modeButtons}
      </div>
      <div class="roadmap-action-row">
        <button class="roadmap-control-button" data-roadmap-collapse-all="false" type="button">Expand</button>
        <button class="roadmap-control-button" data-roadmap-collapse-all="true" type="button">Collapse</button>
      </div>
    </div>
  `;
}

function renderExecution() {
  const root = document.getElementById('execution-view');
  const tasks = board.tasks || [];
  const withThreads = tasks.filter(task => task.thread && task.thread.exists);
  const executionItems = getExecutionItems(withThreads);
  const filteredItems = executionItems.filter(matchesExecutionItemDateFilter);
  const filteredThreadCount = new Set(filteredItems.map(item => item.task.id)).size;
  const filteredRunCount = filteredItems.filter(item => item.run).length;
  const filteredCost = filteredItems.reduce((sum, item) => sum + (item.run?.costUsd || (!item.run ? item.task.thread?.costUsd || 0 : 0)), 0);

  const summaryHtml = `
    <div class="execution-toolbar">
      <label>
        <span>From</span>
        <input type="date" data-execution-date-filter="from" value="${escapeHtml(executionFilters.from)}">
      </label>
      <label>
        <span>To</span>
        <input type="date" data-execution-date-filter="to" value="${escapeHtml(executionFilters.to)}">
      </label>
      <button class="secondary-button execution-clear" data-clear-execution-filters type="button">Clear</button>
    </div>
    <div class="execution-summary">
      <div>
        <span class="metric-value">${filteredThreadCount}</span>
        <span class="metric-label">contexts</span>
      </div>
      <div>
        <span class="metric-value">${filteredRunCount}</span>
        <span class="metric-label">executions</span>
      </div>
      <div>
        <span class="metric-value">${formatCost(filteredCost)}</span>
        <span class="metric-label">tracked cost</span>
      </div>
    </div>
  `;

  if (withThreads.length === 0) {
    root.innerHTML = `${summaryHtml}<p class="empty">No portable task threads found in this repository yet.</p>`;
    return;
  }

  if (filteredItems.length === 0) {
    root.innerHTML = `${summaryHtml}<p class="empty">No executions match the selected dates.</p>`;
    return;
  }

  const rows = filteredItems
    .map(({ task, run }) => {
      const key = executionItemKey(task, run);
      const stamp = executionItemTimestamp({ task, run });
      const result = run?.result || (!run ? task.thread.summaryPreview : '');
      return `
      <article
        class="execution-row"
        data-open-detail="${escapeHtml(task.id)}"
        data-execution-task="${escapeHtml(task.id)}"
        data-execution-run="${escapeHtml(run?.runId || '')}"
        data-execution-key="${escapeHtml(key)}"
        tabindex="0"
        role="button">
        <div class="execution-main">
          <div class="execution-title">${renderTaskLabel(task)}</div>
          <div class="execution-meta">
            ${renderExecutionBadges(task.thread, run)}
            ${run?.runId ? `<span class="pill run-id">${escapeHtml(run.runId)}</span>` : ''}
          </div>
          ${result ? `<div class="thread-summary">${escapeHtml(result)}</div>` : ''}
        </div>
        <div class="execution-side">
          <span class="run-status">${escapeHtml(run?.status || task.thread.latestRunStatus || 'context')}</span>
          ${stamp ? `<span class="run-result">${escapeHtml(formatDateTime(stamp))}</span>` : ''}
        </div>
      </article>
    `;
    })
    .join('');

  root.innerHTML = `${summaryHtml}<div class="execution-list">${rows}</div>`;
  focusPendingExecutionTask();
}

function getExecutionItems(threadTasks) {
  const items = [];
  for (const task of threadTasks) {
    const runs = getThreadRuns(task.thread);
    if (!runs.length) {
      items.push({ task, run: null });
      continue;
    }
    for (const run of runs) {
      items.push({ task, run });
    }
  }

  return items.sort((a, b) => {
    const aTime = executionItemTimestamp(a)?.getTime() || 0;
    const bTime = executionItemTimestamp(b)?.getTime() || 0;
    if (aTime !== bTime) return bTime - aTime;
    return renderPlainTaskLabel(a.task).localeCompare(renderPlainTaskLabel(b.task));
  });
}

function getThreadRuns(thread) {
  return Array.isArray(thread?.runs)
    ? thread.runs.filter(run => run && run.runId)
    : [];
}

function executionItemKey(task, run) {
  return `${task.id || 'task'}::${run?.runId || 'context'}`;
}

function executionItemTimestamp(item) {
  return parseExecutionTimestamp(
    item.run?.startedAt ||
    item.run?.endedAt ||
    item.task.thread?.latestRunStartedAt ||
    item.task.thread?.latestRunEndedAt
  );
}

function renderThreadBadges(thread) {
  if (!thread || !thread.exists) {
    return '';
  }
  return [
    thread.latestRunStatus ? `<span class="pill thread-pill">${escapeHtml(thread.latestRunStatus)}</span>` : '<span class="pill thread-pill">thread</span>',
    thread.lastRuntime ? `<span class="pill">${escapeHtml(thread.lastRuntime)}</span>` : '',
    thread.lastAgentProfile ? `<span class="pill">${escapeHtml(thread.lastAgentProfile)}</span>` : ''
  ].join('');
}

function renderExecutionBadges(thread, run) {
  if (!thread || !thread.exists) {
    return '';
  }
  const stamp = executionItemTimestamp({ task: { thread }, run });
  return [
    run?.status || thread.latestRunStatus ? `<span class="pill thread-pill">${escapeHtml(run?.status || thread.latestRunStatus)}</span>` : '<span class="pill thread-pill">thread</span>',
    run?.runtime || thread.lastRuntime ? `<span class="pill">${escapeHtml(run?.runtime || thread.lastRuntime)}</span>` : '',
    run?.agentProfile || thread.lastAgentProfile ? `<span class="pill">${escapeHtml(run?.agentProfile || thread.lastAgentProfile)}</span>` : '',
    run?.model || thread.lastModel ? `<span class="pill">${escapeHtml(run?.model || thread.lastModel)}</span>` : '',
    run?.costUsd ? `<span class="pill">${formatCost(run.costUsd)}</span>` : '',
    stamp ? `<span class="pill">${escapeHtml(formatDateTime(stamp))}</span>` : ''
  ].join('');
}

function matchesExecutionItemDateFilter(item) {
  const stamp = executionItemTimestamp(item);
  if (!stamp) {
    return !executionFilters.from && !executionFilters.to;
  }
  const from = parseDate(executionFilters.from);
  const to = parseDate(executionFilters.to);
  if (from && stamp < from) return false;
  if (to && stamp > addDays(to, 1)) return false;
  return true;
}

function parseExecutionTimestamp(value) {
  if (!value) return null;
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) return null;
  return stamp;
}

function formatDateTime(value) {
  const stamp = parseExecutionTimestamp(value);
  if (!stamp) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(stamp);
}

function setExecutionDateFilter(key, value) {
  if (!['from', 'to'].includes(key)) return;
  executionFilters[key] = value || '';
  window.localStorage?.setItem(`mapctx:execution${key === 'from' ? 'From' : 'To'}`, executionFilters[key]);
  renderExecution();
}

function clearExecutionFilters() {
  executionFilters.from = '';
  executionFilters.to = '';
  window.localStorage?.setItem('mapctx:executionFrom', '');
  window.localStorage?.setItem('mapctx:executionTo', '');
  renderExecution();
}

function goToExecutionTask(taskId, runId = '') {
  pendingExecutionTaskId = taskId || null;
  pendingExecutionRunId = runId || null;
  const task = findTask(taskId);
  const run = runId ? getThreadRuns(task?.thread).find(item => item.runId === runId) : null;
  if (task && (executionFilters.from || executionFilters.to) && !matchesExecutionItemDateFilter({ task, run })) {
    executionFilters.from = '';
    executionFilters.to = '';
    window.localStorage?.setItem('mapctx:executionFrom', '');
    window.localStorage?.setItem('mapctx:executionTo', '');
  }
  closeDetailModal();
  setView('execution');
  renderExecution();
}

function focusPendingExecutionTask() {
  if (!pendingExecutionTaskId) return;
  const escapeSelector = window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape
    : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const key = pendingExecutionRunId
    ? `${pendingExecutionTaskId}::${pendingExecutionRunId}`
    : '';
  const row = key
    ? document.querySelector(`[data-execution-key="${escapeSelector(key)}"]`)
    : document.querySelector(`[data-execution-task="${escapeSelector(pendingExecutionTaskId)}"]`);
  if (!row) return;
  row.classList.add('highlight');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => row.classList.remove('highlight'), 1600);
  pendingExecutionTaskId = null;
  pendingExecutionRunId = null;
}

function formatCost(value) {
  const amount = Number(value || 0);
  if (!amount) {
    return '$0';
  }
  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function parseDate(value) {
  if (!value || value === 'null') {
    return null;
  }
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return null;
  }
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * ONE_DAY_MS);
}

function progressFromStatus(status) {
  const normalized = normalizeStatus(status);
  if (normalized === 'done') {
    return 1;
  }
  if (normalized === 'review') {
    return 0.85;
  }
  if (normalized === 'doing') {
    return 0.55;
  }
  if (normalized === 'paused') {
    return 0.35;
  }
  if (normalized === 'backlog') {
    return 0.15;
  }
  return 0.25;
}

function isTaskComplete(task) {
  return normalizeStatus(task.status) === 'done' || Boolean(task.completed);
}

function aggregateCompletionProgress(tasks) {
  const items = (tasks || []).filter(Boolean);
  if (!items.length) {
    return 0;
  }
  return items.filter(isTaskComplete).length / items.length;
}

function percentLabel(value) {
  const bounded = Math.min(Math.max(Number(value) || 0, 0), 1);
  return `${Math.round(bounded * 100)}%`;
}

function todayDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function dateDiffDays(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / ONE_DAY_MS));
}

function normalizeRoadmapTasks(list) {
  const source = Array.isArray(list) ? list : [];
  const datasetById = new Map((ganttDataset?.tasks || []).map((task) => [task.id, task]));
  const violations = ganttDataset?.claimViolations || [];
  return source.map((task) => {
    const data = datasetById.get(task.id) || {};
    return {
      ...task,
      wave: data.wave ?? null,
      planned: data.planned ?? null,
      forecast: data.forecast ?? null,
      actual: data.actual ?? null,
      blockedReasons: data.blockedReasons || [],
      collisions: data.collisions || [],
      claimViolations: violations.filter((item) => item.taskAId === task.id || item.taskBId === task.id),
      progress: progressFromStatus(task.status)
    };
  }).sort(compareRoadmapTasks);
}

function compareRoadmapTasks(a, b) {
  const waveDelta = (a.wave ?? Number.MAX_SAFE_INTEGER) - (b.wave ?? Number.MAX_SAFE_INTEGER);
  if (waveDelta) return waveDelta;
  const statusDelta = statusOrderIndex(a.status) - statusOrderIndex(b.status);
  if (statusDelta) return statusDelta;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function statusOrderIndex(status) {
  const index = DEFAULT_STATUS_ORDER.indexOf(normalizeStatus(status));
  return index === -1 ? DEFAULT_STATUS_ORDER.length : index;
}

function roadmapSummary(tasks, groups = []) {
  const total = tasks.length;
  const windows = ganttDataset?.calendarWindows || [];
  const maxDue = windows.map((item) => item.due).sort().slice(-1)[0];
  return {
    total,
    withForecast: tasks.filter((task) => task.forecast).length,
    withActual: tasks.filter((task) => task.actual).length,
    groups: groups.length,
    finishLabel: maxDue ? `Finish ${formatShortDate(parseDate(maxDue))}` : 'No delivery date',
    rangeLabel: windows.length ? `${windows.length} committed delivery window${windows.length === 1 ? '' : 's'}` : 'Calendar commitments absent'
  };
}

function getDateRange(tasks) {
  let min = tasks.reduce((acc, task) => (task.start < acc ? task.start : acc), tasks[0].start);
  let max = tasks.reduce((acc, task) => (task.end > acc ? task.end : acc), tasks[0].end);
  const today = todayDate();
  if (today < min) {
    min = today;
  }
  if (today > max) {
    max = today;
  }
  return {
    start: addDays(min, -RANGE_PADDING_DAYS),
    end: addDays(max, RANGE_PADDING_DAYS + 1)
  };
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

function getPosition(date, range) {
  const span = range.end.getTime() - range.start.getTime();
  if (span <= 0) {
    return 0;
  }
  return ((date.getTime() - range.start.getTime()) / span) * 100;
}

function getWidth(start, end, range) {
  const span = range.end.getTime() - range.start.getTime();
  if (span <= 0) {
    return 0;
  }
  return ((end.getTime() - start.getTime() + ONE_DAY_MS) / span) * 100;
}

function renderTicks(range) {
  const days = dateDiffDays(range.start, range.end);
  const secondaryTicks = days <= 70 ? buildDayTicks(range) : days <= 180 ? buildWeekTicks(range) : [];
  const monthTicks = buildMonthTicks(range);
  return `
    ${renderGridLines(range)}
    ${monthTicks.map((tick) => `
      <div class="timeline-grid-label timeline-grid-label-month" style="left:${tick.left}%">${escapeHtml(tick.label)}</div>
    `).join('')}
    ${secondaryTicks.map((tick) => `
      <div class="timeline-grid-label timeline-grid-label-day" style="left:${tick.left}%">${escapeHtml(tick.label)}</div>
    `).join('')}
    ${renderTodayLine(range, true)}
  `;
}

function buildMonthTicks(range) {
  const ticks = [];
  const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
  while (cursor <= range.end) {
    ticks.push({
      left: getPosition(cursor, range),
      label: new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(cursor)
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks;
}

function buildWeekTicks(range) {
  const ticks = [];
  const cursor = new Date(range.start.getTime());
  const dayOfWeek = cursor.getDay();
  const offset = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  cursor.setDate(cursor.getDate() + offset);
  while (cursor <= range.end) {
    ticks.push({
      left: getPosition(cursor, range),
      label: `W${getIsoWeek(cursor)}`
    });
    cursor.setDate(cursor.getDate() + 7);
  }
  return ticks;
}

function buildDayTicks(range) {
  const ticks = [];
  const days = dateDiffDays(range.start, range.end);
  const cursor = new Date(range.start.getTime());
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= range.end) {
    ticks.push({
      left: getPosition(cursor, range),
      label: days > 35 ? String(cursor.getDate()) : formatShortDate(cursor)
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return ticks;
}

function buildGridTicks(range) {
  const days = dateDiffDays(range.start, range.end);
  if (days <= 45) return buildDayTicks(range);
  if (days <= 180) return buildWeekTicks(range);
  return buildMonthTicks(range);
}

function renderGridLines(range) {
  return buildGridTicks(range).map((tick) => `
    <div class="timeline-grid-line" style="left:${tick.left}%"></div>
  `).join('');
}

function renderTodayLine(range, withBadge = false) {
  const today = todayDate();
  if (today < range.start || today > range.end) return '';
  const left = getPosition(today, range);
  return `
    <div class="today-line" style="left:${left}%">
      ${withBadge ? '<span class="today-badge">Today</span>' : ''}
    </div>
  `;
}

function getIsoWeek(date) {
  const temp = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = temp.getDay() || 7;
  temp.setDate(temp.getDate() + 4 - day);
  const yearStart = new Date(temp.getFullYear(), 0, 1);
  return Math.ceil((((temp.getTime() - yearStart.getTime()) / ONE_DAY_MS) + 1) / 7);
}

function renderRoadmapGroups(groups, maxDurationMs) {
  return groups.map((group) => {
    const collapsed = roadmapCollapsedGroups.has(group.id);
    const rows = collapsed ? '' : group.rows.map((entry, index) => renderRoadmapRow(entry, maxDurationMs, index)).join('');
    return `
      <section class="milestone-group ${collapsed ? 'collapsed' : 'expanded'}">
        <div class="milestone-header">
          <button
            class="milestone-label milestone-toggle"
            data-toggle-roadmap-group="${escapeHtml(group.id)}"
            type="button"
            aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="disclosure" aria-hidden="true">${collapsed ? '+' : '-'}</span>
            <span class="milestone-title-text">
              <span>${escapeHtml(group.title)}</span>
              <small>${escapeHtml(group.meta)}</small>
            </span>
          </button>
          <div class="milestone-summary-area">
            <span class="group-signal">${escapeHtml(group.signal)}</span>
          </div>
        </div>
        ${rows}
      </section>
    `;
  }).join('');
}

function groupRoadmapTasks(tasks) {
  if (roadmapGroupMode === 'epic') {
    return groupRoadmapTasksByEpic(tasks);
  }
  return groupRoadmapTasksByWave(tasks);
}

function groupRoadmapTasksByWave(tasks) {
  const grouped = new Map();
  for (const task of tasks) {
    if (!isDurationLaneTask(task)) continue;
    const wave = task.wave ?? 'blocked';
    grouped.set(wave, [...(grouped.get(wave) || []), task]);
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a === 'blocked' ? 1 : b === 'blocked' ? -1 : Number(a) - Number(b))
    .map(([wave, items]) => {
      const sortedItems = [...items].sort(compareRoadmapTasks);
      const progress = aggregateCompletionProgress(sortedItems);
      const blockedCount = sortedItems.filter(task => task.blockedReasons.length).length;
      const collisionCount = sortedItems.reduce((sum, task) => sum + task.collisions.length, 0);
      return {
        id: `wave:${wave}`,
        title: wave === 'blocked' ? 'Not scheduled' : `Wave ${wave}`,
        meta: `${sortedItems.length} task${sortedItems.length === 1 ? '' : 's'} · ${percentLabel(progress)} complete`,
        signal: [blockedCount ? `${blockedCount} blocked` : '', collisionCount ? `${collisionCount} serialized claim${collisionCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'No execution warnings',
        progress,
        taskCount: sortedItems.length,
        rows: sortedItems.map((task) => ({ task, depth: 0, node: null }))
      };
    });
}

function groupRoadmapTasksByEpic(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const epicFor = (task) => {
    let cursor = task;
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (isEpicTask(cursor)) return cursor;
      cursor = cursor.parent ? byId.get(cursor.parent) : null;
    }
    return null;
  };
  const grouped = new Map();
  for (const task of tasks) {
    if (!isDurationLaneTask(task)) continue;
    const epic = epicFor(task);
    const id = epic ? epic.id : 'ungrouped';
    grouped.set(id, { epic, tasks: [...(grouped.get(id)?.tasks || []), task] });
  }
  return [...grouped.entries()].map(([id, value]) => {
    const sorted = value.tasks.sort(compareRoadmapTasks);
    const blockedCount = sorted.filter(task => task.blockedReasons.length).length;
    const collisionCount = sorted.reduce((sum, task) => sum + task.collisions.length, 0);
    return {
      id: `epic:${id}`,
      title: value.epic ? `[${value.epic.id}] ${taskDisplayTitle(value.epic)}` : 'No epic',
      meta: `${sorted.length} task${sorted.length === 1 ? '' : 's'} · ${percentLabel(aggregateCompletionProgress(sorted))} complete`,
      signal: [blockedCount ? `${blockedCount} blocked` : '', collisionCount ? `${collisionCount} serialized claim${collisionCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'No execution warnings',
      rows: sorted.map(task => ({ task, depth: 0, node: null }))
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function isDurationLaneTask(task) {
  return Boolean(task.forecast || task.actual || task.blockedReasons.length || task.collisions.length || task.claimViolations.length);
}

function isEpicTask(task) {
  const type = String(task.type || '').trim().toLowerCase();
  return type === 'epic' || /^E-\d+/i.test(String(task.id || ''));
}

function renderRoadmapRow(entry, maxDurationMs, index) {
  const task = entry.task;
  const status = normalizeStatus(task.status) || 'unknown';
  const statusClass = cssToken(status);
  const blocked = task.blockedReasons.map(reason => reason.message).join(' · ');
  const collision = task.collisions.map(item => {
    const cause = [...item.domains, ...item.paths].join(', ');
    return `serialized with ${item.withTaskId}${cause ? ` (${cause})` : ''}`;
  }).join(' · ');
  const violations = task.claimViolations.map(item => `${item.kind}: ${item.path}`).join(' · ');
  const statusMeta = [displayStatus(task.status), task.wave ? `Wave ${task.wave}` : 'Not scheduled', blocked, collision, violations].filter(Boolean);
  const warningClass = task.blockedReasons.length || task.claimViolations.length ? 'has-warning' : '';

  return `
    <div class="task-row gantt-task-row ${index % 2 ? 'task-row-alt' : ''} status-${statusClass} ${warningClass}" style="--indent:${Number(entry.depth || 0) * 18}px">
      <div class="task-label">
        <span class="task-indent" aria-hidden="true"></span>
        <span class="task-state-mark status-${statusClass}" aria-hidden="true"></span>
        <button class="task-label-main" data-open-detail="${escapeHtml(task.id)}" type="button">
          <span><span class="task-id">[${escapeHtml(task.id)}]</span> ${escapeHtml(taskDisplayTitle(task))}</span>
          <span class="task-status">${escapeHtml(statusMeta.join(' / '))}</span>
        </button>
      </div>
      ${renderDurationCell(task, maxDurationMs)}
    </div>
  `;
}

function renderDurationCell(task, maxDurationMs) {
  const forecast = task.forecast;
  const actual = task.actual;
  if (!forecast && !actual) {
    return `<div class="duration-cell duration-cell-empty"><span>No duration data</span></div>`;
  }

  const p90Width = forecast ? durationScalePercent(forecast.durationP90Ms, maxDurationMs) : 0;
  const p50Width = forecast ? durationScalePercent(forecast.durationP50Ms, maxDurationMs) : 0;
  const actualWidth = actual ? durationScalePercent(actual.durationMs, maxDurationMs) : 0;
  const tooltip = forecast
    ? `Forecast ${formatDurationMs(forecast.durationP50Ms)} P50 to ${formatDurationMs(forecast.durationP90Ms)} P90\nConfidence: ${forecast.confidence}\nMethod: ${forecast.method}\nEstimator: ${forecast.estimatorVersion}\nCoverage: ${forecast.durationCoverage}`
    : 'No forecast available';
  const actualTooltip = actual
    ? `Actual ${formatDurationMs(actual.durationMs)}\nOutcome: ${actual.outcome}\n${actual.startedAt} -> ${actual.endedAt}`
    : '';

  return `
    <div class="duration-cell">
      <button class="duration-plot" data-open-detail="${escapeHtml(task.id)}" type="button" title="${escapeHtml(`${tooltip}${actualTooltip ? `\n\n${actualTooltip}` : ''}`)}" aria-label="${escapeHtml(durationAriaLabel(task))}">
        ${renderDurationGuides(maxDurationMs)}
        ${forecast ? `
          <span class="forecast-p90" style="width:${p90Width}%" aria-hidden="true"></span>
          <span class="forecast-p50" style="width:${p50Width}%" aria-hidden="true"></span>
          <span class="forecast-label">P50 ${escapeHtml(formatDurationMs(forecast.durationP50Ms))} / P90 ${escapeHtml(formatDurationMs(forecast.durationP90Ms))}</span>
        ` : '<span class="forecast-label forecast-label-empty">No forecast</span>'}
        ${actual ? `
          <span class="actual-bar ${actual.exceedsP90 ? 'exceeds-p90' : ''}" style="width:${actualWidth}%" aria-hidden="true"></span>
          <span class="actual-label">Actual ${escapeHtml(formatDurationMs(actual.durationMs))}</span>
        ` : ''}
      </button>
      <div class="duration-signals">
        ${renderProvenanceBadge(forecast)}
        ${renderVarianceBadge(task)}
      </div>
    </div>
  `;
}

function renderProvenanceBadge(forecast) {
  if (!forecast) return '<span class="signal-badge signal-muted">no forecast</span>';
  const coverageClass = `coverage-${cssToken(forecast.durationCoverage)}`;
  const label = forecast.isPriorFallback
    ? 'prior / uncalibrated'
    : `${forecast.confidence} confidence / ${forecast.durationCoverage}`;
  return `<span class="signal-badge ${coverageClass}" title="${escapeHtml(`${forecast.method} · ${forecast.estimatorVersion}`)}">${escapeHtml(label)}</span>`;
}

function renderVarianceBadge(task) {
  const actual = task.actual;
  if (!actual) return '<span class="signal-badge signal-muted">awaiting actual</span>';
  if (actual.actualVsPlannedRatio !== null) {
    const ratio = actual.actualVsPlannedRatio;
    const label = ratio > 1 ? `${formatRatio(ratio)} over plan` : `${formatRatio(1 / Math.max(ratio, 0.0001))} under plan`;
    return `<span class="signal-badge ${ratio > 1 ? 'signal-danger' : 'signal-good'}">${escapeHtml(label)}</span>`;
  }
  if (actual.actualVsP90Ratio !== null) {
    const ratio = actual.actualVsP90Ratio;
    const label = ratio > 1 ? `${formatRatio(ratio)} over P90` : `${formatRatio(ratio)} of P90`;
    return `<span class="signal-badge ${ratio > 1 ? 'signal-danger' : 'signal-good'}">${escapeHtml(label)}</span>`;
  }
  return '<span class="signal-badge signal-muted">actual, no baseline</span>';
}

function durationAriaLabel(task) {
  const parts = [`${task.id} ${taskDisplayTitle(task)}`];
  if (task.forecast) parts.push(`forecast P50 ${formatDurationMs(task.forecast.durationP50Ms)}, P90 ${formatDurationMs(task.forecast.durationP90Ms)}, ${task.forecast.confidence} confidence, ${task.forecast.durationCoverage} coverage`);
  if (task.actual) parts.push(`actual ${formatDurationMs(task.actual.durationMs)}`);
  if (task.blockedReasons.length) parts.push(task.blockedReasons.map(item => item.message).join(', '));
  return parts.join('. ');
}

function maxDurationAcrossDataset(dataset) {
  const values = (dataset.tasks || []).flatMap(task => [task.forecast?.durationP90Ms, task.actual?.durationMs].filter(Number.isFinite));
  return Math.max(DURATION_LOG_FLOOR_MS, ...values);
}

function durationScalePercent(value, maxDurationMs) {
  if (!Number.isFinite(value) || value <= 0) return 4;
  if (maxDurationMs <= DURATION_LOG_FLOOR_MS) return 100;
  const clamped = Math.max(DURATION_LOG_FLOOR_MS, Math.min(value, maxDurationMs));
  const normalized = (Math.log(clamped) - Math.log(DURATION_LOG_FLOOR_MS)) / (Math.log(maxDurationMs) - Math.log(DURATION_LOG_FLOOR_MS));
  return 4 + normalized * 96;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) return 'no data';
  if (value < DURATION_LOG_FLOOR_MS) return '<1m';
  const minutes = value / 60_000;
  if (minutes < 60) return `${formatCompactNumber(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${formatCompactNumber(hours)}h`;
  return `${formatCompactNumber(hours / 24)}d`;
}

function formatCompactNumber(value) {
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, '');
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}×`;
}

function durationTickValues(maxDurationMs) {
  const candidates = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 8 * 60 * 60_000, ONE_DAY_MS, 3 * ONE_DAY_MS, 7 * ONE_DAY_MS];
  const visible = candidates.filter(value => value <= maxDurationMs);
  if (!visible.includes(maxDurationMs)) visible.push(maxDurationMs);
  return [...new Set(visible)].sort((a, b) => a - b);
}

function renderDurationAxis(maxDurationMs) {
  return `
    <div class="duration-axis" aria-hidden="true">
      <span class="duration-axis-label">Task / execution truth</span>
      <div class="duration-axis-track">
        ${durationTickValues(maxDurationMs).map(value => `<span style="left:${durationScalePercent(value, maxDurationMs)}%">${escapeHtml(formatDurationMs(value))}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderDurationGuides(maxDurationMs) {
  return durationTickValues(maxDurationMs).map(value => `<i class="duration-guide" style="left:${durationScalePercent(value, maxDurationMs)}%"></i>`).join('');
}

function renderCalendarRangeBar(item, range) {
  const left = getPosition(item.startDate, range);
  const width = Math.max(getWidth(item.startDate, item.dueDate, range), 1.4);
  const title = `${item.title}\n${item.start} -> ${item.due}\n${formatDurationMs(item.durationMs)}\n${item.coverage} authored dates`;
  return `
    <div class="calendar-range-bar ${item.coverage === 'partial' ? 'partial' : ''}" style="left:${left}%;width:${width}%" title="${escapeHtml(title)}">
      <span class="group-range-bar-label">${escapeHtml(formatDurationMs(item.durationMs))}</span>
    </div>
  `;
}

function setRoadmapGroupMode(mode) {
  const normalized = normalizeRoadmapGroupMode(mode);
  if (roadmapGroupMode === normalized) return;
  roadmapGroupMode = normalized;
  window.localStorage?.setItem('mapctx:roadmapGroupMode', roadmapGroupMode);
  roadmapCollapsedGroups.clear();
  renderRoadmap();
}

function toggleRoadmapGroup(id) {
  if (!id) return;
  roadmapAllCollapsed = false;
  window.localStorage?.setItem('mapctx:roadmapAllCollapsed', 'false');
  if (roadmapCollapsedGroups.has(id)) {
    roadmapCollapsedGroups.delete(id);
  } else {
    roadmapCollapsedGroups.add(id);
  }
  renderRoadmap();
}

function setAllRoadmapGroupsCollapsed(collapsed) {
  const groups = groupRoadmapTasks(normalizeRoadmapTasks(board.tasks || []));
  roadmapAllCollapsed = Boolean(collapsed);
  window.localStorage?.setItem('mapctx:roadmapAllCollapsed', roadmapAllCollapsed ? 'true' : 'false');
  if (collapsed) {
    for (const group of groups) roadmapCollapsedGroups.add(group.id);
  } else {
    roadmapCollapsedGroups.clear();
  }
  renderRoadmap();
}

function syncRoadmapCollapsedGroups(groups) {
  if (!roadmapAllCollapsed) {
    return;
  }
  for (const group of groups) {
    roadmapCollapsedGroups.add(group.id);
  }
}

function renderAll() {
  document.getElementById('board-title').textContent = board.title || 'Workspace V2';
  const modeEl = document.getElementById('board-mode');
  modeEl.className = `mode-badge mode-${board.mode}`;
  modeEl.textContent = `Model: ${board.mode}`;
  document.getElementById('board-meta').textContent = `${board.tasks.length || 0} tasks`;
  renderTargetHeader();
  renderProjects();
  renderKanban();
  renderRoadmap();
  renderExecution();
}

function groupColumnsFromStatus(tasks) {
  const grouped = new Map();

  for (const task of tasks) {
    const key = normalizeStatus(task.status) || 'unknown';
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: `status:${key}`,
        title: displayStatus(key),
        tasks: []
      });
    }
    grouped.get(key).tasks.push(task);
  }

  const ordered = [];
  for (const status of DEFAULT_STATUS_ORDER) {
    if (grouped.has(status)) {
      ordered.push(grouped.get(status));
      grouped.delete(status);
    }
  }

  for (const [, value] of grouped.entries()) {
    ordered.push(value);
  }

  return ordered;
}

function allTasks() {
  return board.tasks || [];
}

function findTask(taskId) {
  return allTasks().find((task) => task.id === taskId);
}

function allTargets() {
  return board.workspaceTargets || board.projects || [];
}

function findTargetByTargetId(targetId) {
  return allTargets().find((target) => (target.targetId || target.id) === targetId);
}

function activeTarget() {
  return allTargets().find((target) => Boolean(target.active)) ||
    findTargetByTargetId(board.activeTargetId) ||
    allTargets().find((target) => target.id === board.activeProjectId) ||
    null;
}

function renderTargetHeader() {
  const editButton = document.getElementById('target-edit');
  if (!editButton) {
    return;
  }

  const target = activeTarget();
  if (!target) {
    editButton.hidden = true;
    editButton.removeAttribute('data-active-target');
    return;
  }

  const targetId = target.targetId || target.id;
  const typeLabel = target.type === 'organization' ? 'organization' : 'project';
  editButton.hidden = false;
  editButton.textContent = 'Edit';
  editButton.setAttribute('data-active-target', targetId);
  editButton.setAttribute('aria-label', `Edit selected ${typeLabel}: ${target.name || target.id}`);
  editButton.setAttribute('title', `Edit ${target.name || target.id}`);
}

function closeDetailModal() {
  const modal = document.getElementById('detail-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function closeProjectModal() {
  const modal = document.getElementById('project-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function closeModal() {
  closeDetailModal();
  closeProjectModal();
}

function openProjectModal() {
  projectFormMode = 'create';
  editingTargetId = null;
  editingTargetType = null;
  const modal = document.getElementById('project-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  configureProjectForm('create');
  hydrateProjectFormForCreate();
  setProjectFormMessage('');
  window.setTimeout(() => document.getElementById('project-path')?.focus(), 0);
}

function openEditTargetModal(targetId) {
  const target = findTargetByTargetId(targetId);
  if (!target) {
    setProjectFormMessage('Workspace target not found.', 'error');
    return;
  }

  projectFormMode = 'edit';
  editingTargetId = target.targetId || target.id;
  editingTargetType = target.type === 'organization' ? 'organization' : 'project';
  const modal = document.getElementById('project-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  configureProjectForm(editingTargetType);
  hydrateProjectFormForEdit(target);
  setProjectFormMessage('');
  window.setTimeout(() => {
    const focusId = editingTargetType === 'organization' ? 'project-org-name' : 'project-name';
    document.getElementById(focusId)?.focus();
  }, 0);
}

function setModalContent(html) {
  document.getElementById('detail-modal-content').innerHTML = html;
}

function configureProjectForm(mode) {
  const form = document.getElementById('project-form');
  const title = document.getElementById('project-modal-title');
  const submit = form?.querySelector('.primary-button');
  const projectPath = document.getElementById('project-path');
  if (!form || !(projectPath instanceof HTMLInputElement)) {
    return;
  }

  form.classList.toggle('mode-organization', mode === 'organization');
  form.classList.toggle('mode-project', mode === 'project' || mode === 'create');
  projectPath.required = mode !== 'organization';
  if (title) {
    title.textContent = mode === 'organization'
      ? 'Edit organization'
      : mode === 'project'
        ? 'Edit project'
        : 'Add organization / project';
  }
  if (submit) {
    submit.textContent = mode === 'create' ? 'Add to workspace' : 'Save changes';
  }
}

function clearProjectForm() {
  for (const id of ['project-org-name', 'project-org-id', 'project-org-path', 'project-name', 'project-id', 'project-path']) {
    const input = document.getElementById(id);
    if (input) input.value = '';
  }
}

function hydrateProjectFormForCreate() {
  clearProjectForm();
  const targets = allTargets();
  const active = targets.find((target) => target.active) || targets.find((target) => target.type === 'project') || targets[0];
  const organization = active?.type === 'organization'
    ? active
    : targets.find((target) => target.type === 'organization' && target.id === active?.organizationId);

  const orgName = document.getElementById('project-org-name');
  const orgId = document.getElementById('project-org-id');
  const orgPath = document.getElementById('project-org-path');
  const projectName = document.getElementById('project-name');
  const projectId = document.getElementById('project-id');
  const projectPath = document.getElementById('project-path');

  if (orgName && !orgName.value) orgName.value = organization?.name || '';
  if (orgId && !orgId.value) orgId.value = organization?.id || active?.organizationId || '';
  if (orgPath && !orgPath.value) orgPath.value = organization?.path || '';
  if (projectName) projectName.value = '';
  if (projectId) projectId.value = '';
  if (projectPath) projectPath.value = '';
}

function hydrateProjectFormForEdit(target) {
  clearProjectForm();
  const targets = allTargets();
  const organization = target.type === 'organization'
    ? target
    : targets.find((item) => item.type === 'organization' && item.id === target.organizationId);

  const orgName = document.getElementById('project-org-name');
  const orgId = document.getElementById('project-org-id');
  const orgPath = document.getElementById('project-org-path');
  const projectName = document.getElementById('project-name');
  const projectId = document.getElementById('project-id');
  const projectPath = document.getElementById('project-path');

  if (orgName) orgName.value = organization?.name || '';
  if (orgId) orgId.value = organization?.id || target.organizationId || '';
  if (orgPath) orgPath.value = organization?.path || '';

  if (target.type === 'project') {
    if (projectName) projectName.value = target.name || '';
    if (projectId) projectId.value = target.id || '';
    if (projectPath) projectPath.value = target.path || '';
  }
}

function setProjectFormMessage(message, kind = '') {
  const element = document.getElementById('project-form-message');
  if (!element) {
    return;
  }
  element.textContent = message;
  element.className = `form-message ${kind}`.trim();
}

async function openTaskDetail(taskId, selectedRunId = '') {
  const task = findTask(taskId);
  if (!task) {
    return;
  }

  const modal = document.getElementById('detail-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('detail-modal-title').textContent = renderPlainTaskLabel(task);
  setModalContent(renderIssueShell(task, '<p class="modal-empty">Loading detail file...</p>', selectedRunId));

  if (!task.detailPath) {
    setModalContent(renderIssueShell(task, '<p class="modal-empty">No detail file linked.</p>', selectedRunId));
    return;
  }

  try {
    const query = new URLSearchParams({ detailPath: task.detailPath });
    if (board.activeTargetId) {
      query.set('target', board.activeTargetId);
    }
    const response = await fetch(`/api/task-detail?${query.toString()}`);
    if (!response.ok) {
      throw new Error(await response.text() || 'Failed to load detail');
    }
    const payload = await response.json();
    setModalContent(renderIssueShell(task, renderDetailMarkdown(payload.path || task.detailPath, payload.content || '', task), selectedRunId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setModalContent(renderIssueShell(task, `<p class="modal-error">${escapeHtml(message)}</p>`, selectedRunId));
  }
}

function renderPlainTaskLabel(task) {
  return `[${task.id || '-'}] ${taskDisplayTitle(task)}`;
}

function renderIssueShell(task, bodyHtml, selectedRunId = '') {
  const title = taskDisplayTitle(task);
  const pills = [
    task.priority ? `<span class="issue-pill priority-${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span>` : '',
    task.workload ? `<span class="issue-pill">${escapeHtml(task.workload)}</span>` : '',
    task.type ? `<span class="issue-pill">${escapeHtml(task.type)}</span>` : '',
    task.dueDate ? `<span class="issue-pill">Due ${escapeHtml(task.dueDate)}</span>` : '',
    ...(task.tags || []).map((tag) => `<span class="issue-pill tag">${escapeHtml(tag)}</span>`)
  ].filter(Boolean).join('');

  return `
    <div class="issue-detail">
      <section class="issue-hero">
        <div class="issue-eyebrow">
          <span class="issue-id">${escapeHtml(task.id || '-')}</span>
          <span class="issue-state state-${escapeHtml(normalizeStatus(task.status) || 'unknown')}">${escapeHtml(displayStatus(task.status))}</span>
        </div>
        <h3>${escapeHtml(title)}</h3>
        <div class="issue-pill-row">${pills || '<span class="issue-pill muted">No labels</span>'}</div>
      </section>
      <div class="issue-grid">
        <main class="issue-main">${bodyHtml}</main>
        ${renderIssueSidebar(task)}
      </div>
      ${renderIssueExecutionContext(task, selectedRunId)}
    </div>
  `;
}

function renderIssueSidebar(task) {
  const rows = [
    ['Status', displayStatus(task.status)],
    ['Owner', renderOwner(task), true],
    ['Type', task.type],
    ['Priority', task.priority],
    ['Workload', task.workload],
    ['Parent', task.parent],
    ['Sub-issue', task.subIssueProgress],
    ['Start', task.startDate],
    ['Due', task.dueDate],
    ['Updated', task.updated],
    ['Completed', task.completed],
    ['Milestone', task.milestone],
    ['Detail', task.detailPath],
    ['Depends on', (task.dependsOn || []).join(', ')]
  ]
    .filter(([, value]) => value && value !== 'null')
    .map(([label, value, html]) => `
      <div class="issue-field">
        <span>${escapeHtml(label)}</span>
        <strong>${html ? value : escapeHtml(String(value))}</strong>
      </div>
    `)
    .join('');

  return `
    <aside class="issue-sidebar">
      <section class="issue-side-section">
        <h4>Properties</h4>
        ${rows || '<p class="modal-empty">No properties yet.</p>'}
      </section>
    </aside>
  `;
}

function renderIssueExecutionContext(task, selectedRunId = '') {
  if (!task.thread || !task.thread.exists) {
    return '';
  }

  const runs = getThreadRuns(task.thread);
  const runCount = runs.length;
  const contextMeta = [
    task.thread.status ? `<span class="run-chip">${escapeHtml(task.thread.status)}</span>` : '',
    runCount ? `<span class="run-chip">${runCount} execution${runCount === 1 ? '' : 's'}</span>` : '<span class="run-chip">context only</span>',
    task.thread.costUsd ? `<span class="run-chip">${formatCost(task.thread.costUsd)}</span>` : ''
  ].filter(Boolean).join('');
  const summary = task.thread.summaryMarkdown || task.thread.summaryPreview || '';
  const threadLog = task.thread.threadMarkdown || '';
  const runList = runs.length
    ? runs.map(run => renderThreadRunCard(task, run, selectedRunId)).join('')
    : renderThreadRunCard(task, null, selectedRunId);

  return `
    <section class="modal-section issue-execution-context">
      <div class="section-title-row">
        <h3>Execution context</h3>
        <span>${escapeHtml(task.id || '')}</span>
      </div>
      <div class="execution-context-head">
        <div class="agent-card">
          <span class="agent-avatar">${escapeHtml(agentInitial(task.thread.lastAgentProfile || task.thread.lastRuntime || 'AI'))}</span>
          <div>
            <strong>${escapeHtml(task.thread.lastAgentProfile || 'Agent')}</strong>
            <span>${escapeHtml([task.thread.lastRuntime, task.thread.lastModel].filter(Boolean).join(' · ') || 'runtime unknown')}</span>
          </div>
        </div>
        <div class="run-chip-row">${contextMeta}</div>
      </div>
      ${summary ? `
        <div class="thread-context-summary">
          <h4>Working summary</h4>
          <div class="modal-markdown">${renderThreadSummaryMarkdown(summary)}</div>
        </div>
      ` : ''}
      ${threadLog ? `
        <div class="thread-context-summary thread-context-log">
          <h4>Thread log</h4>
          <div class="modal-markdown">${renderThreadSummaryMarkdown(threadLog)}</div>
        </div>
      ` : ''}
      <div class="thread-run-list">
        ${runList}
      </div>
    </section>
  `;
}

function renderThreadRunCard(task, run, selectedRunId = '') {
  const selected = run?.runId && selectedRunId === run.runId;
  const stamp = executionItemTimestamp({ task, run });
  const meta = [
    run?.status ? `<span class="run-chip">${escapeHtml(run.status)}</span>` : '',
    run?.runtime ? `<span class="run-chip">${escapeHtml(run.runtime)}</span>` : '',
    run?.agentProfile ? `<span class="run-chip">${escapeHtml(run.agentProfile)}</span>` : '',
    run?.model ? `<span class="run-chip">${escapeHtml(run.model)}</span>` : '',
    run?.costUsd ? `<span class="run-chip">${formatCost(run.costUsd)}</span>` : '',
    formatTokenUsage(run?.tokenUsage)
  ].filter(Boolean).join('');
  const title = run?.runId || 'No run record yet';
  const body = run?.result || 'Portable execution context exists, but no run result was recorded.';

  return `
    <article class="thread-run-card ${selected ? 'selected' : ''}" data-thread-run-card="${escapeHtml(run?.runId || '')}">
      <div class="thread-run-avatar">${escapeHtml(agentInitial(run?.agentProfile || run?.runtime || task.thread.lastAgentProfile || 'AI'))}</div>
      <div class="thread-run-body">
        <div class="thread-run-header">
          <div>
            <strong>${escapeHtml(title)}</strong>
            ${stamp ? `<span>${escapeHtml(formatDateTime(stamp))}</span>` : ''}
          </div>
          <button
            class="secondary-button issue-thread-link compact"
            data-go-execution-task="${escapeHtml(task.id)}"
            data-go-execution-run="${escapeHtml(run?.runId || '')}"
            type="button">
            View execution
          </button>
        </div>
        ${meta ? `<div class="run-chip-row">${meta}</div>` : ''}
        <p>${escapeHtml(body)}</p>
      </div>
    </article>
  `;
}

function formatTokenUsage(tokenUsage) {
  if (!tokenUsage) return '';
  const parts = [
    typeof tokenUsage.input === 'number' ? `${tokenUsage.input} in` : '',
    typeof tokenUsage.output === 'number' ? `${tokenUsage.output} out` : '',
    typeof tokenUsage.total === 'number' ? `${tokenUsage.total} total` : ''
  ].filter(Boolean);
  return parts.length ? `<span class="run-chip">${escapeHtml(parts.join(' · '))}</span>` : '';
}

function renderThreadSummaryMarkdown(markdown) {
  const body = String(markdown || '').replace(/^#\s+.*(?:\r?\n)+/, '').trim();
  return renderSimpleMarkdown(body || markdown);
}

function renderOwner(task) {
  const assignees = (task.assignees || []).filter(Boolean);
  if (assignees.length) {
    return `<span class="owner-stack">${assignees.map((name) => `<span class="owner-chip">${escapeHtml(name)}</span>`).join('')}</span>`;
  }
  if (task.thread && task.thread.exists) {
    const name = task.thread.lastAgentProfile || task.thread.lastRuntime || 'agent';
    return `<span class="owner-stack"><span class="owner-chip agent">${escapeHtml(name)}</span></span>`;
  }
  return '<span class="owner-stack"><span class="owner-chip empty-owner">Unassigned</span></span>';
}

function agentInitial(value) {
  return String(value || 'AI').trim().slice(0, 2).toUpperCase() || 'AI';
}

function renderDetailMarkdown(detailPath, content, task = null) {
  const detail = parseDetailContent(content);
  const markdownSections = splitDetailMarkdownSections(detail.description);
  const acceptance = [
    ...extractChecklist(detail.fields.acceptance?.lines || []),
    ...extractSectionChecklist(markdownSections, 'acceptance')
  ];
  const steps = [
    ...extractChecklist(detail.fields.steps?.lines || []),
    ...extractSectionChecklist(markdownSections, 'steps')
  ];
  const noteBlocks = extractFencedMarkdownBlocks(content);
  const descriptionSections = markdownSections.filter(section => {
    if (isChecklistSection(section.title)) return false;
    if (task?.thread?.exists && isExecutionContextSection(section.title)) return false;
    return true;
  });
  const descriptionHtml = renderDescriptionSections(detail, descriptionSections, detailPath);

  return `
    ${descriptionHtml}
    ${renderChecklistSection('Acceptance', acceptance, 'acceptance')}
    ${renderChecklistSection('Steps', steps, 'steps')}
    ${renderNoteSections(noteBlocks)}
    <section class="modal-section issue-body-section">
      <details>
        <summary>Raw detail markdown</summary>
        <pre class="modal-pre">${escapeHtml(content)}</pre>
      </details>
    </section>
  `;
}

function parseDetailContent(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const fields = {};

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s{2}-\s+([A-Za-z][\w-]*):(?:\s*(.*))?$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = (match[2] || '').trimEnd();
    const childLines = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^\s{2}-\s+[A-Za-z][\w-]*:/.test(lines[cursor])) {
      childLines.push(lines[cursor]);
      cursor++;
    }

    fields[key] = {
      value: rawValue === '|'
        ? dedentDetailLines(childLines).join('\n').trim()
        : rawValue || dedentDetailLines(childLines).join('\n').trim(),
      lines: childLines
    };
    index = cursor - 1;
  }

  return {
    fields,
    summary: fields.summary?.value || '',
    description: fields.description?.value || ''
  };
}

function dedentDetailLines(lines) {
  return lines.map(line => line.replace(/^\s{6}/, '').replace(/^\s{4}/, ''));
}

function splitDetailMarkdownSections(markdown) {
  const normalized = String(markdown || '').trim();
  if (!normalized) {
    return [];
  }

  const sections = [];
  let current = { title: 'Description', lines: [] };
  for (const line of normalized.split(/\n/)) {
    const heading = line.match(/^#{2,4}\s+(.+)$/);
    if (heading) {
      if (current.lines.some(item => item.trim())) {
        sections.push(current);
      }
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some(item => item.trim())) {
    sections.push(current);
  }
  return sections;
}

function isChecklistSection(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return normalized === 'acceptance' || normalized === 'steps';
}

function isExecutionContextSection(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return normalized === 'execution context' || normalized === 'thread context';
}

function extractSectionChecklist(sections, targetTitle) {
  const section = sections.find(item => String(item.title || '').trim().toLowerCase() === targetTitle);
  return section ? extractChecklist(section.lines) : [];
}

function extractChecklist(lines) {
  const list = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  return list
    .map((line) => line.match(/^\s*-\s+\[([ x])\]\s+(.*)$/i))
    .filter(Boolean)
    .map((match) => ({ done: match[1].toLowerCase() === 'x', text: match[2].trim() }));
}

function renderDescriptionSections(detail, sections, detailPath) {
  const rendered = [];
  if (detail.summary) {
    rendered.push(`
      <section class="modal-section issue-body-section issue-summary-card">
        <div class="section-title-row">
          <h3>Summary</h3>
          <span>${escapeHtml(detailPath)}</span>
        </div>
        <p>${escapeHtml(detail.summary)}</p>
      </section>
    `);
  }

  if (!sections.length && detail.description) {
    rendered.push(renderTextSection('Description', detail.description, detailPath));
  } else {
    rendered.push(...sections.map((section, index) => renderTextSection(
      section.title,
      section.lines.join('\n').trim(),
      index === 0 && !detail.summary ? detailPath : ''
    )));
  }

  if (!rendered.length) {
    rendered.push(`
      <section class="modal-section issue-body-section">
        <div class="section-title-row">
          <h3>Description</h3>
          <span>${escapeHtml(detailPath)}</span>
        </div>
        <p class="modal-empty">No description block found.</p>
      </section>
    `);
  }

  return rendered.join('');
}

function renderTextSection(title, markdown, sideLabel = '') {
  return `
    <section class="modal-section issue-body-section issue-copy-section">
      <div class="section-title-row">
        <h3>${escapeHtml(title || 'Description')}</h3>
        ${sideLabel ? `<span>${escapeHtml(sideLabel)}</span>` : ''}
      </div>
      <div class="modal-markdown">${renderSimpleMarkdown(markdown)}</div>
    </section>
  `;
}

function renderChecklistSection(title, items, tone) {
  if (!items.length) {
    return '';
  }
  const done = items.filter(item => item.done).length;
  return `
    <section class="modal-section issue-body-section issue-check-section ${escapeHtml(tone)}">
      <div class="section-title-row">
        <h3>${escapeHtml(title)}</h3>
        <span>${done}/${items.length} done</span>
      </div>
      <ul class="issue-checklist">
        ${items.map(item => `
          <li class="${item.done ? 'done' : ''}">
            <span class="check-dot">${item.done ? '✓' : ''}</span>
            <span>${escapeHtml(item.text)}</span>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
}

function extractFencedMarkdownBlocks(content) {
  const blocks = [];
  const pattern = /^\s*```[A-Za-z0-9_-]*\s*\n([\s\S]*?)^\s*```\s*$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const block = dedentDetailLines(match[1].split(/\r?\n/)).join('\n').trim();
    if (block) {
      blocks.push(block);
    }
  }
  return blocks;
}

function renderNoteSections(blocks) {
  if (!blocks.length) {
    return '';
  }
  return blocks.map((block, index) => `
    <section class="modal-section issue-body-section issue-note-section">
      <div class="section-title-row">
        <h3>${index === 0 ? 'Notes' : `Notes ${index + 1}`}</h3>
      </div>
      <div class="modal-markdown">${renderSimpleMarkdown(block)}</div>
    </section>
  `).join('');
}

function renderSimpleMarkdown(markdown) {
  return escapeHtml(markdown)
    .replace(/^### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^## (.*)$/gm, '<h3>$1</h3>')
    .replace(/^- \[ \] (.*)$/gm, '<div class="modal-check">[ ] $1</div>')
    .replace(/^- \[x\] (.*)$/gim, '<div class="modal-check done">[x] $1</div>')
    .replace(/^- (?!\[)(.*)$/gm, '<div class="modal-bullet">• $1</div>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<h|<div)(.+)$/gm, '<p>$1</p>');
}

async function submitProjectForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const data = new FormData(form);
  const payload = {
    targetId: editingTargetId,
    targetType: editingTargetType,
    organizationName: String(data.get('organizationName') || '').trim(),
    organizationId: String(data.get('organizationId') || '').trim(),
    organizationPath: String(data.get('organizationPath') || '').trim(),
    projectName: String(data.get('projectName') || '').trim(),
    projectId: String(data.get('projectId') || '').trim(),
    projectPath: String(data.get('projectPath') || '').trim()
  };

  if (projectFormMode !== 'edit' || editingTargetType === 'project') {
    if (!payload.projectPath) {
      setProjectFormMessage('Project folder is required.', 'error');
      return;
    }
  }

  if (projectFormMode === 'edit' && !payload.targetId) {
    setProjectFormMessage('Target id is required for editing.', 'error');
    return;
  }

  if (editingTargetType === 'organization' && !payload.organizationId) {
    setProjectFormMessage('Organization id is required.', 'error');
    return;
  }

  if ((projectFormMode === 'create' || editingTargetType === 'project') && !payload.projectPath) {
    setProjectFormMessage('Project folder is required.', 'error');
    return;
  }

  setProjectFormMessage(projectFormMode === 'edit' ? 'Saving workspace target...' : 'Adding project to workspace...', 'pending');
  if (hasVsCodeApi) {
    vscode.postMessage({ type: projectFormMode === 'edit' ? 'updateWorkspaceTarget' : 'addProjectFromModal', ...payload });
    setProjectFormMessage('Request sent to the extension runtime.', 'success');
    return;
  }

  try {
    const response = await fetch('/api/workspace-targets', {
      method: projectFormMode === 'edit' ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(await response.text() || 'Failed to add project');
    }
    const result = await response.json();
    const url = new URL(window.location.href);
    const nextTargetId = projectFormMode === 'edit' && editingTargetType === 'organization' && board.activeTargetId !== editingTargetId
      ? board.activeTargetId
      : result.targetId;
    if (nextTargetId) {
      url.searchParams.set('target', nextTargetId);
    }
    setProjectFormMessage(projectFormMode === 'edit' ? 'Changes saved. Reloading workspace...' : 'Project added. Reloading workspace...', 'success');
    window.setTimeout(() => window.location.assign(url.toString()), 250);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setProjectFormMessage(message, 'error');
  }
}

async function browseFolderIntoInput(inputId, prompt) {
  const input = document.getElementById(inputId);
  if (!(input instanceof HTMLInputElement)) {
    setProjectFormMessage('Folder input not found.', 'error');
    return;
  }

  setProjectFormMessage('Opening folder picker...', 'pending');
  if (hasVsCodeApi) {
    vscode.postMessage({ type: 'browseFolder', inputId, prompt });
    return;
  }

  try {
    const response = await fetch('/api/browse-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        defaultPath: input.value || input.placeholder || ''
      })
    });
    if (!response.ok) {
      throw new Error(await response.text() || 'Failed to open folder picker');
    }
    const result = await response.json();
    if (result.canceled) {
      setProjectFormMessage('Folder selection canceled.', 'pending');
      return;
    }
    if (!result.path) {
      throw new Error('Folder picker returned no path');
    }
    input.value = result.path;
    setProjectFormMessage('Folder selected.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setProjectFormMessage(message, 'error');
  }
}

window.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.closest('#rail-toggle')) {
    setRailExpanded(!railExpanded);
    return;
  }
  const activeEditTrigger = target.closest('#target-edit');
  if (activeEditTrigger) {
    const currentTarget = activeTarget();
    const editTargetId = activeEditTrigger.getAttribute('data-active-target') ||
      (currentTarget ? currentTarget.targetId || currentTarget.id : null);
    if (editTargetId) {
      openEditTargetModal(editTargetId);
    }
    return;
  }
  if (target.closest('[data-target-disabled]')) {
    setRailExpanded(true);
    return;
  }
  const targetTrigger = target.closest('[data-select-target]');
  const targetId = targetTrigger ? targetTrigger.getAttribute('data-select-target') : null;
  if (targetId) {
    board.activeTargetId = targetId;
    board.activeProjectId = targetId;
    board.workspaceTargets = (board.workspaceTargets || board.projects || []).map((item) => ({
      ...item,
      active: (item.targetId || item.id) === targetId
    }));
    board.projects = board.workspaceTargets;
    renderTargetHeader();
    renderProjects();
    if (!hasVsCodeApi) {
      const url = new URL(window.location.href);
      url.searchParams.set('target', targetId);
      window.location.assign(url.toString());
      return;
    }
    vscode.postMessage({ type: 'selectTarget', targetId });
    return;
  }
  if (target.closest('#project-add')) {
    openProjectModal();
    return;
  }
  const browseTrigger = target.closest('[data-browse-folder]');
  if (browseTrigger) {
    browseFolderIntoInput(
      browseTrigger.getAttribute('data-browse-folder'),
      browseTrigger.getAttribute('data-browse-prompt') || 'Choose folder'
    );
    return;
  }
  const roadmapModeTrigger = target.closest('[data-roadmap-group-mode]');
  if (roadmapModeTrigger) {
    setRoadmapGroupMode(roadmapModeTrigger.getAttribute('data-roadmap-group-mode'));
    return;
  }
  const roadmapCollapseTrigger = target.closest('[data-roadmap-collapse-all]');
  if (roadmapCollapseTrigger) {
    setAllRoadmapGroupsCollapsed(roadmapCollapseTrigger.getAttribute('data-roadmap-collapse-all') === 'true');
    return;
  }
  const roadmapGroupTrigger = target.closest('[data-toggle-roadmap-group]');
  if (roadmapGroupTrigger) {
    toggleRoadmapGroup(roadmapGroupTrigger.getAttribute('data-toggle-roadmap-group'));
    return;
  }
  const executionTrigger = target.closest('[data-go-execution-task]');
  if (executionTrigger) {
    goToExecutionTask(
      executionTrigger.getAttribute('data-go-execution-task'),
      executionTrigger.getAttribute('data-go-execution-run') || ''
    );
    return;
  }
  if (target.closest('[data-clear-execution-filters]')) {
    clearExecutionFilters();
    return;
  }
  const detailTrigger = target.closest('[data-open-detail]');
  const detailId = detailTrigger ? detailTrigger.getAttribute('data-open-detail') : null;
  if (detailId) {
    openTaskDetail(detailId, detailTrigger.getAttribute('data-execution-run') || '');
    return;
  }
  const closeTrigger = target.closest("[data-close-modal='detail']");
  if (closeTrigger) {
    closeDetailModal();
    return;
  }
  const projectCloseTrigger = target.closest("[data-close-modal='project']");
  if (projectCloseTrigger) {
    closeProjectModal();
    return;
  }
  const taskId = target.getAttribute('data-open-task');
  if (taskId) {
    vscode.postMessage({ type: 'openTask', taskId });
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const detailTrigger = target.closest('[data-open-detail]');
    const detailId = detailTrigger ? detailTrigger.getAttribute('data-open-detail') : null;
    if (detailId) {
      event.preventDefault();
      openTaskDetail(detailId, detailTrigger.getAttribute('data-execution-run') || '');
    }
  }
});

document.getElementById('tab-kanban').addEventListener('click', () => setView('kanban'));
document.getElementById('tab-roadmap').addEventListener('click', () => setView('roadmap'));
document.getElementById('tab-execution').addEventListener('click', () => setView('execution'));
document.getElementById('project-form')?.addEventListener('submit', submitProjectForm);

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const key = target.getAttribute('data-execution-date-filter');
  if (key) {
    setExecutionDateFilter(key, target.value);
  }
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'updateWorkspaceV2') {
    board = {
      title: message.title,
      columns: message.columns || [],
      tasks: message.tasks || [],
      mode: message.mode || 'unknown',
      workspaceTargets: message.workspaceTargets || message.projects || [],
      projects: message.projects || [],
      activeTargetId: message.activeTargetId || message.activeProjectId || null,
      activeProjectId: message.activeProjectId || null
    };
    ganttDataset = null;
    ganttDatasetError = null;
    ganttDatasetLoading = false;
    renderAll();
  }
  if (message.type === 'ganttDataset') {
    ganttDataset = message.dataset || null;
    ganttDatasetError = null;
    ganttDatasetLoading = false;
    renderRoadmap();
  }
  if (message.type === 'ganttDatasetError') {
    ganttDatasetError = message.message || 'Could not build Gantt dataset';
    ganttDatasetLoading = false;
    renderRoadmap();
  }
  if (message.type === 'selectedFolder' && message.inputId && message.path) {
    const input = document.getElementById(message.inputId);
    if (input) input.value = message.path;
    setProjectFormMessage('Folder selected. Review the fields and add it.', 'success');
  }
  if (message.type === 'selectedProjectFolder' && message.projectPath) {
    const input = document.getElementById('project-path');
    if (input) input.value = message.projectPath;
    setProjectFormMessage('Folder selected. Review the fields and add it.', 'success');
  }
  if (message.type === 'folderSelectionCanceled') {
    setProjectFormMessage('Folder selection canceled.', 'pending');
  }
});

applyRailState();

if (window.MAPCTX_BOOTSTRAP) {
  board = window.MAPCTX_BOOTSTRAP;
  renderAll();
}

setView(activeView);
