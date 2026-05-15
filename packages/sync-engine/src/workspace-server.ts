import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { normalizeStatusLoose } from '@mapctx/core';
import { readThreadContext, type ThreadRunRecord } from '@mapctx/core/thread';
import {
  addProjectToRegistry,
  ensureWorkspaceRegistry,
  getGlobalRegistryPath,
  getMapctxHome,
  readWorkspaceRegistry,
  resolveWorkspaceTargetTasksFile,
  targetId,
  type WorkspaceOrganization,
  type WorkspaceProject,
  type WorkspaceRegistry,
  type WorkspaceTargetType
} from '@mapctx/core/workspace';
import { parseTasksFile } from './markdown';
import { Task, TaskBoard } from './types';

type WorkspaceModel = 'legacy-sections' | 'v2-status' | 'mixed' | 'unknown';

type WorkspaceServerOptions = {
  cwd?: string;
  port?: number;
  host?: string;
  open?: boolean;
  addProjectPath?: string;
  organizationId?: string;
  organizationName?: string;
  projectPath?: string;
  targetId?: string;
  registryPath?: string;
};

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
  dependsOn?: string[];
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

type ActiveWorkspace = {
  registry: WorkspaceRegistry;
  target?: WorkspaceOrganization | WorkspaceProject;
  targetType?: WorkspaceTargetType;
  projectRoot: string;
  tasksFilePath: string;
};

export function parseWorkspaceServerArgs(argv: string[], cwd = process.cwd()): WorkspaceServerOptions {
  const options: WorkspaceServerOptions = { cwd };
  const args = [...argv];

  while (args.length) {
    const arg = args.shift() || '';
    if (arg === '--open') {
      options.open = true;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--port') {
      options.port = Number(args.shift() || '0') || undefined;
    } else if (arg === '--host') {
      options.host = args.shift();
    } else if (arg === '--add') {
      options.addProjectPath = args.shift();
    } else if (arg === '--org') {
      options.organizationId = args.shift();
    } else if (arg === '--org-name') {
      options.organizationName = args.shift();
    } else if (arg === '--target') {
      options.targetId = args.shift();
    } else if (arg === '--registry') {
      options.registryPath = args.shift();
    } else if (!arg.startsWith('-') && !options.projectPath) {
      options.projectPath = arg;
    }
  }

  return options;
}

export function startWorkspaceServerFromArgv(argv = process.argv.slice(2)): void {
  void startWorkspaceServer(parseWorkspaceServerArgs(argv)).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}

export async function startWorkspaceServer(options: WorkspaceServerOptions = {}): Promise<http.Server> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const port = options.port || Number(process.env.PORT || '4173');
  const host = options.host || '127.0.0.1';
  const registryOptions = options.registryPath ? { registryPath: path.resolve(cwd, options.registryPath) } : {};
  const addProjectPath = options.addProjectPath || options.projectPath;

  ensureWorkspaceRegistry({
    ...registryOptions,
    cwd,
    addProjectPath,
    addCurrentIfTasks: !addProjectPath,
    organizationId: options.organizationId,
    organizationName: options.organizationName
  });

  const htmlRoot = findHtmlRoot();
  const server = http.createServer((request, response) => {
    try {
      handleRequest(request, response, {
        cwd,
        htmlRoot,
        port,
        registryPath: registryOptions.registryPath,
        defaultTargetId: options.targetId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  const url = new URL(`http://${host}:${port}/`);
  if (options.targetId) url.searchParams.set('target', options.targetId);

  console.log(`MapCtx workspace: ${url.toString()}`);
  console.log(`Registry: ${getGlobalRegistryPath(registryOptions)}`);
  console.log(`Home: ${registryOptions.registryPath ? path.dirname(registryOptions.registryPath) : getMapctxHome(registryOptions)}`);

  if (options.open) {
    openUrl(url.toString());
  }

  return server;
}

function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: { cwd: string; htmlRoot: string; port: number; registryPath?: string; defaultTargetId?: string }
): void {
  const url = new URL(request.url || '/', `http://localhost:${context.port}`);
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestedTargetId = url.searchParams.get('target') || context.defaultTargetId || undefined;
  const activeWorkspace = resolveActiveWorkspace(requestedTargetId, context.registryPath);

  if (url.pathname.startsWith('/mapctx-assets/')) {
    const assetPath = decodeURIComponent(url.pathname.slice('/mapctx-assets/'.length));
    const filePath = activeWorkspace ? resolveAssetPath(activeWorkspace, assetPath) : undefined;
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Asset not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-cache'
    });
    response.end(fs.readFileSync(filePath));
    return;
  }

  if (url.pathname === '/api/task-detail') {
    const detailPath = url.searchParams.get('detailPath');
    if (!detailPath) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Missing detailPath');
      return;
    }

    if (!activeWorkspace) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('No active workspace target');
      return;
    }

    const filePath = path.resolve(activeWorkspace.projectRoot, detailPath);
    if (!isInside(activeWorkspace.projectRoot, filePath) || !fs.existsSync(filePath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Detail not found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      path: path.relative(activeWorkspace.projectRoot, filePath),
      content: fs.readFileSync(filePath, 'utf8')
    }));
    return;
  }

  const relativePath = url.pathname === '/' ? 'workspaceV2.html' : url.pathname.slice(1);
  const filePath = path.resolve(context.htmlRoot, relativePath);

  if (!isInside(context.htmlRoot, filePath)) {
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
    const model = JSON.stringify(buildModel(activeWorkspace, context.registryPath)).replace(/</g, '\\u003c');
    body = body.replace('<script src="workspaceV2.js"></script>', `<script>window.MAPCTX_BOOTSTRAP=${model};</script>\n    <script src="workspaceV2.js"></script>`);
  }

  response.writeHead(200, { 'Content-Type': contentType(filePath) });
  response.end(body);
}

