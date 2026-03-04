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
    priority?: string;
    tags?: string[];
    detailPath?: string;
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

        this._panel.webview.postMessage({
            type: 'updateWorkspaceV2',
            title: board.title,
            columns: board.columns,
            mode: this._workspaceModel,
            tasks: this._buildTasks(board)
        });
    }

    private _buildTasks(board: KanbanBoard): WorkspaceTask[] {
        const markdownText = this._document?.getText() || '';
        const statusById = this._extractTaskStatusById(markdownText);
        const rows: WorkspaceTask[] = [];
        for (const column of board.columns) {
            for (const task of column.tasks) {
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
                    tags: task.tags,
                    detailPath: task.detailPath
                });
            }
        }
        return rows;
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
            for (const task of column.tasks) {
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
}
