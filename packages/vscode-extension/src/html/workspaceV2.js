const vscode = acquireVsCodeApi();

let board = { title: 'Workspace V2', columns: [], tasks: [], mode: 'unknown' };
let activeView = 'kanban';

const DEFAULT_STATUS_ORDER = ['backlog', 'doing', 'review', 'done', 'paused'];

function normalizeStatus(status) {
  if (!status) return '';
  return String(status).trim().toLowerCase();
}

function displayStatus(status) {
  const s = normalizeStatus(status);
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function setView(view) {
  activeView = view;
  document.getElementById('tab-kanban').classList.toggle('active', view === 'kanban');
  document.getElementById('tab-roadmap').classList.toggle('active', view === 'roadmap');
  document.getElementById('kanban-view').classList.toggle('active', view === 'kanban');
  document.getElementById('roadmap-view').classList.toggle('active', view === 'roadmap');
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
        const tags = task.tags && task.tags.length > 0 ? task.tags.map(t => `<span class="pill">${t}</span>`).join('') : '';
        const typePill = task.type ? `<span class="pill">${task.type}</span>` : '';
        const openDetail = task.detailPath
          ? `<button class="open-link" data-open-task="${task.id}" type="button">Open detail</button>`
          : '';
      return `
        <article class="card">
          <div class="card-title">[${task.id || '-'}] ${task.title}</div>
          <div class="card-meta">
            ${task.priority ? `<span class="pill">${task.priority}</span>` : ''}
            ${task.workload ? `<span class="pill">${task.workload}</span>` : ''}
            ${typePill}
            ${task.dueDate ? `<span class="pill">Due ${task.dueDate}</span>` : ''}
            ${tags}
            ${openDetail}
          </div>
        </article>
      `;
    }).join('');

    return `
      <section class="col">
        <div class="col-head">
          <h3>${col.title}</h3>
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
  if (!board.tasks || board.tasks.length === 0) {
    root.innerHTML = '<p class="empty">No tasks found.</p>';
    return;
  }

  const rows = [...board.tasks]
    .sort((a, b) => {
      const aDue = a.dueDate || '9999-12-31';
      const bDue = b.dueDate || '9999-12-31';
      return aDue.localeCompare(bDue);
    })
    .map(task => `
        <tr>
          <td>[${task.id}] ${task.title}</td>
          <td>${task.status || '-'}</td>
          <td>${task.type || '-'}</td>
          <td>${task.parent || '-'}</td>
          <td>${task.subIssueProgress || '-'}</td>
          <td>${task.startDate || '-'}</td>
          <td>${task.dueDate || '-'}</td>
          <td>${task.milestone || '-'}</td>
      </tr>
    `)
    .join('');

  root.innerHTML = `
    <table class="roadmap-table">
      <thead>
        <tr>
          <th>Task</th>
          <th>Status</th>
          <th>Type</th>
          <th>Parent</th>
          <th>Sub-issue</th>
          <th>Start</th>
          <th>Due</th>
          <th>Milestone</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderAll() {
  document.getElementById('board-title').textContent = board.title || 'Workspace V2';
  const modeEl = document.getElementById('board-mode');
  modeEl.className = `mode-badge mode-${board.mode}`;
  modeEl.textContent = `Model: ${board.mode}`;
  document.getElementById('board-meta').textContent = `${board.tasks.length || 0} tasks`;
  renderKanban();
  renderRoadmap();
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

window.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const taskId = target.getAttribute('data-open-task');
  if (taskId) {
    vscode.postMessage({ type: 'openTask', taskId });
  }
});

document.getElementById('tab-kanban').addEventListener('click', () => setView('kanban'));
document.getElementById('tab-roadmap').addEventListener('click', () => setView('roadmap'));

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'updateWorkspaceV2') {
    board = {
      title: message.title,
      columns: message.columns || [],
      tasks: message.tasks || [],
      mode: message.mode || 'unknown'
    };
    renderAll();
  }
});

setView('kanban');
