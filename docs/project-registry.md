# Project Registry

MapCtx uses two metadata layers:

- Global catalog: `~/.mapctx/projects.json`, or `$MAPCTX_HOME/projects.json` when `MAPCTX_HOME` is set.
- Project-local metadata: `<project>/.mapctx/project.json`, plus portable project assets, threads, and run summaries.

The global catalog answers: which organizations and projects exist on this computer?

The project-local `.mapctx` folder answers: what portable metadata belongs to this repo?

## Global Catalog

The global registry has two selectable target types:

- `organization`: a workspace container that may own its own `TASKS.md`.
- `project`: a child or standalone workspace that may also own its own `TASKS.md`.

Projects can be nested under an organization with `organizationId`.

```json
{
  "schemaVersion": 2,
  "activeTargetId": "project:mapctx",
  "organizations": [
    {
      "id": "local",
      "name": "Local",
      "accent": "#5bb5ff"
    }
  ],
  "projects": [
    {
      "id": "mapctx",
      "name": "mapctx",
      "organizationId": "local",
      "path": "/Users/alt/repos/mapctx",
      "tasksFile": "TASKS.md",
      "icon": ".mapctx/projects/mapctx/icon.svg",
      "accent": "#7cde9f"
    }
  ]
}
```

## First Run

`mapctx workspace` works from any directory. On startup it ensures the global catalog exists.

If the current directory, or one of its parents, has `TASKS.md`, the command registers that folder as a project automatically.

Explicit registration is also supported:

```bash
mapctx workspace /Users/alt/repos/mapctx
mapctx workspace:add /Users/alt/repos/mapctx --org local
```

The frontend receives the global catalog as `workspaceTargets[]`, ordered as organization followed by its projects. The browser should render that normalized list instead of deriving hierarchy from paths.
