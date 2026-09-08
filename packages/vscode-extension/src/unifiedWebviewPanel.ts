import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { MarkdownKanbanParser, KanbanBoard, KanbanTask } from './markdownParser';
import { normalizeStatusLoose } from '@mapctx/core';

type WorkspaceTask = {
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
    dependsOn?: string[];
    detailPath?: string;
};

type WorkspaceTargetType = 'organization' | 'project';

type WorkspaceTarget = {
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

type WorkspaceModel = 'legacy-sections' | 'v2-status' | 'mixed' | 'unknown';

export class UnifiedWebviewPanel {
    public static currentPanel: UnifiedWebviewPanel | undefined;
    public static readonly viewType = 'markdownKanbanWorkspaceV2Panel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _board?: KanbanBoard;
    private _document?: vscode.TextDocument;
    private _workspaceModel: WorkspaceModel = 'unknown';
    private _detailFilePaths: Set<string> = new Set();
    private _detailWatchers: vscode.FileSystemWatcher[] = [];
    private _boardWatcher?: vscode.FileSystemWatcher;
    private _activeTargetOverride?: string;

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext, document?: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (UnifiedWebviewPanel.currentPanel) {
            UnifiedWebviewPanel.currentPanel._panel.reveal(column);
            if (document) {
                UnifiedWebviewPanel.currentPanel.loadMarkdownFile(document);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            UnifiedWebviewPanel.viewType,
            'Markdown Workspace V2',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        UnifiedWebviewPanel.currentPanel = new UnifiedWebviewPanel(panel, context);

        if (document) {
            UnifiedWebviewPanel.currentPanel.loadMarkdownFile(document);
        }
    }

    public static revive(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [_extensionUri],
        };
        UnifiedWebviewPanel.currentPanel = new UnifiedWebviewPanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;

        this._update();
        this._setupEventListeners();
    }

    private _setupEventListeners() {
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            e => {
                if (e.webviewPanel.visible) {
                    this._update();
                }
            },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );
    }

    private _handleMessage(message: any) {
        if (message?.type === 'openTask' && typeof message.taskId === 'string') {
            void this.openTask(message.taskId);
            return;
        }
        if (message?.type === 'addProject') {
            void vscode.window.showInformationMessage('Project registry lives in .mapctx/projects.json; automatic project creation is not wired yet.');
            return;
        }
        if (message?.type === 'browseFolder' && typeof message.inputId === 'string') {
            void this.browseFolder(message.inputId, typeof message.prompt === 'string' ? message.prompt : undefined);
            return;
        }
        if (message?.type === 'browseProjectFolder') {
            void this.browseFolder('project-path', 'Choose project folder with TASKS.md');
            return;
        }
        if (message?.type === 'updateWorkspaceTarget') {
            void vscode.window.showInformationMessage('Workspace target editing is available in the local `mapctx workspace` UI.');
            return;
        }
        if (message?.type === 'selectTarget' && typeof message.targetId === 'string') {
            void this.openWorkspaceTarget(message.targetId);
            return;
        }
    }

    private async browseFolder(inputId: string, prompt?: string) {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Folder',
            title: prompt || 'Choose folder'
        });
        const folderPath = selected?.[0]?.fsPath;
        if (!folderPath) {
            void this._panel.webview.postMessage({ type: 'folderSelectionCanceled', inputId });
            return;
        }
        void this._panel.webview.postMessage({ type: 'selectedFolder', inputId, path: folderPath });
    }

    public loadMarkdownFile(document: vscode.TextDocument) {
        this._document = document;
        const markdownText = document.getText();
        try {
            this._board = MarkdownKanbanParser.parseMarkdownWithDetails(markdownText, document.uri.fsPath);
            this._workspaceModel = this._detectWorkspaceModel(markdownText);
        } catch (error) {
            console.error('Error parsing Markdown:', error);
            vscode.window.showErrorMessage(`Workspace V2 parsing error: ${error instanceof Error ? error.message : String(error)}`);
            this._board = { title: 'Error Loading Board', columns: [] };
            this._workspaceModel = 'unknown';
        }
        this._syncWatchers();
        this._update();
    }

    private _update() {
        if (!this._panel.webview) return;

        this._panel.webview.html = this._getHtmlForWebview();
        const board = this._board || { title: 'Please open a Markdown file', columns: [] };
        const tasks = this._buildTasks(board);
        const registry = this._withActiveTarget(this._readProjectRegistry(), this._activeTargetOverride);
        const workspaceTargets = this._buildWorkspaceTargets(registry, tasks);

        this._panel.webview.postMessage({
            type: 'updateWorkspaceV2',
            title: board.title,
            columns: board.columns,
            mode: this._workspaceModel,
            tasks,
            workspaceTargets,
            projects: workspaceTargets,
            activeTargetId: registry.activeTargetId,
            activeProjectId: registry.activeTargetId
        });
    }

    private _buildTasks(board: KanbanBoard): WorkspaceTask[] {
        const markdownText = this._document?.getText() || '';
        const statusById = this._extractTaskStatusById(markdownText);
        const requiresExplicitStatus = this._workspaceModel === 'v2-status' || this._workspaceModel === 'mixed';
        const rows: WorkspaceTask[] = [];
        for (const column of board.columns) {
            if (this._isNonTaskColumn(column.title)) continue;
            for (const task of column.tasks) {
                if (requiresExplicitStatus && !statusById.has(task.id)) continue;
                rows.push({
                    id: task.id,
                    title: task.title,
                    status: statusById.get(task.id) || column.title,
                    type: task.type,
                    parent: task.parent,
                    subIssueProgress: task.subIssueProgress,
                    milestone: task.milestone,
                    startDate: task.startDate,
                    dueDate: task.dueDate,
                    completed: task.completed,
                    updated: task.updated,
                    priority: task.priority,
                    workload: task.workload,
                    tags: task.tags,
                    dependsOn: task.dependsOn,
                    detailPath: task.detailPath
                });
            }
        }
        return rows;
    }

    private _readProjectRegistry(): ProjectRegistry {
        const fallback = this._defaultProjectRegistry();
        const registryPath = path.join(this._getRepoRoot(), '.mapctx', 'projects.json');
        if (!fs.existsSync(registryPath)) return fallback;

        try {
            const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
                activeTargetId?: unknown;
                activeProjectId?: unknown;
                organizations?: unknown;
                projects?: unknown;
            };
            const organizations = this._parseOrganizations(parsed.organizations);
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

            const normalizedOrganizations = organizations.length ? organizations : this._inferOrganizations(projects);
            if (!projects.length && !normalizedOrganizations.length) return fallback;
            const activeTargetId = this._normalizeActiveTargetId(parsed.activeTargetId, parsed.activeProjectId, normalizedOrganizations, projects);
            return { activeTargetId, organizations: normalizedOrganizations, projects };
        } catch {
            return fallback;
        }
    }

    private _parseOrganizations(value: unknown): ProjectRegistryOrganization[] {
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

    private _inferOrganizations(projects: ProjectRegistryProject[]): ProjectRegistryOrganization[] {
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

    private _normalizeActiveTargetId(
        activeTarget: unknown,
        legacyActiveProject: unknown,
        organizations: ProjectRegistryOrganization[],
        projects: ProjectRegistryProject[]
    ): string {
        const targetIds = new Set([
            ...organizations.map(organization => this._targetId('organization', organization.id)),
            ...projects.map(project => this._targetId('project', project.id))
        ]);
        if (typeof activeTarget === 'string' && targetIds.has(activeTarget)) return activeTarget;
        if (typeof legacyActiveProject === 'string') {
            if (targetIds.has(legacyActiveProject)) return legacyActiveProject;
            const projectTarget = this._targetId('project', legacyActiveProject);
            if (targetIds.has(projectTarget)) return projectTarget;
            const organizationTarget = this._targetId('organization', legacyActiveProject);
            if (targetIds.has(organizationTarget)) return organizationTarget;
        }
        return projects[0] ? this._targetId('project', projects[0].id) : this._targetId('organization', organizations[0]?.id || 'local');
    }

    private _withActiveTarget(registry: ProjectRegistry, requestedTargetId: string | undefined): ProjectRegistry {
        if (!requestedTargetId) return registry;
        const validTargetIds = new Set([
            ...registry.organizations.map(organization => this._targetId('organization', organization.id)),
            ...registry.projects.map(project => this._targetId('project', project.id))
        ]);
        if (!validTargetIds.has(requestedTargetId)) return registry;
        return { ...registry, activeTargetId: requestedTargetId };
    }

    private _defaultProjectRegistry(): ProjectRegistry {
        const repoRoot = this._getRepoRoot();
        return {
            activeTargetId: this._targetId('project', 'mapctx'),
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

    private _buildWorkspaceTargets(registry: ProjectRegistry, tasks: WorkspaceTask[]): WorkspaceTarget[] {
        const activeTaskCount = tasks.length;
        const activeThreadCount = 0;
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

        const targets: WorkspaceTarget[] = [];
        for (const organization of registry.organizations) {
            targets.push(this._targetFromRegistry('organization', organization, registry.activeTargetId, activeTaskCount, activeThreadCount));
            for (const project of projectsByOrganization.get(organization.id) || []) {
                targets.push(this._targetFromRegistry('project', project, registry.activeTargetId, activeTaskCount, activeThreadCount));
            }
        }

        for (const project of orphanProjects) {
            targets.push(this._targetFromRegistry('project', project, registry.activeTargetId, activeTaskCount, activeThreadCount));
        }

        return targets;
    }

    private _targetFromRegistry(
        type: WorkspaceTargetType,
        source: ProjectRegistryOrganization | ProjectRegistryProject,
        activeTargetId: string,
        activeTaskCount: number,
        activeThreadCount: number
    ): WorkspaceTarget {
        const id = source.id;
        const targetId = this._targetId(type, id);
        const hasCurrentTasksFile = this._resolveTargetTasksFile(source.path, source.tasksFile) === this._document?.uri.fsPath;
        return {
            id,
            targetId,
            type,
            name: source.name || id,
            path: source.path || '.',
            tasksFile: source.tasksFile || 'TASKS.md',
            organizationId: type === 'project' ? (source as ProjectRegistryProject).organizationId || (source as ProjectRegistryProject).organization : undefined,
            iconUrl: this._readProjectIconDataUri(source.icon),
            accent: source.accent,
            active: targetId === activeTargetId,
            taskCount: hasCurrentTasksFile ? activeTaskCount : 0,
            threadCount: hasCurrentTasksFile ? activeThreadCount : 0
        };
    }

    private _targetId(type: WorkspaceTargetType, id: string): string {
        return `${type}:${id}`;
    }

    private _resolveTargetTasksFile(targetPath: string | undefined, targetTasksFile: string | undefined): string {
        return path.resolve(this._getRepoRoot(), targetPath || '.', targetTasksFile || 'TASKS.md');
    }

    private _readProjectIconDataUri(iconPath: string | undefined): string | undefined {
        if (!iconPath) return undefined;
        if (/^(data:|https?:\/\/)/i.test(iconPath)) return iconPath;

        const resolved = this._resolveMapctxAsset(iconPath);
        if (!resolved || !fs.existsSync(resolved)) return undefined;

        try {
            const mime = this._mimeType(resolved);
            return `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
        } catch {
            return undefined;
        }
    }

    private _resolveMapctxAsset(assetPath: string): string | undefined {
        const mapctxRoot = path.resolve(this._getRepoRoot(), '.mapctx');
        const normalized = assetPath.replace(/\\/g, '/').replace(/^\.mapctx\//, '').replace(/^\/+/, '');
        const filePath = path.resolve(mapctxRoot, normalized);
        if (filePath !== mapctxRoot && !filePath.startsWith(`${mapctxRoot}${path.sep}`)) {
            return undefined;
        }
        return filePath;
    }

    private _mimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.svg') return 'image/svg+xml';
        if (ext === '.png') return 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
        if (ext === '.webp') return 'image/webp';
        return 'application/octet-stream';
    }

    private _getRepoRoot(): string {
        if (!this._document) {
            return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        }
        return vscode.workspace.getWorkspaceFolder(this._document.uri)?.uri.fsPath || path.dirname(this._document.uri.fsPath);
    }

    private _summaryPreview(summary: string | null): string | undefined {
        if (!summary) return undefined;
        const nextAction = this._extractSummarySection(summary, 'Next Action');
        const currentState = this._extractSummarySection(summary, 'Current State');
        const fallback = summary
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(line => line && !line.startsWith('#') && line !== 'Pending.');
        return nextAction || currentState || fallback;
    }

    private _extractSummarySection(summary: string, heading: string): string | undefined {
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

    private _detectWorkspaceModel(markdownText: string): WorkspaceModel {
        const hasSingleTasksSection = /^##\s+Tasks\s*$/im.test(markdownText);
        const hasStatusProperty = /^\s{2}-\s+status:\s*[^\s].*$/im.test(markdownText);
        const hasLegacySections = /^##\s+(Backlog|Doing|Review|Done|Paused)\s*$/im.test(markdownText);

        if (hasSingleTasksSection && hasStatusProperty && hasLegacySections) {
            return 'mixed';
        }
        if (hasSingleTasksSection && hasStatusProperty) {
            return 'v2-status';
        }
        if (hasLegacySections) {
            return 'legacy-sections';
        }
        return 'unknown';
    }

    private _extractTaskStatusById(markdownText: string): Map<string, string> {
        const lines = markdownText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const statusById = new Map<string, string>();

        let currentId: string | null = null;
        let currentStatus: string | null = null;

        const flush = () => {
            if (currentId && currentStatus) {
                statusById.set(currentId, currentStatus);
            }
            currentId = null;
            currentStatus = null;
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('### ')) {
                flush();
                continue;
            }

            const m = line.match(/^\s{2}-\s+(id|status):\s*(.*)$/);
            if (!m) continue;
            const key = m[1];
            const value = m[2].trim();
            if (key === 'id') {
                currentId = value;
            } else if (key === 'status') {
                currentStatus = normalizeStatusLoose(value);
            }
        }
        flush();

        return statusById;
    }

    private async openTask(taskId: string) {
        if (!this._board || !this._document) return;

        let foundTask: KanbanTask | undefined;
        for (const column of this._board.columns) {
            if (this._isNonTaskColumn(column.title)) continue;
            const task = column.tasks.find(item => item.id === taskId);
            if (task) {
                foundTask = task;
                break;
            }
        }

        if (!foundTask?.detailPath) {
            return;
        }

        const detailFilePath = MarkdownKanbanParser.resolveDetailFilePath(foundTask.detailPath, this._document.uri.fsPath);
        const targetUri = vscode.Uri.file(detailFilePath);

        try {
            const document = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error) {
            vscode.window.showErrorMessage(`failed open file: ${error}`);
        }
    }

    private async openWorkspaceTarget(targetId: string) {
        const registry = this._readProjectRegistry();
        const target = this._findRegistryTarget(registry, targetId);
        if (!target) {
            void vscode.window.showWarningMessage(`Workspace target not found: ${targetId}`);
            return;
        }

        const tasksFilePath = this._resolveTargetTasksFile(target.path, target.tasksFile);
        if (!fs.existsSync(tasksFilePath)) {
            void vscode.window.showWarningMessage(`Workspace target has no TASKS.md: ${path.relative(this._getRepoRoot(), tasksFilePath)}`);
            return;
        }

        this._activeTargetOverride = targetId;
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(tasksFilePath));
            await vscode.window.showTextDocument(document, { preview: false });
            this.loadMarkdownFile(document);
        } catch (error) {
            vscode.window.showErrorMessage(`failed open workspace target: ${error}`);
        }
    }

    private _findRegistryTarget(registry: ProjectRegistry, targetId: string): ProjectRegistryOrganization | ProjectRegistryProject | undefined {
        const organization = registry.organizations.find(item => this._targetId('organization', item.id) === targetId);
        if (organization) return organization;
        return registry.projects.find(item => this._targetId('project', item.id) === targetId);
    }

    private _getHtmlForWebview() {
        const filePath = vscode.Uri.file(path.join(this._context.extensionPath, 'src', 'html', 'workspaceV2.html'));
        let html = fs.readFileSync(filePath.fsPath, 'utf8');

        const baseWebviewUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._context.extensionPath, 'src', 'html'))
        );

        html = html.replace(/<head>/, `<head><base href="${baseWebviewUri.toString()}/">`);

        return html;
    }

    public handleDocumentChange(document: vscode.TextDocument) {
        if (!this._document) return;
        const documentPath = document.uri.fsPath;

        if (documentPath === this._document.uri.fsPath) {
            this.loadMarkdownFile(document);
            return;
        }

        if (this._detailFilePaths.has(documentPath)) {
            this.loadMarkdownFile(this._document);
        }
    }

    public handleActiveEditorChange(document: vscode.TextDocument) {
        if (this._detailFilePaths.has(document.uri.fsPath)) {
            return;
        }
        this.loadMarkdownFile(document);
    }

    public dispose() {
        UnifiedWebviewPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposeWatchers();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            disposable?.dispose();
        }
    }

    private _syncWatchers() {
        this._disposeWatchers();

        this._detailFilePaths.clear();
        if (!this._document || !this._board) return;

        for (const column of this._board.columns) {
            if (this._isNonTaskColumn(column.title)) continue;
            for (const task of column.tasks) {
                if (!this._isTaskIdInCurrentBoard(task.id)) continue;
                if (!task.detailPath) continue;
                const detailFilePath = MarkdownKanbanParser.resolveDetailFilePath(task.detailPath, this._document.uri.fsPath);
                this._detailFilePaths.add(detailFilePath);
            }
        }

        this._boardWatcher = this._createFileWatcher(this._document.uri);

        for (const detailPath of this._detailFilePaths) {
            this._detailWatchers.push(this._createFileWatcher(vscode.Uri.file(detailPath)));
        }
    }

    private _disposeWatchers() {
        this._boardWatcher?.dispose();
        this._boardWatcher = undefined;

        this._detailWatchers.forEach(watcher => watcher.dispose());
        this._detailWatchers = [];
    }

    private _createFileWatcher(uri: vscode.Uri): vscode.FileSystemWatcher {
        const pattern = new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath));
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const refresh = async () => {
            if (!this._document) return;
            if (uri.fsPath === this._document.uri.fsPath) {
                const document = await vscode.workspace.openTextDocument(this._document.uri);
                this.loadMarkdownFile(document);
                return;
            }
            this.loadMarkdownFile(this._document);
        };

        watcher.onDidChange(() => { void refresh(); });
        watcher.onDidCreate(() => { void refresh(); });
        watcher.onDidDelete(() => { void refresh(); });

        return watcher;
    }

    private _isNonTaskColumn(title: string): boolean {
        return title.trim().toLowerCase() === 'work domains';
    }

    private _isTaskIdInCurrentBoard(taskId: string): boolean {
        if (!this._document) return true;
        const requiresExplicitStatus = this._workspaceModel === 'v2-status' || this._workspaceModel === 'mixed';
        if (!requiresExplicitStatus) return true;
        return this._extractTaskStatusById(this._document.getText()).has(taskId);
    }
}
