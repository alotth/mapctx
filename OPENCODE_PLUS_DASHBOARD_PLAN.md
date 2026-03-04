# OpenCode Plus — Kanban/Roadmap Dashboard Plan

Este documento descreve o objetivo, a arquitetura proposta e o contexto tecnico necessario (incluindo trechos de codigo do parser) para implementar um dashboard de projetos no OpenCode Plus.

IMPORTANTE: antes de qualquer alteracao, analisar a arquitetura e o codigo do opencode-plus (Tauri + SolidJS). Nao iniciar implementacao sem mapear pontos de entrada, rotas/views e stores existentes.

## 1) Objetivo

Adicionar no OpenCode Plus uma janela Tauri dedicada que:
- Abre no projeto atual ao executar um comando
- Permite voltar para um dashboard global com todos os projetos importados
- Permite alternar entre Kanban e Gantt/Roadmap
- Futuro: botoes de sync (GitHub Projects, Notion etc.)

## 2) Diretrizes iniciais (read-only)

Antes de implementar:
1) Mapear onde o desktop guarda projetos importados
2) Identificar como abrir uma nova janela Tauri
3) Mapear rotas/views/stores da UI (SolidJS)
4) Definir onde o dashboard deve viver (app/shared UI)

## 3) Arquitetura proposta (alto nivel)

- Desktop (Tauri):
  - Comando "Open Dashboard"
  - Abre nova janela com rota dashboard
  - Passa projectId do projeto atual (opcional)

- UI (SolidJS):
  - Dashboard View: lista de projetos importados
  - Project View: tabs para Kanban e Roadmap
  - Navegacao com "Voltar ao dashboard"

- Data Layer:
  - Resolver TASKS.md + ./tasks/* por projeto
  - Parsear com o mesmo parser da extensao
  - Cache simples (mtime/hash)

- Futuro (sync):
  - Interface ProjectProvider
  - Providers: local, githubProjects, notion

## 4) Parser e modelo (vindo da extensao VSCode)

Repo origem: /Users/alt/repos/markdown-kanban-roadmap

### Modelo principal (resumo)

```ts
export interface KanbanTask {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  priority?: 'low' | 'medium' | 'high';
  workload?: 'Easy' | 'Normal' | 'Hard' | 'Extreme';
  dueDate?: string;
  startDate?: string;
  updated?: string;
  completed?: string;
  milestone?: string;
  detailPath?: string;
  defaultExpanded?: boolean;
  steps?: Array<{ text: string; completed: boolean }>;
}

export interface KanbanColumn {
  id: string;
  title: string;
  tasks: KanbanTask[];
  archived?: boolean;
}

export interface KanbanBoard {
  title: string;
  columns: KanbanColumn[];
}
```

### Regras de parsing

- Board: #
- Coluna: ## (suporta [Archived])
- Task: ### ou - (com checkbox opcional [ ]/[x])
- Props (indentadas):
  - id, due, tags, priority, workload, steps, defaultExpanded, start, milestone, detail, updated, completed
- Descricao: bloco indentado ```md ... ```
- Detail files: detail: ./tasks/T-XXX.md (resolve relativo ao TASKS.md)

### Funcoes essenciais (parser)

```ts
static parseMarkdown(content: string): KanbanBoard
static parseMarkdownWithDetails(content: string, boardFilePath: string): KanbanBoard
static generateMarkdown(board: KanbanBoard, taskHeaderFormat: 'title' | 'list' = 'title'): string
static resolveDetailFilePath(detailPath: string, boardFilePath: string): string
static parseTaskDetailMarkdown(content: string): Pick<KanbanTask, 'steps' | 'description'>
static generateTaskDetailMarkdown(task: KanbanTask): string
```

### Observacao critica

Existem logs hardcoded (path absoluto .cursor/debug.log) no parser e panels. Remover ao portar.

## 5) Kanban UI (webview)

Arquivos de origem:
- /Users/alt/repos/markdown-kanban-roadmap/src/html/webview.html
- /Users/alt/repos/markdown-kanban-roadmap/src/html/style.css
- /Users/alt/repos/markdown-kanban-roadmap/src/html/webviewScript.js

Mensagem esperada pela UI:

```js
window.addEventListener('message', event => {
  const message = event.data
  if (message.type === 'updateBoard') {
    currentBoard = message.board
    renderBoard()
  }
})
```

## 6) Roadmap/Gantt UI (webview)

Arquivos de origem:
- /Users/alt/repos/markdown-kanban-roadmap/src/html/roadmap.html
- /Users/alt/repos/markdown-kanban-roadmap/src/html/roadmapStyle.css
- /Users/alt/repos/markdown-kanban-roadmap/src/html/roadmapScript.js

Mensagem esperada pela UI:

```js
window.addEventListener('message', event => {
  const message = event.data
  if (message.type === 'updateRoadmap') {
    currentData = message
    renderRoadmap()
  }
})
```

RoadmapTask (montagem no backend):

```ts
type RoadmapTask = {
  id: string;
  title: string;
  status: string;
  milestone?: string;
  startDate?: string;
  dueDate?: string;
  completedDate?: string;
  updatedDate?: string;
  progress: number;
  detailPath?: string;
};
```

## 7) Proximos passos (depois de mapear opencode-plus)

1) Identificar local do project store
2) Adicionar comando "Open Dashboard"
3) Criar janela Tauri e rota
4) Implementar dashboard + project view
5) Conectar parser e dataset local
6) Garantir cache e leitura incremental

## 8) Nota final

Antes de qualquer implementacao:
- Ler e entender o opencode-plus (Tauri + SolidJS)
- Encontrar pontos reais de extensao (rotas, stores, comandos)
- So entao comecar mudancas
