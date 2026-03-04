# OpenCode Kanban/Roadmap Plugin

This folder keeps the working OpenCode GUI plugin setup in the same repository as the VSCode extension, but isolated from extension sources.

## Files

- `kanban-roadmap.plugin.ts`: plugin config hook for OpenCode (`ui.session.tabs` and `ui.session.buttons`)
- `kanban-roadmap.js`: global plugin entry file (registers tab + tools)
- `src/`: source assets for the plugin tab UI
- `dist/`: build output copied from `src/` by the build script

Required plugin assets:

- `index.html`
- `kanban-roadmap.css`
- `kanban-roadmap.js`
- `core-helpers.js`

## Build

From repository root:

```bash
npm run build:opencode-plugin
```

## Install in global OpenCode plugins directory

From repository root:

```bash
npm run install:opencode-plugin
```

This installs files to:

```text
~/.config/opencode/plugins/kanban-roadmap/
```

And installs the plugin entry to:

```text
~/.config/opencode/plugins/kanban-roadmap.js
```

## Plugin `src` example

Use this path in the plugin tab config:

```text
/global/plugin/kanban-roadmap/index.html?tasksFile=TASKS.md
```

Suggested file permissions:

```text
permissions.file.read:  ["TASKS.md", "tasks/**/*.md"]
permissions.file.write: ["TASKS.md", "tasks/**/*.md"]
```

## Next step (planned): publish as package

Current strategy (active):

- Keep using local installer workflow:
  - `npm run build:opencode-plugin`
  - `npm run install:opencode-plugin`

Why:

- Fast local iteration and zero publish overhead.
- Works with current OpenCode setup.

Future strategy (planned):

- Publish this plugin as an npm package (for example `@scope/opencode-kanban-roadmap`).
- Use package reference in `~/.config/opencode/opencode.json` for friendlier plugin names in UI.
- Keep local installer as development fallback.
