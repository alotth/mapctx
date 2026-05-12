# Project Registry

MapCtx workspace navigation is described by `.mapctx/projects.json`.

The registry has two selectable target types:

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
      "path": ".",
      "tasksFile": "TASKS.md",
      "icon": ".mapctx/organizations/local/icon.svg",
      "accent": "#5bb5ff"
    }
  ],
  "projects": [
    {
      "id": "mapctx",
      "name": "mapctx",
      "organizationId": "local",
      "path": ".",
      "tasksFile": "TASKS.md",
      "icon": ".mapctx/projects/mapctx/icon.svg",
      "accent": "#7cde9f"
    }
  ]
}
```

The frontend receives this as `workspaceTargets[]`, ordered as organization followed by its projects. The browser should render that normalized list instead of deriving hierarchy from paths.
