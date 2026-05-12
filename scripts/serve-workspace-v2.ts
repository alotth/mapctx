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

type WorkspaceTargetType = 'organization' | 'project';

type WorkspaceTargetView = {
  id: string;
  targetId: string;
  type: WorkspaceTargetType;
  name: string;
  path: string;
  tasksFile?: string;
  organizationId?: string;
  iconUrl?: string;
  accent?: string;
  active: boolean;
  taskCount: number;
  threadCount: number;
};

type ProjectRegistryOrganization = {
  id: string;
  name?: string;
  path?: string;
  tasksFile?: string;
  icon?: string;
  accent?: string;
};

type ProjectRegistryProject = {
  id: string;
  name?: string;
  path?: string;
  tasksFile?: string;
  icon?: string;
  accent?: string;
  organizationId?: string;
  organization?: string;
};

type ProjectRegistry = {
  activeTargetId: string;
  organizations: ProjectRegistryOrganization[];
  projects: ProjectRegistryProject[];
};

const repoRoot = findRepoRoot(process.env.INIT_CWD || process.cwd());
const defaultTasksFilePath = path.resolve(repoRoot, process.argv[2] || 'TASKS.md');
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

function buildModel(requestedTargetId?: string) {
  const registry = withActiveTarget(readProjectRegistry(), requestedTargetId);
  const activeTasksFilePath = resolveActiveTasksFile(registry) || defaultTasksFilePath;
  const markdownText = fs.readFileSync(activeTasksFilePath, 'utf8');
  const board = MarkdownKanbanParser.parseMarkdownWithDetails(markdownText, activeTasksFilePath);
  const mode = detectWorkspaceModel(markdownText);
  const tasks = buildTasks(board, markdownText, mode);
  const workspaceTargets = buildWorkspaceTargets(registry, tasks, activeTasksFilePath);
  return {
    title: board.title,
    columns: board.columns,
    mode,
    tasks,
    workspaceTargets,
    projects: workspaceTargets,
    activeTargetId: registry.activeTargetId,
    activeProjectId: registry.activeTargetId,
    tasksFilePath: path.relative(repoRoot, activeTasksFilePath)
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
      activeTargetId?: unknown;
      activeProjectId?: unknown;
      organizations?: unknown;
      projects?: unknown;
    };
    const organizations = parseOrganizations(parsed.organizations);
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects
          .filter((project): project is Record<string, unknown> => Boolean(project) && typeof project === 'object')
          .filter(project => typeof project.id === 'string')
          .map(project => ({
            id: String(project.id),
            name: typeof project.name === 'string' ? project.name : String(project.id),
            path: typeof project.path === 'string' ? project.path : '.',
            tasksFile: typeof project.tasksFile === 'string' ? project.tasksFile : undefined,
            icon: typeof project.icon === 'string' ? project.icon : undefined,
            accent: typeof project.accent === 'string' ? project.accent : undefined,
            organizationId: typeof project.organizationId === 'string' ? project.organizationId : undefined,
            organization: typeof project.organization === 'string' ? project.organization : undefined
          }))
      : [];

    const normalizedOrganizations = organizations.length ? organizations : inferOrganizations(projects);
    if (!projects.length && !normalizedOrganizations.length) return fallback;
    const activeTargetId = normalizeActiveTargetId(parsed.activeTargetId, parsed.activeProjectId, normalizedOrganizations, projects);
    return { activeTargetId, organizations: normalizedOrganizations, projects };
  } catch {
    return fallback;
  }
}

function parseOrganizations(value: unknown): ProjectRegistryOrganization[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((organization): organization is Record<string, unknown> => Boolean(organization) && typeof organization === 'object')
    .filter(organization => typeof organization.id === 'string')
    .map(organization => ({
      id: String(organization.id),
      name: typeof organization.name === 'string' ? organization.name : String(organization.id),
      path: typeof organization.path === 'string' ? organization.path : '.',
      tasksFile: typeof organization.tasksFile === 'string' ? organization.tasksFile : undefined,
      icon: typeof organization.icon === 'string' ? organization.icon : undefined,
      accent: typeof organization.accent === 'string' ? organization.accent : undefined
    }));
}

function inferOrganizations(projects: ProjectRegistryProject[]): ProjectRegistryOrganization[] {
  const inferred = new Map<string, ProjectRegistryOrganization>();
  for (const project of projects) {
    const id = project.organizationId || project.organization;
    if (!id || inferred.has(id)) continue;
    inferred.set(id, {
      id,
      name: id,
      path: project.path || '.',
      tasksFile: project.tasksFile || 'TASKS.md',
      accent: project.accent
    });
  }
  return Array.from(inferred.values());
}

function normalizeActiveTargetId(
  activeTarget: unknown,
  legacyActiveProject: unknown,
  organizations: ProjectRegistryOrganization[],
  projects: ProjectRegistryProject[]
): string {
  const targetIds = new Set([
    ...organizations.map(organization => targetId('organization', organization.id)),
    ...projects.map(project => targetId('project', project.id))
  ]);
  if (typeof activeTarget === 'string' && targetIds.has(activeTarget)) return activeTarget;
  if (typeof legacyActiveProject === 'string') {
    if (targetIds.has(legacyActiveProject)) return legacyActiveProject;
    const projectTarget = targetId('project', legacyActiveProject);
    if (targetIds.has(projectTarget)) return projectTarget;
    const organizationTarget = targetId('organization', legacyActiveProject);
    if (targetIds.has(organizationTarget)) return organizationTarget;
  }
  return projects[0] ? targetId('project', projects[0].id) : targetId('organization', organizations[0]?.id || 'local');
}

