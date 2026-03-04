# Reconcile Conflicts

Use this flow when `push` is blocked by concurrent local/remote edits.

## Conflict Model

Push compares:

- BASE: last successful pull
- LOCAL: current `tasks/T-XXX.md`
- REMOTE: current GitHub issue body

If LOCAL and REMOTE changed concurrently, push is blocked and conflict artifacts are generated.

## Commands

List conflicts:

```bash
kanban-sync-engine reconcile --list
```

Generate/update conflict doc for one task:

```bash
kanban-sync-engine reconcile T-002
```

Resolve with local content:

```bash
kanban-sync-engine reconcile T-002 --accept local
```

Resolve with remote content:

```bash
kanban-sync-engine reconcile T-002 --accept remote
```

Publish after resolving:

```bash
kanban-sync-engine push
kanban-sync-engine status
```

## Guardrails

- If task matching is ambiguous, stop and ask for one explicit mapping decision.
- Do not apply destructive resolution automatically.
