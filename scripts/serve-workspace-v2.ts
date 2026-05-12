#!/usr/bin/env node

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { MarkdownKanbanParser, type KanbanBoard } from '../packages/vscode-extension/src/markdownParser';
import { normalizeStatusLoose } from '@mapctx/core';
import { readThreadContext, type ThreadRunRecord } from '@mapctx/core/thread';

type WorkspaceModel = 'legacy-sections' | 'v2-status' | 'mixed' | 'unknown';

type WorkspaceTaskView = {
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
  detailPath?: string;
  thread: {
    exists: boolean;
    summaryPreview?: string;
    status?: string;
    lastRuntime?: string;
    lastAgentProfile?: string;
    lastModel?: string;
    lastRunId?: string;
    latestRunStatus?: string;
    latestRunResult?: string;
    runCount: number;
    costUsd?: number;
  };
};

type WorkspaceProjectView = {
  id: string;
  name: string;
  path: string;
  iconUrl?: string;
  accent?: string;
  active: boolean;
  taskCount: number;
  threadCount: number;
};

type ProjectRegistryProject = {
  id: string;
  name?: string;
  path?: string;
  icon?: string;
  accent?: string;
  organization?: string;
};

type ProjectRegistry = {
  activeProjectId: string;
  projects: ProjectRegistryProject[];
};

const repoRoot = findRepoRoot(process.env.INIT_CWD || process.cwd());
const tasksFilePath = path.resolve(repoRoot, process.argv[2] || 'TASKS.md');
const htmlRoot = path.resolve(repoRoot, 'packages/vscode-extension/src/html');
const mapctxRoot = path.resolve(repoRoot, '.mapctx');
const port = Number(process.env.PORT || '4173');

