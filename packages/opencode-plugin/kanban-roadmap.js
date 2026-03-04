export default async function KanbanRoadmapPlugin() {
  return {
    async config(input) {
      const cfg = input

      cfg.ui ??= {}
      cfg.ui.session ??= {}
      cfg.ui.session.tabs ??= []
      cfg.ui.session.buttons ??= []

      cfg.ui.session.tabs.push({
        id: "kanban-roadmap",
        title: "Tasks",
        src: "/global/plugin/kanban-roadmap/index.html?tasksFile=TASKS.md",
        origins: ["*"],
        permissions: {
          file: {
            read: ["TASKS.md", "tasks/**/*.md"],
            write: ["TASKS.md", "tasks/**/*.md"],
          },
        },
      })

      cfg.ui.session.buttons.push({
        id: "kanban-roadmap",
        label: "Tasks",
        tab: "kanban-roadmap",
      })
    },
  }
}
