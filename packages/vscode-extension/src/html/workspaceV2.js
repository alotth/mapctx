const vscode = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: (message) => console.info('workspaceV2 message', message) };

let board = { title: 'Workspace V2', columns: [], tasks: [], mode: 'unknown', projects: [], activeProjectId: null };
let activeView = 'kanban';

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

function projectInitials(project) {
  const label = String(project.name || project.id || '?').trim();
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

function renderProjects() {
  const root = document.getElementById('project-rail-list');
  if (!root) {
    return;
  }

  const projects = board.projects || [];
  if (!projects.length) {
    root.innerHTML = '<div class="project-empty" aria-hidden="true"></div>';
    return;
  }

  root.innerHTML = projects.map((project) => {
    const active = Boolean(project.active || project.id === board.activeProjectId);
    const accent = projectAccent(project.accent);
    const style = accent ? ` style="--project-accent:${accent}"` : '';
    const icon = project.iconUrl
      ? `<img src="${escapeHtml(project.iconUrl)}" alt="" loading="lazy">`
      : `<span>${escapeHtml(projectInitials(project))}</span>`;
    const taskCount = projectCountLabel(project.taskCount);
    const title = `${project.name || project.id} - ${project.taskCount || 0} tasks`;
    return `
      <button
        class="project-tile ${active ? 'active' : ''}"
        data-select-project="${escapeHtml(project.id)}"
        type="button"
        aria-label="${escapeHtml(title)}"
        aria-pressed="${active ? 'true' : 'false'}"
        title="${escapeHtml(title)}"${style}>
        <span class="project-avatar">${icon}</span>
        <span class="project-count">${escapeHtml(taskCount)}</span>
      </button>
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

function closeModal() {
  const modal = document.getElementById('detail-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function setModalContent(html) {
  document.getElementById('detail-modal-content').innerHTML = html;
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
  setModalContent(`${renderTaskInfo(task)}<p class="modal-empty">Loading detail file...</p>`);

  if (!task.detailPath) {
    setModalContent(`${renderTaskInfo(task)}<p class="modal-empty">No detail file linked.</p>`);
    return;
  }

  try {
    const query = new URLSearchParams({ detailPath: task.detailPath });
    const response = await fetch(`/api/task-detail?${query.toString()}`);
    if (!response.ok) {
      throw new Error(await response.text() || 'Failed to load detail');
    }
    const payload = await response.json();
    setModalContent(`${renderTaskInfo(task)}${renderDetailMarkdown(payload.path || task.detailPath, payload.content || '')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setModalContent(`${renderTaskInfo(task)}<p class="modal-error">${escapeHtml(message)}</p>`);
  }
}

function renderPlainTaskLabel(task) {
  return `[${task.id || '-'}] ${taskDisplayTitle(task)}`;
}

function renderTaskInfo(task) {
  const rows = [
    ['Status', task.status],
    ['Type', task.type],
    ['Parent', task.parent],
    ['Sub-issue', task.subIssueProgress],
    ['Priority', task.priority],
    ['Workload', task.workload],
    ['Start', task.startDate],
    ['Due', task.dueDate],
    ['Updated', task.updated],
    ['Completed', task.completed],
    ['Milestone', task.milestone],
    ['Detail', task.detailPath]
  ]
    .filter(([, value]) => value && value !== 'null')
    .map(([label, value]) => `<div class="modal-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`)
    .join('');
  return `<section class="modal-section"><h3>Task info</h3>${rows}</section>`;
}

function renderDetailMarkdown(detailPath, content) {
  const summary = extractDetailSummary(content);
  const checklist = extractChecklist(content);
  const checklistHtml = checklist.length
    ? `<ul class="modal-steps">${checklist.map((step) => `<li class="${step.done ? 'done' : ''}">${escapeHtml(step.text)}</li>`).join('')}</ul>`
    : '<p class="modal-empty">No checklist steps found.</p>';
  const summaryHtml = summary
    ? `<div class="modal-markdown">${summary}</div>`
    : '<p class="modal-empty">No description block found.</p>';
  return `
    <section class="modal-section">
      <h3>Detail file</h3>
      <div class="modal-row"><span>Path</span><strong>${escapeHtml(detailPath)}</strong></div>
      ${summaryHtml}
      ${checklistHtml}
      <details>
        <summary>Raw detail markdown</summary>
        <pre class="modal-pre">${escapeHtml(content)}</pre>
      </details>
    </section>
  `;
}

function extractChecklist(content) {
  return content.split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+\[([ x])\]\s+(.*)$/i))
    .filter(Boolean)
    .map((match) => ({ done: match[1].toLowerCase() === 'x', text: match[2].trim() }));
}

function extractDetailSummary(content) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '- description: |');
  if (start < 0) {
    return '';
  }
  const body = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s{2}-\s+\w/.test(line)) {
      break;
    }
    body.push(line.replace(/^\s{6}/, ''));
  }
  return renderSimpleMarkdown(body.join('\n').trim());
}

function renderSimpleMarkdown(markdown) {
  return escapeHtml(markdown)
    .replace(/^### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^## (.*)$/gm, '<h3>$1</h3>')
    .replace(/^- \[ \] (.*)$/gm, '<div class="modal-check">[ ] $1</div>')
    .replace(/^- \[x\] (.*)$/gim, '<div class="modal-check done">[x] $1</div>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<h|<div)(.+)$/gm, '<p>$1</p>');
}

window.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const projectTrigger = target.closest('[data-select-project]');
  const projectId = projectTrigger ? projectTrigger.getAttribute('data-select-project') : null;
  if (projectId) {
    board.activeProjectId = projectId;
    board.projects = (board.projects || []).map((project) => ({
      ...project,
      active: project.id === projectId
    }));
    renderProjects();
    vscode.postMessage({ type: 'selectProject', projectId });
    return;
  }
  if (target.closest('#project-add')) {
    vscode.postMessage({ type: 'addProject' });
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
    closeModal();
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

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'updateWorkspaceV2') {
    board = {
      title: message.title,
      columns: message.columns || [],
      tasks: message.tasks || [],
      mode: message.mode || 'unknown',
      projects: message.projects || [],
      activeProjectId: message.activeProjectId || null
    };
    renderAll();
  }
});

if (window.MAPCTX_BOOTSTRAP) {
  board = window.MAPCTX_BOOTSTRAP;
  renderAll();
}

setView('kanban');