function findRepoRoot(startPath: string): string {
  let current = path.resolve(startPath);
  while (true) {
    if (
      fs.existsSync(path.join(current, 'TASKS.md')) &&
      fs.existsSync(path.join(current, 'packages', 'vscode-extension', 'src', 'html', 'workspaceV2.html'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startPath);
    current = parent;
  }
}

function buildModel() {
  const markdownText = fs.readFileSync(tasksFilePath, 'utf8');
  const board = MarkdownKanbanParser.parseMarkdownWithDetails(markdownText, tasksFilePath);
  const mode = detectWorkspaceModel(markdownText);
  const tasks = buildTasks(board, markdownText, mode);
  const registry = readProjectRegistry();
  return {
    title: board.title,
    columns: board.columns,
    mode,
    tasks,
    projects: buildProjects(registry, tasks),
    activeProjectId: registry.activeProjectId
  };
}

function buildTasks(board: KanbanBoard, markdownText: string, mode: WorkspaceModel): WorkspaceTaskView[] {
  const statusById = extractTaskStatusById(markdownText);
  const propertiesById = extractTaskPropertiesById(markdownText);
  const requiresExplicitStatus = mode === 'v2-status' || mode === 'mixed';
  const rows: WorkspaceTaskView[] = [];

  for (const column of board.columns) {
    if (isNonTaskColumn(column.title)) continue;
    for (const task of column.tasks) {
      if (requiresExplicitStatus && !statusById.has(task.id)) continue;
      const properties = propertiesById.get(task.id);
      rows.push({
        id: task.id,
        title: task.title,
        status: statusById.get(task.id) || column.title,
        type: task.type || properties?.type,
        parent: task.parent || properties?.parent,
        subIssueProgress: task.subIssueProgress || properties?.subIssueProgress,
        milestone: task.milestone || properties?.milestone,
        startDate: task.startDate || properties?.startDate,
        dueDate: task.dueDate || properties?.dueDate,
        completed: task.completed || properties?.completed,
        updated: task.updated || properties?.updated,
        priority: task.priority || properties?.priority,
        workload: task.workload || properties?.workload,
        tags: task.tags || properties?.tags,
        detailPath: task.detailPath || properties?.detailPath,
        thread: readTaskThread(task.id)
      });
    }
  }

  return rows;
}

function isNonTaskColumn(title: string): boolean {
  return title.trim().toLowerCase() === 'work domains';
}

function readProjectRegistry(): ProjectRegistry {
  const fallback = defaultProjectRegistry();
  const registryPath = path.join(mapctxRoot, 'projects.json');
  if (!fs.existsSync(registryPath)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      activeProjectId?: unknown;
      projects?: unknown;
    };
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects
          .filter((project): project is Record<string, unknown> => Boolean(project) && typeof project === 'object')
          .filter(project => typeof project.id === 'string')
          .map(project => ({
            id: String(project.id),
            name: typeof project.name === 'string' ? project.name : String(project.id),
            path: typeof project.path === 'string' ? project.path : '.',
            icon: typeof project.icon === 'string' ? project.icon : undefined,
            accent: typeof project.accent === 'string' ? project.accent : undefined,
            organization: typeof project.organization === 'string' ? project.organization : undefined
          }))
      : [];

    if (!projects.length) return fallback;

    const requestedActive = typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : projects[0].id;
    const activeProjectId = projects.some(project => project.id === requestedActive) ? requestedActive : projects[0].id;
    return { activeProjectId, projects };
  } catch {
    return fallback;
  }
}

function defaultProjectRegistry(): ProjectRegistry {
  return {
    activeProjectId: 'mapctx',
    projects: [{
      id: 'mapctx',
      name: path.basename(repoRoot) || 'mapctx',
      path: '.',
      icon: '.mapctx/projects/mapctx/icon.svg',
      accent: '#5bb5ff'
    }]
  };
}

function buildProjects(registry: ProjectRegistry, tasks: WorkspaceTaskView[]): WorkspaceProjectView[] {
  const activeProjectId = registry.activeProjectId;
  const activeTaskCount = tasks.length;
  const activeThreadCount = tasks.filter(task => task.thread?.exists).length;

  return registry.projects.map(project => {
    const active = project.id === activeProjectId;
    return {
      id: project.id,
      name: project.name || project.id,
      path: project.path || '.',
      iconUrl: projectIconUrl(project.icon),
      accent: project.accent,
      active,
      taskCount: active ? activeTaskCount : 0,
      threadCount: active ? activeThreadCount : 0
    };
  });
}

function projectIconUrl(iconPath: string | undefined): string | undefined {
  if (!iconPath) return undefined;
  if (/^(data:|https?:\/\/)/i.test(iconPath)) return iconPath;

  const resolved = resolveMapctxAsset(iconPath);
  if (!resolved) return undefined;

  const assetPath = resolved.assetPath.split('/').map(encodeURIComponent).join('/');
  return `/mapctx-assets/${assetPath}`;
}

function resolveMapctxAsset(assetPath: string): { filePath: string; assetPath: string } | null {
  const normalized = assetPath.replace(/\\/g, '/').replace(/^\.mapctx\//, '').replace(/^\/+/, '');
  const filePath = path.resolve(mapctxRoot, normalized);
  if (filePath !== mapctxRoot && !filePath.startsWith(`${mapctxRoot}${path.sep}`)) {
    return null;
  }
  return { filePath, assetPath: normalized };
}

function readTaskThread(taskId: string): WorkspaceTaskView['thread'] {
  const context = readThreadContext(repoRoot, taskId, { includeRuns: true });
  if (!context.exists) return { exists: false, runCount: 0 };

  const latestRun = context.runs[context.runs.length - 1];
  const costUsd = sumRunCost(context.runs);
  return {
    exists: true,
    summaryPreview: summaryPreview(context.summary),
    status: context.meta?.status || undefined,
    lastRuntime: context.meta?.lastRuntime || undefined,
    lastAgentProfile: context.meta?.lastAgentProfile || undefined,
    lastModel: context.meta?.lastModel || undefined,
    lastRunId: context.meta?.lastRunId || undefined,
    latestRunStatus: latestRun?.status,
    latestRunResult: latestRun?.result || undefined,
    runCount: context.runs.length,
    costUsd: costUsd ?? undefined
  };
}

function detectWorkspaceModel(markdownText: string): WorkspaceModel {
  const hasSingleTasksSection = /^##\s+Tasks\s*$/im.test(markdownText);
  const hasStatusProperty = /^\s{2}-\s+status:\s*[^\s].*$/im.test(markdownText);
  const hasLegacySections = /^##\s+(Backlog|Doing|Review|Done|Paused)\s*$/im.test(markdownText);

  if (hasSingleTasksSection && hasStatusProperty && hasLegacySections) return 'mixed';
  if (hasSingleTasksSection && hasStatusProperty) return 'v2-status';
  if (hasLegacySections) return 'legacy-sections';
  return 'unknown';
}

function extractTaskStatusById(markdownText: string): Map<string, string> {
  const lines = markdownText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const statusById = new Map<string, string>();
  let currentId: string | null = null;
  let currentStatus: string | null = null;

  const flush = () => {
    if (currentId && currentStatus) statusById.set(currentId, currentStatus);
    currentId = null;
    currentStatus = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### ')) {
      flush();
      continue;
    }

    const match = line.match(/^\s{2}-\s+(id|status):\s*(.*)$/);
    if (!match) continue;
    if (match[1] === 'id') currentId = match[2].trim();
    if (match[1] === 'status') currentStatus = normalizeStatusLoose(match[2].trim());
  }
  flush();

  return statusById;
}

function extractTaskPropertiesById(markdownText: string): Map<string, Partial<WorkspaceTaskView>> {
  const lines = markdownText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const propertiesById = new Map<string, Partial<WorkspaceTaskView>>();
  let current: Partial<WorkspaceTaskView> | null = null;

  const flush = () => {
    if (current?.id) propertiesById.set(current.id, current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### ')) {
      flush();
      current = {};
      continue;
    }

    if (!current) continue;
    const match = line.match(/^\s{2}-\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2].trim();
    const value = rawValue === 'null' ? undefined : rawValue;
    if (key === 'id' && value) current.id = value;
    if (key === 'status' && value) current.status = normalizeStatusLoose(value);
    if (key === 'type' && value) current.type = value;
    if (key === 'parent' && value) current.parent = value;
    if (key === 'subIssueProgress' && value) current.subIssueProgress = value;
    if (key === 'priority' && value) current.priority = value;
    if (key === 'workload' && value) current.workload = value;
    if (key === 'start' && value) current.startDate = value;
    if (key === 'due' && value) current.dueDate = value;
    if (key === 'completed' && value) current.completed = value;
    if (key === 'updated' && value) current.updated = value;
    if (key === 'milestone' && value) current.milestone = value;
    if (key === 'detail' && value) current.detailPath = value;
    if (key === 'tags' && value) current.tags = parseInlineList(value);
  }

  flush();
  return propertiesById;
}

function parseInlineList(value: string): string[] | undefined {
  const match = value.match(/^\[(.*)\]$/);
  if (!match) return undefined;
  return match[1].split(',').map(item => item.trim()).filter(Boolean);
}

function summaryPreview(summary: string | null): string | undefined {
  if (!summary) return undefined;
  return extractSummarySection(summary, 'Next Action') ||
    extractSummarySection(summary, 'Current State') ||
    summary.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#') && line !== 'Pending.');
}

function extractSummarySection(summary: string, heading: string): string | undefined {
  const lines = summary.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return undefined;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('## ')) break;
    if (line) body.push(line.replace(/^[-*]\s+/, ''));
  }
  return body.join(' ').trim() || undefined;
}

