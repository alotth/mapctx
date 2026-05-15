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
let activeView = 'kanban';
let railExpanded = window.localStorage?.getItem('mapctx:railExpanded') === 'true';
let projectFormMode = 'create';
let editingTargetId = null;
let editingTargetType = null;

const DEFAULT_STATUS_ORDER = ['backlog', 'ready-for-do', 'doing', 'review', 'done', 'paused'];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_DAYS = 5;
const RANGE_PADDING_DAYS = 7;

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

function setView(view) {
  activeView = view;
  document.getElementById('tab-kanban').classList.toggle('active', view === 'kanban');
  document.getElementById('tab-roadmap').classList.toggle('active', view === 'roadmap');
  document.getElementById('tab-execution').classList.toggle('active', view === 'execution');
  document.getElementById('kanban-view').classList.toggle('active', view === 'kanban');
  document.getElementById('roadmap-view').classList.toggle('active', view === 'roadmap');
  document.getElementById('execution-view').classList.toggle('active', view === 'execution');
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
        <button class="project-edit" type="button" data-edit-target="${escapeHtml(targetId)}" aria-label="Edit ${escapeHtml(target.name || target.id)}" title="Edit ${escapeHtml(target.name || target.id)}">Edit</button>
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

function renderRoadmap() {
  const root = document.getElementById('roadmap-view');
  const tasks = normalizeRoadmapTasks(board.tasks || []);
  if (!tasks.length) {
    root.innerHTML = '<p class="empty">No tasks with usable roadmap dates found.</p>';
    return;
  }

  const range = getDateRange(tasks);

  root.innerHTML = `
    <div class="roadmap-surface" tabindex="0" aria-label="Roadmap timeline">
      <div class="timeline">
        <div class="timeline-header">
          <div class="timeline-label">Task</div>
          <div class="timeline-grid">${renderTicks(range)}</div>
        </div>
        ${renderRoadmapGroups(tasks, range)}
      </div>
    </div>
  `;
}

function renderExecution() {
  const root = document.getElementById('execution-view');
  const tasks = board.tasks || [];
  const withThreads = tasks.filter(task => task.thread && task.thread.exists);

  const summaryHtml = `
    <div class="execution-summary">
      <div>
        <span class="metric-value">${withThreads.length}</span>
        <span class="metric-label">threads</span>
      </div>
      <div>
        <span class="metric-value">${tasks.reduce((sum, task) => sum + (task.thread?.runCount || 0), 0)}</span>
        <span class="metric-label">runs</span>
      </div>
      <div>
        <span class="metric-value">${formatCost(tasks.reduce((sum, task) => sum + (task.thread?.costUsd || 0), 0))}</span>
        <span class="metric-label">tracked cost</span>
      </div>
    </div>
  `;

  if (withThreads.length === 0) {
    root.innerHTML = `${summaryHtml}<p class="empty">No portable task threads found in this repository yet.</p>`;
    return;
  }

  const rows = withThreads
    .map(task => `
      <article class="execution-row">
        <div class="execution-main">
          <div class="execution-title">${renderTaskLabel(task)}</div>
          <div class="execution-meta">
            ${renderThreadBadges(task.thread)}
            ${task.thread.lastModel ? `<span class="pill">${escapeHtml(task.thread.lastModel)}</span>` : ''}
            ${task.thread.runCount ? `<span class="pill">${task.thread.runCount} run${task.thread.runCount === 1 ? '' : 's'}</span>` : ''}
            ${task.thread.costUsd ? `<span class="pill">${formatCost(task.thread.costUsd)}</span>` : ''}
          </div>
          ${task.thread.summaryPreview ? `<div class="thread-summary">${escapeHtml(task.thread.summaryPreview)}</div>` : ''}
        </div>
        <div class="execution-side">
          <span class="run-status">${escapeHtml(task.thread.latestRunStatus || 'thread')}</span>
          ${task.thread.latestRunResult ? `<span class="run-result">${escapeHtml(task.thread.latestRunResult)}</span>` : ''}
        </div>
      </article>
    `)
    .join('');

  root.innerHTML = `${summaryHtml}<div class="execution-list">${rows}</div>`;
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

function normalizeRoadmapTasks(list) {
  return list
    .map((task) => {
      let start = parseDate(task.startDate);
      const due = parseDate(task.dueDate);
      const completed = parseDate(task.completed);
      const updated = parseDate(task.updated);
      const end = completed || due || updated;
      if (!start && !end) {
        return null;
      }
      if (!start && end) {
        start = addDays(end, -DEFAULT_DURATION_DAYS);
      }
      if (!start) {
        return null;
      }
      const safeEnd = end || addDays(start, DEFAULT_DURATION_DAYS);
      if (start.getTime() > safeEnd.getTime()) {
        start = addDays(safeEnd, -DEFAULT_DURATION_DAYS);
      }
      return {
        ...task,
        start,
        end: safeEnd,
        progress: progressFromStatus(task.status)
      };
    })
    .filter(Boolean);
}

function getDateRange(tasks) {
  let min = tasks.reduce((acc, task) => (task.start < acc ? task.start : acc), tasks[0].start);
  let max = tasks.reduce((acc, task) => (task.end > acc ? task.end : acc), tasks[0].end);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
  const ticks = [];
  const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
  while (cursor <= range.end) {
    ticks.push({
      left: getPosition(cursor, range),
      label: new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(cursor)
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks.map((tick) => `
    <div class="timeline-grid-line" style="left:${tick.left}%"></div>
    <div class="timeline-grid-label" style="left:${tick.left}%">${escapeHtml(tick.label)}</div>
  `).join('');
}

function renderRoadmapGroups(tasks, range) {
  const groups = groupRoadmapTasks(tasks);
  return groups.map((group) => {
    const rows = group.items.map((task, index) => {
      const left = getPosition(task.start, range);
      const width = Math.max(getWidth(task.start, task.end, range), 1.4);
      const title = `${taskDisplayTitle(task)} (${task.startDate || '?'} -> ${task.dueDate || task.completed || task.updated || '?'})`;
      const tag = [task.status, task.milestone].filter(Boolean).join(' / ');
      return `
        <div class="task-row ${index % 2 ? 'task-row-alt' : ''}">
          <button class="task-label" data-open-detail="${escapeHtml(task.id)}" type="button">
            <span><span class="task-id">[${escapeHtml(task.id)}]</span> ${escapeHtml(taskDisplayTitle(task))}</span>
            <span class="task-status">${escapeHtml(tag || task.type || '')}</span>
          </button>
          <div class="task-bar-area">
            <button class="task-bar" data-open-detail="${escapeHtml(task.id)}" style="left:${left}%;width:${width}%" title="${escapeHtml(title)}" type="button">
              <span class="task-bar-progress" style="width:${Math.round(task.progress * 100)}%"></span>
            </button>
          </div>
        </div>
      `;
    }).join('');
    return `
      <section class="milestone-group">
        <div class="milestone-header">
          <div class="milestone-label">${escapeHtml(group.title)}</div>
          <div class="milestone-line"></div>
        </div>
        ${rows}
      </section>
    `;
  }).join('');
}

function groupRoadmapTasks(tasks) {
  const groups = [];
  for (const status of DEFAULT_STATUS_ORDER) {
    const items = tasks.filter((task) => normalizeStatus(task.status) === status);
    if (items.length) {
      groups.push({ title: displayStatus(status), items });
    }
  }
  const known = new Set(DEFAULT_STATUS_ORDER);
  const other = tasks.filter((task) => !known.has(normalizeStatus(task.status)));
  if (other.length) {
    groups.push({ title: 'Other', items: other });
  }
  return groups;
}

function renderAll() {
  document.getElementById('board-title').textContent = board.title || 'Workspace V2';
  const modeEl = document.getElementById('board-mode');
  modeEl.className = `mode-badge mode-${board.mode}`;
  modeEl.textContent = `Model: ${board.mode}`;
  document.getElementById('board-meta').textContent = `${board.tasks.length || 0} tasks`;
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

async function openTaskDetail(taskId) {
  const task = findTask(taskId);
  if (!task) {
    return;
  }

  const modal = document.getElementById('detail-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('detail-modal-title').textContent = renderPlainTaskLabel(task);
  setModalContent(renderIssueShell(task, '<p class="modal-empty">Loading detail file...</p>'));

  if (!task.detailPath) {
    setModalContent(renderIssueShell(task, '<p class="modal-empty">No detail file linked.</p>'));
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
    setModalContent(renderIssueShell(task, renderDetailMarkdown(payload.path || task.detailPath, payload.content || '')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setModalContent(renderIssueShell(task, `<p class="modal-error">${escapeHtml(message)}</p>`));
  }
}

function renderPlainTaskLabel(task) {
  return `[${task.id || '-'}] ${taskDisplayTitle(task)}`;
}

function renderIssueShell(task, bodyHtml) {
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

  const thread = task.thread && task.thread.exists ? `
    <section class="issue-side-section">
      <h4>Agent thread</h4>
      <div class="agent-card">
        <span class="agent-avatar">${escapeHtml(agentInitial(task.thread.lastAgentProfile || task.thread.lastRuntime || 'AI'))}</span>
        <div>
          <strong>${escapeHtml(task.thread.lastAgentProfile || 'Agent')}</strong>
          <span>${escapeHtml([task.thread.lastRuntime, task.thread.lastModel].filter(Boolean).join(' · ') || 'runtime unknown')}</span>
        </div>
      </div>
      ${task.thread.latestRunStatus ? `<span class="run-chip">${escapeHtml(task.thread.latestRunStatus)}</span>` : ''}
      ${task.thread.costUsd ? `<span class="run-chip">${formatCost(task.thread.costUsd)}</span>` : ''}
    </section>
  ` : '';

  return `
    <aside class="issue-sidebar">
      <section class="issue-side-section">
        <h4>Properties</h4>
        ${rows || '<p class="modal-empty">No properties yet.</p>'}
      </section>
      ${thread}
    </aside>
  `;
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

function renderDetailMarkdown(detailPath, content) {
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
  const descriptionSections = markdownSections.filter(section => !isChecklistSection(section.title));
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
  const editTrigger = target.closest('[data-edit-target]');
  const editTargetId = editTrigger ? editTrigger.getAttribute('data-edit-target') : null;
  if (editTargetId) {
    openEditTargetModal(editTargetId);
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
  const detailTrigger = target.closest('[data-open-detail]');
  const detailId = detailTrigger ? detailTrigger.getAttribute('data-open-detail') : null;
  if (detailId) {
    openTaskDetail(detailId);
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
  }
});

document.getElementById('tab-kanban').addEventListener('click', () => setView('kanban'));
document.getElementById('tab-roadmap').addEventListener('click', () => setView('roadmap'));
document.getElementById('tab-execution').addEventListener('click', () => setView('execution'));
document.getElementById('project-form')?.addEventListener('submit', submitProjectForm);

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
    renderAll();
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

setView('kanban');
