import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { MarkdownKanbanParser, KanbanBoard, KanbanTask } from './markdownParser';
import { normalizeStatusLoose } from '@mapctx/core';
import { readThreadContext, type ThreadRunRecord } from '@mapctx/core/thread';

type WorkspaceThreadSummary = {
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
    priority?: string;
    workload?: string;
    tags?: string[];
    detailPath?: string;
    thread?: WorkspaceThreadSummary;
};

type WorkspaceProject = {
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
    private _threadFilePaths: Set<string> = new Set();
    private _detailWatchers: vscode.FileSystemWatcher[] = [];
    private _threadWatchers: vscode.FileSystemWatcher[] = [];
    private _boardWatcher?: vscode.FileSystemWatcher;

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
        const registry = this._readProjectRegistry();

        this._panel.webview.postMessage({
            type: 'updateWorkspaceV2',
            title: board.title,
            columns: board.columns,
            mode: this._workspaceModel,
            tasks,
            projects: this._buildProjects(registry, tasks),
            activeProjectId: registry.activeProjectId
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
                    priority: task.priority,
                    workload: task.workload,
                    tags: task.tags,
                    detailPath: task.detailPath,
                    thread: this._readTaskThread(task.id)
                });
            }
        }
        return rows;
    }

    private _readTaskThread(taskId: string): WorkspaceThreadSummary {
        if (!this._document) {
            return { exists: false, runCount: 0 };
        }

        const repoRoot = this._getRepoRoot();
        try {
            const context = readThreadContext(repoRoot, taskId, { includeRuns: true });
            if (!context.exists) {
                return { exists: false, runCount: 0 };
            }

            const latestRun = context.runs[context.runs.length - 1];
            const costUsd = this._sumRunCost(context.runs);
            return {
                exists: true,
                summaryPreview: this._summaryPreview(context.summary),
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
        } catch {
            return { exists: false, runCount: 0 };
        }
    }

    private _readProjectRegistry(): ProjectRegistry {
        const fallback = this._defaultProjectRegistry();
        const registryPath = path.join(this._getRepoRoot(), '.mapctx', 'projects.json');
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

    private _defaultProjectRegistry(): ProjectRegistry {
        const repoRoot = this._getRepoRoot();
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

    private _buildProjects(registry: ProjectRegistry, tasks: WorkspaceTask[]): WorkspaceProject[] {
        const activeTaskCount = tasks.length;
        const activeThreadCount = tasks.filter(task => task.thread?.exists).length;

        return registry.projects.map(project => {
            const active = project.id === registry.activeProjectId;
            return {
                id: project.id,
                name: project.name || project.id,
                path: project.path || '.',
                iconUrl: this._readProjectIconDataUri(project.icon),
                accent: project.accent,
                active,
                taskCount: active ? activeTaskCount : 0,
                threadCount: active ? activeThreadCount : 0
            };
        });
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

    private _sumRunCost(runs: ThreadRunRecord[]): number | null {
        const total = runs.reduce((sum, run) => sum + (typeof run.costUsd === 'number' ? run.costUsd : 0), 0);
        return total > 0 ? Number(total.toFixed(4)) : null;
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

        if (this._detailFilePaths.has(documentPath) || this._threadFilePaths.has(documentPath)) {
            this.loadMarkdownFile(this._document);
        }
    }

    public handleActiveEditorChange(document: vscode.TextDocument) {
        if (this._detailFilePaths.has(document.uri.fsPath) || this._threadFilePaths.has(document.uri.fsPath)) {
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
        this._threadFilePaths.clear();
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

        const repoRoot = this._getRepoRoot();
        for (const column of this._board.columns) {
            if (this._isNonTaskColumn(column.title)) continue;
            for (const task of column.tasks) {
                if (!this._isTaskIdInCurrentBoard(task.id)) continue;
                const threadDir = path.join(repoRoot, '.mapctx', 'threads', task.id);
                for (const fileName of ['thread.md', 'summary.md', 'meta.json']) {
                    const candidate = path.join(threadDir, fileName);
                    if (fs.existsSync(candidate)) {
                        this._threadFilePaths.add(candidate);
                    }
                }
            }
        }

        this._boardWatcher = this._createFileWatcher(this._document.uri);

        for (const detailPath of this._detailFilePaths) {
            this._detailWatchers.push(this._createFileWatcher(vscode.Uri.file(detailPath)));
        }

        for (const threadPath of this._threadFilePaths) {
            this._threadWatchers.push(this._createFileWatcher(vscode.Uri.file(threadPath)));
        }
    }

    private _disposeWatchers() {
        this._boardWatcher?.dispose();
        this._boardWatcher = undefined;

        this._detailWatchers.forEach(watcher => watcher.dispose());
        this._detailWatchers = [];

        this._threadWatchers.forEach(watcher => watcher.dispose());
        this._threadWatchers = [];
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