function sumRunCost(runs: ThreadRunRecord[]): number | null {
  const total = runs.reduce((sum, run) => sum + (typeof run.costUsd === 'number' ? run.costUsd : 0), 0);
  return total > 0 ? Number(total.toFixed(4)) : null;
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'text/plain; charset=utf-8';
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname.startsWith('/mapctx-assets/')) {
    const assetPath = decodeURIComponent(url.pathname.slice('/mapctx-assets/'.length));
    const resolved = resolveMapctxAsset(assetPath);
    if (!resolved || !fs.existsSync(resolved.filePath) || !fs.statSync(resolved.filePath).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Asset not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType(resolved.filePath),
      'Cache-Control': 'no-cache'
    });
    response.end(fs.readFileSync(resolved.filePath));
    return;
  }

  if (url.pathname === '/api/task-detail') {
    const detailPath = url.searchParams.get('detailPath');
    if (!detailPath) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Missing detailPath');
      return;
    }

    const filePath = path.resolve(repoRoot, detailPath);
    if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Detail not found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      path: path.relative(repoRoot, filePath),
      content: fs.readFileSync(filePath, 'utf8')
    }));
    return;
  }

  const relativePath = url.pathname === '/' ? 'workspaceV2.html' : url.pathname.slice(1);
  const filePath = path.resolve(htmlRoot, relativePath);

  if (!filePath.startsWith(htmlRoot)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  let body = fs.readFileSync(filePath, 'utf8');
  if (relativePath === 'workspaceV2.html') {
    const model = JSON.stringify(buildModel()).replace(/</g, '\\u003c');
    body = body.replace('<script src="workspaceV2.js"></script>', `<script>window.MAPCTX_BOOTSTRAP=${model};</script>\n    <script src="workspaceV2.js"></script>`);
  }

  response.writeHead(200, { 'Content-Type': contentType(filePath) });
  response.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Workspace V2 dev server: http://127.0.0.1:${port}`);
  console.log(`Tasks file: ${tasksFilePath}`);
});