function buildModel(activeWorkspace: ActiveWorkspace | undefined, registryPath?: string) {
  if (!activeWorkspace) {
    const registry = readWorkspaceRegistry(registryPath ? { registryPath } : {});
    return {
      title: 'MapCtx Workspace',
      columns: [],
      mode: 'unknown',
      tasks: [],
      workspaceTargets: buildWorkspaceTargets(registry, [], ''),
      projects: buildWorkspaceTargets(registry, [], ''),
      activeTargetId: registry.activeTargetId,
      activeProjectId: registry.activeTargetId,
      tasksFilePath: null,
      projectRoot: null
    };
  }

  const markdownText = fs.readFileSync(activeWorkspace.tasksFilePath, 'utf8');
  const board = parseTasksFile(activeWorkspace.tasksFilePath);
  const mode = detectWorkspaceModel(markdownText);
  const tasks = buildTasks(board, activeWorkspace.projectRoot);
  const columns = buildColumns(tasks);
  const workspaceTargets = buildWorkspaceTargets(activeWorkspace.registry, tasks, activeWorkspace.tasksFilePath);

  return {
    title: board.title,
    columns,
    mode,
    tasks,
    workspaceTargets,
    projects: workspaceTargets,
    activeTargetId: activeWorkspace.registry.activeTargetId,
    activeProjectId: activeWorkspace.registry.activeTargetId,
    tasksFilePath: path.relative(activeWorkspace.projectRoot, activeWorkspace.tasksFilePath),
    projectRoot: activeWorkspace.projectRoot
  };
}

function buildTasks(board: TaskBoard, projectRoot: string): WorkspaceTaskView[] {
  return board.tasks.map(task => ({
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    parent: task.parent,
    subIssueProgress: task.subIssueProgress,
    milestone: task.milestone,
    startDate: task.start,
    dueDate: task.due,
    completed: task.completed || undefined,
    updated: task.updated,
    priority: task.priority,
    workload: task.workload,
    tags: task.tags,
    detailPath: task.detail,
    dependsOn: task.dependsOn,
    thread: readTaskThread(projectRoot, task.id)
  }));
}

function buildColumns(tasks: WorkspaceTaskView[]): Array<{ id: string; title: string; tasks: WorkspaceTaskView[] }> {
  const grouped = new Map<string, WorkspaceTaskView[]>();
  for (const task of tasks) {
    const status = normalizeStatusLoose(task.status) || 'unknown';
    grouped.set(status, [...(grouped.get(status) || []), task]);
  }

  return Array.from(grouped.entries()).map(([status, items]) => ({
    id: `status:${status}`,
    title: displayStatus(status),
    tasks: items
  }));
}

