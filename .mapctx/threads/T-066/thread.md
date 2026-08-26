# Thread T-066

## Messages

### 2026-08-26T23:44:57.000Z - system

Created portable MapCtx thread substrate for T-066, the first real cutover gate.

### 2026-08-26T23:44:57.000Z - user

Implement T-066 now: run `mapctx import --commit`, prove export/checkpoint/recovery, record every receipt, do not install globally.

### 2026-08-26T23:44:57.000Z - agent

Open decisions resolved before execution:

- Recovery checkpoint SHA = the commit created immediately before cutover, holding the last Markdown-authoritative board (76 tasks, 0 errors).
- Disposable recovery copy lives outside the repository and outside `~/.mapctx/projects/`, under a temporary drill directory, so the real store is never mutated during the drill.

Pre-cutover receipts captured under `runs/pre-cutover/`: validate (76 tasks, 0 errors, 2 known bulk-timestamp warnings), plan, gantt (`mode: pre-cutover`, 76 tasks), task show/context for T-066. Suites green: protocol 18/18, store 30/30, forecast 16/16, planner 12/12, sync-engine 40/40. VS Code extension suite is environment-blocked (`vscode-test` Electron binary not downloaded), unrelated to this gate.
