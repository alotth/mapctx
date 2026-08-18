# DependencyEdge direction semantics

`DependencyEdge` (`packages/protocol/src/entities.ts`) has two kinds, and they are opposite
directions of the same relation, not the same edge read two ways:

- `{ fromTaskId, toTaskId, kind: "blocks" }` — `fromTaskId` blocks `toTaskId`. `toTaskId` waits
  on `fromTaskId`.
- `{ fromTaskId, toTaskId, kind: "depends-on" }` — `fromTaskId` depends on `toTaskId`.
  `fromTaskId` waits on `toTaskId`.

A consumer that walks edges to build a "must wait on" map needs a separate branch per kind:

```ts
for (const edge of edges) {
  if (edge.kind === "blocks") waitsOn.get(edge.toTaskId)?.add(edge.fromTaskId);
  else if (edge.kind === "depends-on") waitsOn.get(edge.fromTaskId)?.add(edge.toTaskId);
}
```

Collapsing both kinds into one branch (treating `depends-on` like `blocks`) inverts the
`depends-on` direction: it makes the task that has a dependency schedule *before* the
dependency instead of after it, which can also fabricate a dependency cycle between two tasks
that have no real cycle. This is what T-063 fixed in `packages/planner/src/index.ts`.

## Single source of truth

When a caller has both a task's `dependsOn` list and the equivalent `dependencyEdges`, send only
one to the planner (`@mapctx/planner`'s `planExecution`) — not both. `packages/sync-engine/src/mapctx-cli.ts`'s
`mapctx plan` command sends `dependencyEdges` only, for both the TASKS.md-backed fallback and the
store-backed path, so the two representations cannot drift apart from each other.