function buildWorkspaceTargets(registry: WorkspaceRegistry, tasks: WorkspaceTaskView[], activeTasksFilePath: string): WorkspaceTargetView[] {
  const activeTaskCount = tasks.length;
  const activeThreadCount = tasks.filter(task => task.thread?.exists).length;
  const projectsByOrganization = new Map<string, WorkspaceProject[]>();
  const orphanProjects: WorkspaceProject[] = [];

  for (const project of registry.projects) {
    if (!project.organizationId) {
      orphanProjects.push(project);
      continue;
    }
    const current = projectsByOrganization.get(project.organizationId) || [];
    current.push(project);
    projectsByOrganization.set(project.organizationId, current);
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
  source: WorkspaceOrganization | WorkspaceProject,
  activeTargetId: string | undefined,
  activeTaskCount: number,
  activeThreadCount: number,
  activeTasksFilePath: string
): WorkspaceTargetView {
  const currentTargetId = targetId(type, source.id);
  const tasksPath = resolveWorkspaceTargetTasksFile(source);
  const hasCurrentTasksFile = tasksPath === activeTasksFilePath;

  return {
    id: source.id,
    targetId: currentTargetId,
    type,
    name: source.name || source.id,
    path: source.path || '',
    tasksFile: source.tasksFile || 'TASKS.md',
    organizationId: type === 'project' ? (source as WorkspaceProject).organizationId : undefined,
    iconUrl: projectIconUrl(source),
    accent: source.accent,
    active: currentTargetId === activeTargetId,
    taskCount: hasCurrentTasksFile ? activeTaskCount : 0,
    threadCount: hasCurrentTasksFile ? activeThreadCount : 0
  };
}

function resolveActiveWorkspace(requestedTargetId: string | undefined, registryPath?: string): ActiveWorkspace | undefined {
  let registry = readWorkspaceRegistry(registryPath ? { registryPath } : {});
  if (registry.projects.length === 0 && registry.organizations.length === 0) {
    return undefined;
  }

  if (requestedTargetId && hasTarget(registry, requestedTargetId)) {
    registry = { ...registry, activeTargetId: requestedTargetId };
  }

  const activeTarget = findTarget(registry, registry.activeTargetId);
  if (!activeTarget) {
    const fallbackProject = registry.projects[0];
    if (!fallbackProject) throw new Error('No MapCtx project target available.');
    registry = { ...registry, activeTargetId: targetId('project', fallbackProject.id) };
    return workspaceFromTarget(registry, fallbackProject, 'project');
  }

  return workspaceFromTarget(registry, activeTarget.target, activeTarget.type);
}

function workspaceFromTarget(registry: WorkspaceRegistry, target: WorkspaceOrganization | WorkspaceProject, targetType: WorkspaceTargetType): ActiveWorkspace {
  const tasksFilePath = resolveWorkspaceTargetTasksFile(target);
  if (!fs.existsSync(tasksFilePath)) {
    throw new Error(`Target TASKS.md not found: ${tasksFilePath}`);
  }

  return {
    registry,
    target,
    targetType,
    projectRoot: path.dirname(tasksFilePath),
    tasksFilePath
  };
}

function findTarget(registry: WorkspaceRegistry, requestedTargetId: string | undefined): { type: WorkspaceTargetType; target: WorkspaceOrganization | WorkspaceProject } | undefined {
  if (!requestedTargetId) return undefined;
  const organization = registry.organizations.find(item => targetId('organization', item.id) === requestedTargetId);
  if (organization) return { type: 'organization', target: organization };
  const project = registry.projects.find(item => targetId('project', item.id) === requestedTargetId);
  if (project) return { type: 'project', target: project };
  return undefined;
}

function hasTarget(registry: WorkspaceRegistry, requestedTargetId: string): boolean {
  return Boolean(findTarget(registry, requestedTargetId));
}

function projectIconUrl(source: WorkspaceOrganization | WorkspaceProject): string | undefined {
  if (!source.icon) return undefined;
  if (/^(data:|https?:\/\/)/i.test(source.icon)) return source.icon;

  const sourcePath = source.path || process.cwd();
  const filePath = path.isAbsolute(source.icon)
    ? source.icon
    : path.resolve(sourcePath, source.icon);

  return `/mapctx-assets/${encodeURIComponent(filePath)}`;
}

function resolveAssetPath(_activeWorkspace: ActiveWorkspace, assetPath: string): string | undefined {
  const decoded = decodeURIComponent(assetPath);
  if (!path.isAbsolute(decoded)) return undefined;
  return decoded;
}

function readTaskThread(projectRoot: string, taskId: string): WorkspaceTaskView['thread'] {
  const context = readThreadContext(projectRoot, taskId, { includeRuns: true });
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

function displayStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
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

function findHtmlRoot(): string {
  let current = path.resolve(__dirname);
  while (true) {
    const candidate = path.join(current, 'packages', 'vscode-extension', 'src', 'html');
    if (fs.existsSync(path.join(candidate, 'workspaceV2.html'))) return candidate;

    const packageCandidate = path.join(current, 'workspace-ui');
    if (fs.existsSync(path.join(packageCandidate, 'workspaceV2.html'))) return packageCandidate;

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Could not locate Workspace V2 HTML assets.');
    }
    current = parent;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function openUrl(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin'
    ? 'open'
    : platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

export function registerWorkspaceProject(projectPath: string, options: { organizationId?: string; organizationName?: string; registryPath?: string } = {}): void {
  const registry = readWorkspaceRegistry(options.registryPath ? { registryPath: options.registryPath } : {});
  const result = addProjectToRegistry(registry, projectPath, options);
  const registryPath = options.registryPath
    ? path.resolve(options.registryPath)
    : getGlobalRegistryPath();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, `${JSON.stringify(result.registry, null, 2)}\n`, 'utf8');
}