function withActiveTarget(registry: ProjectRegistry, requestedTargetId: string | undefined): ProjectRegistry {
  if (!requestedTargetId) return registry;
  const validTargetIds = new Set([
    ...registry.organizations.map(organization => targetId('organization', organization.id)),
    ...registry.projects.map(project => targetId('project', project.id))
  ]);
  if (!validTargetIds.has(requestedTargetId)) return registry;
  return { ...registry, activeTargetId: requestedTargetId };
}

function resolveActiveTasksFile(registry: ProjectRegistry): string | undefined {
  const organization = registry.organizations.find(item => targetId('organization', item.id) === registry.activeTargetId);
  if (organization) return resolveTargetTasksFile(organization.path, organization.tasksFile);

  const project = registry.projects.find(item => targetId('project', item.id) === registry.activeTargetId);
  if (project) return resolveTargetTasksFile(project.path, project.tasksFile);

  return undefined;
}

function defaultProjectRegistry(): ProjectRegistry {
  return {
    activeTargetId: targetId('project', 'mapctx'),
    organizations: [{
      id: 'local',
      name: 'Local',
      path: '.',
      tasksFile: 'TASKS.md',
      icon: '.mapctx/organizations/local/icon.svg',
      accent: '#5bb5ff'
    }],
    projects: [{
      id: 'mapctx',
      name: path.basename(repoRoot) || 'mapctx',
      organizationId: 'local',
      path: '.',
      tasksFile: 'TASKS.md',
      icon: '.mapctx/projects/mapctx/icon.svg',
      accent: '#7cde9f'
    }]
  };
}

function buildWorkspaceTargets(registry: ProjectRegistry, tasks: WorkspaceTaskView[], activeTasksFilePath: string): WorkspaceTargetView[] {
  const activeTaskCount = tasks.length;
  const activeThreadCount = tasks.filter(task => task.thread?.exists).length;
  const projectsByOrganization = new Map<string, ProjectRegistryProject[]>();
  const orphanProjects: ProjectRegistryProject[] = [];

  for (const project of registry.projects) {
    const organizationId = project.organizationId || project.organization;
    if (!organizationId) {
      orphanProjects.push(project);
      continue;
    }
    const current = projectsByOrganization.get(organizationId) || [];
    current.push(project);
    projectsByOrganization.set(organizationId, current);
  }

  const targets: WorkspaceTargetView[] = [];
  for (const organization of registry.organizations) {
    targets.push(targetFromRegistry('organization', organization, registry.activeTargetId, activeTaskCount, activeThreadCount, activeTasksFilePath));
    for (const project of projectsByOrganization.get(organization.id) || []) {
      targets.push(targetFromRegistry('project', project, registry.activeTargetId, activeTaskCount, activeThreadCount, activeTasksFilePath));
    }
  }

  for (const project of orphanProjects) {
    targets.push(targetFromRegistry('project', project, registry.activeTargetId, activeTaskCount, activeThreadCount, activeTasksFilePath));
  }

  return targets;
}

function targetFromRegistry(
  type: WorkspaceTargetType,
  source: ProjectRegistryOrganization | ProjectRegistryProject,
  activeTargetId: string,
  activeTaskCount: number,
  activeThreadCount: number,
  activeTasksFilePath: string
): WorkspaceTargetView {
  const id = source.id;
  const currentTargetId = targetId(type, id);
  const tasksPath = resolveTargetTasksFile(source.path, source.tasksFile);
  const hasCurrentTasksFile = tasksPath === activeTasksFilePath;
  return {
    id,
    targetId: currentTargetId,
    type,
    name: source.name || id,
    path: source.path || '.',
    tasksFile: source.tasksFile || 'TASKS.md',
    organizationId: type === 'project' ? (source as ProjectRegistryProject).organizationId || (source as ProjectRegistryProject).organization : undefined,
    iconUrl: projectIconUrl(source.icon),
    accent: source.accent,
    active: currentTargetId === activeTargetId,
    taskCount: hasCurrentTasksFile ? activeTaskCount : 0,
    threadCount: hasCurrentTasksFile ? activeThreadCount : 0
  };
}

function targetId(type: WorkspaceTargetType, id: string): string {
  return `${type}:${id}`;
}

function resolveTargetTasksFile(targetPath: string | undefined, targetTasksFile: string | undefined): string {
  return path.resolve(repoRoot, targetPath || '.', targetTasksFile || 'TASKS.md');
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
    const requestedTargetId = url.searchParams.get('target') || undefined;
    const model = JSON.stringify(buildModel(requestedTargetId)).replace(/</g, '\\u003c');
    body = body.replace('<script src="workspaceV2.js"></script>', `<script>window.MAPCTX_BOOTSTRAP=${model};</script>\n    <script src="workspaceV2.js"></script>`);
  }

  response.writeHead(200, { 'Content-Type': contentType(filePath) });
  response.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Workspace V2 dev server: http://127.0.0.1:${port}`);
  console.log(`Default tasks file: ${defaultTasksFilePath}`);
});
