let board = { title: "Tasks", columns: [], tasks: [], mode: "v2-status" }
let activeView = "kanban"
let zoomPreset = "month"
let roadmapRange = null
let roadmapLayout = null
let roadmapAutoCentered = false
const ROADMAP_GROUP_MODES = ["epic", "status", "milestone"]
let roadmapGroupMode = "epic"
const expanded = new Set()
const detailCache = new Map()
const taskById = new Map()
const subtasksByParent = new Map()
const collapsedEpicIds = new Set()

const STATUS_ORDER = ["backlog", "doing", "review", "done", "paused", "unknown"]
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const RANGE_PADDING_DAYS = 7
const DEFAULT_DURATION_DAYS = 7
const MIN_DAY_WIDTH_PX = 6
const MAX_DAY_WIDTH_PX = 16
const ZOOM_LEVELS = {
  month: { months: 1, scale: 1.25 },
  quarter: { months: 3, scale: 1 },
  year: { months: 12, scale: 0.82 },
}

const params = new URLSearchParams(window.location.search)
const source = {
  directory: params.get("directory") || "",
  tasksFile: params.get("tasksFile") || "TASKS.md",
}

function collapsedEpicsStorageKey() {
  return `kanban-roadmap:collapsed-epics:${source.tasksFile}`
}

function restoreCollapsedEpics() {
  try {
    const raw = window.localStorage.getItem(collapsedEpicsStorageKey())
    if (!raw) return
    const values = JSON.parse(raw)
    if (!Array.isArray(values)) return
    for (const item of values) {
      const id = normalizeTaskId(item)
      if (id) collapsedEpicIds.add(id)
    }
  } catch {
    // ignore storage parse issues
  }
}

function persistCollapsedEpics() {
  try {
    window.localStorage.setItem(collapsedEpicsStorageKey(), JSON.stringify([...collapsedEpicIds]))
  } catch {
    // ignore storage write issues
  }
}

restoreCollapsedEpics()

const BRIDGE_TIMEOUT = 1500
let bridgeToken = ""
let bridgeReadyResolve = null
const bridgeReady = new Promise((resolve) => {
  bridgeReadyResolve = resolve
})

window.addEventListener("message", (event) => {
  const message = event.data
  if (!message || message.type !== "opencode.bridge.host") return
  if (typeof message.token !== "string") return
  bridgeToken = message.token
  if (bridgeReadyResolve) {
    bridgeReadyResolve(true)
    bridgeReadyResolve = null
  }
})

async function ensureBridgeToken() {
  if (bridgeToken) return bridgeToken
  const timeout = new Promise((resolve) => window.setTimeout(() => resolve(false), BRIDGE_TIMEOUT))
  await Promise.race([bridgeReady, timeout])
  if (!bridgeToken) throw new Error("No bridge token available")
  return bridgeToken
}

function normalizeStatus(value) {
  if (window.KanbanCore && typeof window.KanbanCore.normalizeStatus === "function") {
    return window.KanbanCore.normalizeStatus(value)
  }
  const status = String(value || "").trim().toLowerCase()
  if (status === "todo" || status === "to-do" || status === "pending") return "backlog"
  if (status === "in_progress" || status === "in-progress" || status === "wip") return "doing"
  if (status === "in_review" || status === "in-review" || status === "qa") return "review"
  if (status === "completed" || status === "complete") return "done"
  if (status === "on_hold" || status === "on-hold" || status === "blocked") return "paused"
  if (["backlog", "doing", "review", "done", "paused"].includes(status)) return status
  return "unknown"
}

function parseArray(value) {
  if (window.KanbanCore && typeof window.KanbanCore.parseArray === "function") {
    return window.KanbanCore.parseArray(value)
  }
  const text = String(value || "").trim()
  const match = text.match(/^\[(.*)\]$/)
  if (!match) return []
  const inner = match[1].trim()
  if (!inner) return []
  return inner
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
}

function parseTasksV2(content) {
  if (window.KanbanCore && typeof window.KanbanCore.parseTasksV2 === "function") {
    return window.KanbanCore.parseTasksV2(content)
  }
  const lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const title = (lines.find((line) => line.startsWith("# ")) || "# Tasks").replace(/^#\s+/, "").trim()
  const marker = lines.findIndex((line) => /^##\s+Tasks\s*$/.test(line.trim()))
  const start = marker >= 0 ? marker + 1 : 0
  const tasks = []
  let i = start

  while (i < lines.length) {
    const line = lines[i] || ""
    const trimmed = line.trim()
    if (/^##\s+/.test(trimmed) && !/^##\s+Tasks\s*$/.test(trimmed)) break
    if (!/^###\s+/.test(trimmed)) {
      i += 1
      continue
    }

    const heading = trimmed.replace(/^###\s+/, "")
    const match = heading.match(/^\[([^\]]+)\]\s*(.*)$/)
      const task = {
        id: (match && match[1].trim()) || `T-${String(tasks.length + 1).padStart(3, "0")}`,
        title: (match && match[2].trim()) || heading,
        status: "unknown",
        domains: [],
        dependsOn: [],
        completed: "",
      }

    i += 1
    while (i < lines.length) {
      const row = (lines[i] || "").trim()
      if (/^###\s+/.test(row)) break
      if (/^##\s+/.test(row) && !/^##\s+Tasks\s*$/.test(row)) break
      const prop = row.match(/^-\s+([A-Za-z0-9_]+):\s*(.*)$/)
      if (prop) {
        const key = prop[1]
        const value = (prop[2] || "").trim()
        if (key === "id" && value) task.id = value
        if (key === "status") task.status = normalizeStatus(value)
        if (key === "type") task.type = value
        if (key === "parent" && value !== "null") task.parent = value
        if (key === "subIssueProgress" && value !== "null") task.subIssueProgress = value
        if (key === "priority") task.priority = value
        if (key === "workload") task.workload = value
        if (key === "domains") task.domains = parseArray(value)
        if (key === "touch" && (!task.domains || task.domains.length === 0)) task.domains = parseArray(value)
        if (key === "dependsOn") task.dependsOn = parseArray(value)
        if (key === "start") task.startDate = value
        if (key === "due") task.dueDate = value
        if (key === "updated") task.updated = value
        if (key === "completed" && value !== "null") task.completed = value
        if (key === "detail") task.detailPath = value
        if (key === "milestone") task.milestone = value
        if (key === "externalId" && value !== "null") task.externalId = value
      }
      i += 1
    }
    tasks.push(task)
  }

  const order = ["backlog", "doing", "review", "done", "paused", "unknown"]
  const grouped = new Map(order.map((status) => [status, []]))
  for (const task of tasks) grouped.get(task.status)?.push(task)
  const columns = order
    .map((status) => ({
      id: `status:${status}`,
      title: status.charAt(0).toUpperCase() + status.slice(1),
      tasks: grouped.get(status) || [],
    }))
    .filter((col) => col.tasks.length > 0)

  return { title, mode: "v2-status", tasks, columns }
}

async function requestBridge(action, payload) {
  if (window.parent === window) return Promise.reject(new Error("No parent bridge available"))
  const token = await ensureBridgeToken()

  return new Promise((resolve, reject) => {
    const id = `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error("Bridge timeout"))
    }, BRIDGE_TIMEOUT)

    const onMessage = (event) => {
      const message = event.data
      if (!message || message.type !== "opencode.bridge.response" || message.requestId !== id) return
      cleanup()
      if (message.ok === false) {
        reject(new Error(message.error || "Bridge request failed"))
        return
      }
      resolve(message.payload)
    }

    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener("message", onMessage)
    }

    window.addEventListener("message", onMessage)
    window.parent.postMessage(
      {
        type: "opencode.bridge.request",
        requestId: id,
        action,
        token,
        payload,
      },
      "*",
    )
  })
}

function log(message, variant = "") {
  const el = document.getElementById("log-view")
  if (!el) return
  const hidden = activeView === "roadmap" ? " hidden" : ""
  el.className = `log-view ${variant}${hidden}`.trim()
  el.textContent = message
}

function setView(view) {
  activeView = view
  const isRoadmap = view === "roadmap"
  document.getElementById("tab-kanban").classList.toggle("active", view === "kanban")
  document.getElementById("tab-roadmap").classList.toggle("active", isRoadmap)
  document.getElementById("kanban-view").classList.toggle("active", view === "kanban")
  document.getElementById("roadmap-view").classList.toggle("active", isRoadmap)
  const logView = document.getElementById("log-view")
  if (logView) logView.classList.toggle("hidden", isRoadmap)
  document.getElementById("zoom-controls").classList.toggle("hidden", !isRoadmap)
  updateZoomPresetUI()
  updateGroupButtons()
  if (isRoadmap) {
    roadmapAutoCentered = false
    renderRoadmap()
  }
}

function renderKanban() {
  const root = document.getElementById("kanban-view")
  if (!board.columns?.length) {
    root.innerHTML = '<p class="empty">No columns found.</p>'
    return
  }
  root.innerHTML = `<div class="kanban-grid">${board.columns
    .map((col) => {
      const cards = (col.tasks || [])
        .map((task) => {
          const isExpanded = expanded.has(task.id)
          const meta = [
            task.type ? `<span class="pill pill-type">${escapeHtml(task.type)}</span>` : "",
            task.priority ? `<span class="pill">${escapeHtml(task.priority)}</span>` : "",
            task.workload ? `<span class="pill">${escapeHtml(task.workload)}</span>` : "",
            task.dueDate ? `<span class="pill">Due ${escapeHtml(task.dueDate)}</span>` : "",
          ]
            .filter(Boolean)
            .join("")
          return `<article class="card ${isExpanded ? "expanded" : ""}" data-task-id="${task.id}"><button class="card-head" data-expand-task="${task.id}" type="button"><span class="card-title">[${task.id}] ${escapeHtml(task.title || "")}</span><span class="expander">${isExpanded ? "Hide" : "Show"}</span></button><div class="card-meta">${meta}</div>${isExpanded ? renderTaskDetails(task) : ""}</article>`
        })
        .join("")
      return `<section class="col"><div class="col-head"><h3>${col.title}</h3><span class="count">${(col.tasks || []).length}</span></div><div class="cards">${cards || '<p class="empty">No tasks</p>'}</div></section>`
    })
    .join("")}</div>`
}

function renderRoadmap() {
  const root = document.getElementById("roadmap-view")
  const tasks = normalizeRoadmapTasks(board.tasks || [])
  if (!tasks.length) {
    root.innerHTML = '<p class="empty">No tasks with dates found.</p>'
    roadmapRange = null
    roadmapLayout = null
    roadmapAutoCentered = false
    return
  }
  const range = getDateRange(tasks)
  root.innerHTML = `<div class="roadmap-surface"><div class="timeline"><div class="timeline-header"><div class="timeline-label">Task</div><div class="timeline-grid">${renderTicks(range)}</div></div>${renderGroups(tasks, range)}</div></div>`
  const layout = computeTimelineLayout(range)
  roadmapRange = range
  roadmapLayout = layout
  const timeline = root.querySelector(".timeline")
  if (timeline) timeline.style.width = `${layout.totalWidth}px`
  addTodayMarker(timeline, range, layout)
  const surface = root.querySelector(".roadmap-surface")
  if (surface) bindRoadmapSurface(surface)
  if (activeView === "roadmap") {
    if (!roadmapAutoCentered) {
      centerToday(false)
      roadmapAutoCentered = true
    }
    return
  }
  roadmapAutoCentered = false
}

function renderAll() {
  rebuildTaskRelations()
  document.getElementById("board-title").textContent = board.title || "Tasks"
  document.getElementById("board-mode").textContent = `Model: ${board.mode || "v2-status"}`
  document.getElementById("board-meta").textContent = `${board.tasks?.length || 0} tasks - ${source.tasksFile}`
  renderKanban()
  renderRoadmap()
}

function normalizeTaskId(value) {
  const text = String(value || "").trim()
  return text || ""
}

function rebuildTaskRelations() {
  taskById.clear()
  subtasksByParent.clear()
  for (const task of board.tasks || []) {
    const id = normalizeTaskId(task.id)
    if (!id) continue
    taskById.set(id, task)
  }
  for (const task of board.tasks || []) {
    const parentId = normalizeTaskId(task.parent)
    if (!parentId) continue
    if (!subtasksByParent.has(parentId)) subtasksByParent.set(parentId, [])
    subtasksByParent.get(parentId).push(task)
  }
}

function toggleTask(id) {
  if (expanded.has(id)) {
    expanded.delete(id)
    renderKanban()
    return
  }
  expanded.add(id)
  renderKanban()
}

function renderTaskLink(task) {
  if (!task || !task.id) return ""
  const label = `[${task.id}] ${task.title || ""}`.trim()
  return `<button type="button" class="task-ref-link" data-open-detail="${escapeHtml(task.id)}">${escapeHtml(label)}</button>`
}

function renderTaskDetails(task) {
  const parentTask = findTask(task.parent)
  const subtasks = (subtasksByParent.get(task.id) || []).filter((child) => child.id !== task.id)
  const rows = [
    ["Status", task.status],
    ["Type", task.type],
    ["Sub-issue", task.subIssueProgress],
    ["Priority", task.priority],
    ["Workload", task.workload],
    ["Start", task.startDate],
    ["Due", task.dueDate],
    ["Updated", task.updated],
    ["Completed", task.completed],
    ["External", task.externalId],
    ["Domains", task.domains?.join(", ")],
    ["Depends", task.dependsOn?.join(", ")],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`)
    .join("")
  const parentRow = task.parent
    ? `<div class="detail-row"><span>Parent</span>${parentTask ? renderTaskLink(parentTask) : `<strong>${escapeHtml(String(task.parent))}</strong>`}</div>`
    : ""
  const subtasksRow = subtasks.length
    ? `<div class="detail-row"><span>Subtasks</span><div class="detail-link-list">${subtasks.map((child) => renderTaskLink(child)).join("")}</div></div>`
    : ""
  const detailButton = task.detailPath
    ? `<div class="detail-row"><span>Detail</span><button type="button" class="detail-link" data-open-detail="${task.id}">Open</button></div>`
    : ""
  return `<div class="card-details">${rows || '<div class="detail-row"><span>Info</span><strong>No extra fields</strong></div>'}${parentRow}${subtasksRow}${detailButton}</div>`
}

function escapeHtml(value) {
  if (window.KanbanCore && typeof window.KanbanCore.escapeHtml === "function") {
    return window.KanbanCore.escapeHtml(value)
  }
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function parseDate(value) {
  if (!value) return
  const parts = String(value).split("-").map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function addDays(date, days) {
  return new Date(date.getTime() + days * ONE_DAY_MS)
}

function progressFromStatus(status) {
  if (status === "done") return 1
  if (status === "review") return 0.85
  if (status === "doing") return 0.55
  if (status === "paused") return 0.35
  if (status === "backlog") return 0.15
  return 0.25
}

function normalizeRoadmapTasks(list) {
  return list
    .map((task) => {
      let start = parseDate(task.startDate)
      const due = parseDate(task.dueDate)
      const completed = parseDate(task.completed)
      const updated = parseDate(task.updated)
      const end = completed || due || updated
      if (!start && !end) return
      if (!start && end) start = addDays(end, -DEFAULT_DURATION_DAYS)
      if (!start) return
      const safeEnd = end || addDays(start, DEFAULT_DURATION_DAYS)
      if (start.getTime() > safeEnd.getTime()) start = addDays(safeEnd, -DEFAULT_DURATION_DAYS)
      return {
        ...task,
        start,
        end: safeEnd,
        progress: progressFromStatus(task.status),
      }
    })
    .filter(Boolean)
}

function getDateRange(tasks) {
  let min = tasks.reduce((acc, task) => (task.start < acc ? task.start : acc), tasks[0].start)
  let max = tasks.reduce((acc, task) => (task.end > acc ? task.end : acc), tasks[0].end)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  if (today < min) min = today
  if (today > max) max = today
  const start = addDays(min, -RANGE_PADDING_DAYS)
  const end = addDays(max, RANGE_PADDING_DAYS + 1)
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  return { start, end }
}

function getPosition(date, range) {
  const span = range.end.getTime() - range.start.getTime()
  if (span <= 0) return 0
  return ((date.getTime() - range.start.getTime()) / span) * 100
}

function getWidth(start, end, range) {
  const span = range.end.getTime() - range.start.getTime()
  if (span <= 0) return 0
  return ((end.getTime() - start.getTime() + ONE_DAY_MS) / span) * 100
}

function renderTicks(range) {
  const monthTicks = []
  const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1)
  while (cursor <= range.end) {
    monthTicks.push({
      left: getPosition(cursor, range),
      label: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(cursor),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  const stepDays = getTickStepDays()
  const lines = buildDayGridLines(range, stepDays)
  const dayTicks = buildDayTicks(range, stepDays)
  return `${lines.map((tick) => `<div class="timeline-grid-line" style="left:${tick.left}%"></div>`).join("")}${monthTicks.map((tick) => `<div class="timeline-grid-label" style="left:${tick.left}%">${tick.label}</div>`).join("")}${dayTicks.map((tick) => `<div class="timeline-grid-label timeline-grid-label-day${tick.cls || ""}" style="left:${tick.left}%">${tick.label}</div>`).join("")}`
}

function getTickStepDays() {
  if (zoomPreset === "month") return 1
  if (zoomPreset === "quarter") return 7
  if (zoomPreset === "year") return 14
  return 7
}

function alignToStep(date, stepDays) {
  const cursor = new Date(date.getTime())
  cursor.setHours(0, 0, 0, 0)
  const day = cursor.getDay()
  if (stepDays === 7 || stepDays === 14) {
    const offset = day === 0 ? 1 : 8 - day
    cursor.setDate(cursor.getDate() + offset)
    return cursor
  }
  cursor.setDate(cursor.getDate() + 1)
  return cursor
}

function buildDayGridLines(range, stepDays) {
  const ticks = []
  const cursor = alignToStep(range.start, stepDays)
  while (cursor <= range.end) {
    ticks.push({ left: getPosition(cursor, range) })
    cursor.setDate(cursor.getDate() + stepDays)
  }
  return ticks
}

function isToday(date) {
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
}

function buildDayTicks(range, stepDays) {
  const ticks = []
  const cursor = alignToStep(range.start, stepDays)
  while (cursor <= range.end) {
    const label = zoomPreset === "month" ? String(cursor.getDate()) : `${cursor.getDate()}`
    const cls = isToday(cursor) ? " today" : ""
    ticks.push({ left: getPosition(cursor, range), label, cls })
    cursor.setDate(cursor.getDate() + stepDays)
  }
  return ticks
}

function normalizedType(task) {
  return String(task?.type || "").trim().toLowerCase()
}

function renderRoadmapTaskRow(task, range, index, options = {}) {
  const { child = false, epic = false, summary = "", childProgress = "" } = options
  const left = getPosition(task.start, range)
  const width = getWidth(task.start, task.end, range)
  const rowClass = [
    "task-row",
    index % 2 ? "task-row-alt" : "",
    child ? "task-row-child" : "",
    epic ? "task-row-epic" : "",
  ]
    .filter(Boolean)
    .join(" ")
  const tag = [task.statusKey, task.milestoneKey !== "No milestone" ? task.milestoneKey : ""]
    .filter(Boolean)
    .join(" • ")
  const isCollapsed = collapsedEpicIds.has(task.id)
  const marker = epic
    ? `<button type="button" class="epic-toggle" data-toggle-epic="${escapeHtml(task.id)}" aria-label="${isCollapsed ? "Expand epic" : "Collapse epic"}" title="${isCollapsed ? "Expand epic" : "Collapse epic"}"><span class="epic-toggle-icon${isCollapsed ? "" : " expanded"}" aria-hidden="true"></span></button>`
    : ""
  const openButton = `<button type="button" class="task-open-link" data-open-detail="${escapeHtml(task.id)}"><span class="task-id">[${escapeHtml(task.id)}]</span> ${escapeHtml(task.title)}</button>`
  const subtitle = [summary, tag, childProgress].filter(Boolean).join(" • ")
  return `<div class="${rowClass}"><div class="task-label"><div class="task-title-line">${marker}${openButton}</div><div class="task-status">${escapeHtml(subtitle)}</div></div><div class="task-bar-area"><div class="task-bar" style="left:${left}%;width:${width}%" title="${escapeHtml(`${task.title} (${task.startDate || "?"} -> ${task.dueDate || task.completed || task.updated || "?"})`)}"><div class="task-bar-progress" style="width:${Math.round(task.progress * 100)}%"></div></div></div></div>`
}

function renderStandardGroups(tasks, range, mode) {
  const groups = []
  if (mode === "status") {
    for (const status of STATUS_ORDER) {
      const items = tasks.filter((task) => task.statusKey === status)
      if (!items.length) continue
      groups.push({ title: status.charAt(0).toUpperCase() + status.slice(1), items })
    }
  } else {
    const keys = [...new Set(tasks.map((task) => task.milestoneKey))]
      .sort((a, b) => {
        if (a === "No milestone") return 1
        if (b === "No milestone") return -1
        return a.localeCompare(b)
      })
    for (const key of keys) {
      const items = tasks.filter((task) => task.milestoneKey === key)
      if (!items.length) continue
      groups.push({ title: key, items })
    }
  }

  return groups
    .map((group) => {
      const rows = group.items.map((task, idx) => renderRoadmapTaskRow(task, range, idx)).join("")
      return `<div class="milestone-group"><div class="milestone-header"><div class="milestone-label">${escapeHtml(group.title)}</div><div class="milestone-line"></div></div>${rows}</div>`
    })
    .join("")
}

function buildEpicRows(tasks) {
  const taskByRoadmapId = new Map(tasks.map((task) => [normalizeTaskId(task.id), task]))
  const epicEntries = new Map()
  const childrenByEpic = new Map()

  for (const task of tasks) {
    if (normalizedType(task) === "epic") {
      epicEntries.set(task.id, { ...task })
    }
  }

  for (const task of tasks) {
    const parentId = normalizeTaskId(task.parent)
    if (!parentId) continue
    const parentTask = findTask(parentId)
    if (!parentTask || normalizedType(parentTask) !== "epic") continue
    if (!epicEntries.has(parentId)) {
      const fallback = taskByRoadmapId.get(parentId)
      epicEntries.set(parentId, {
        ...(fallback || parentTask),
        id: parentId,
        title: (fallback || parentTask).title || parentId,
        statusKey: normalizeStatus((fallback || parentTask).status),
        milestoneKey: (fallback || parentTask).milestone && String((fallback || parentTask).milestone).trim() ? String((fallback || parentTask).milestone).trim() : "No milestone",
        progress: progressFromStatus(normalizeStatus((fallback || parentTask).status)),
      })
    }
    if (!childrenByEpic.has(parentId)) childrenByEpic.set(parentId, [])
    childrenByEpic.get(parentId).push(task)
  }

  const epics = []
  for (const [epicId, epic] of epicEntries.entries()) {
    const children = (childrenByEpic.get(epicId) || []).sort((a, b) => a.start.getTime() - b.start.getTime())
    const firstChild = children[0]
    const start = epic.start || (firstChild ? firstChild.start : null)
    const end = epic.end || (children.length ? children.reduce((latest, child) => (child.end > latest ? child.end : latest), children[0].end) : null)
    if (!start || !end) continue
    const doneCount = children.filter((child) => child.statusKey === "done").length
    const childProgress = children.length ? `${doneCount}/${children.length} done` : ""
    const progress = children.length ? doneCount / children.length : epic.progress
    epics.push({ ...epic, id: epicId, start, end, progress, childProgress, children })
  }

  epics.sort((a, b) => a.start.getTime() - b.start.getTime())
  const epicIds = new Set(epics.map((epic) => epic.id))
  const standalone = tasks.filter((task) => {
    const parentId = normalizeTaskId(task.parent)
    return !parentId || !epicIds.has(parentId)
  })
  return { epics, standalone }
}

function renderEpicGroups(tasks, range) {
  const { epics, standalone } = buildEpicRows(tasks)
  const blocks = []

  if (epics.length) {
    const epicRows = []
    let rowIndex = 0
    for (const epic of epics) {
      epicRows.push(renderRoadmapTaskRow(epic, range, rowIndex, { epic: true, summary: "Epic", childProgress: epic.childProgress }))
      rowIndex += 1
      if (collapsedEpicIds.has(epic.id)) continue
      for (const child of epic.children) {
        epicRows.push(renderRoadmapTaskRow(child, range, rowIndex, { child: true }))
        rowIndex += 1
      }
    }
    blocks.push(`<div class="milestone-group"><div class="milestone-header"><div class="milestone-label">Epics</div><div class="milestone-line"></div></div>${epicRows.join("")}</div>`)
  }

  if (standalone.length) {
    const rows = standalone
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((task, idx) => renderRoadmapTaskRow(task, range, idx))
      .join("")
    blocks.push(`<div class="milestone-group"><div class="milestone-header"><div class="milestone-label">Standalone tasks</div><div class="milestone-line"></div></div>${rows}</div>`)
  }

  return blocks.join("")
}

function renderGroups(tasks, range) {
  const normalized = tasks.map((task) => ({
    ...task,
    statusKey: task.status || "unknown",
    milestoneKey: task.milestone && task.milestone.trim() ? task.milestone.trim() : "No milestone",
  }))
  if (roadmapGroupMode === "epic") return renderEpicGroups(normalized, range)
  if (roadmapGroupMode === "milestone") return renderStandardGroups(normalized, range, "milestone")
  return renderStandardGroups(normalized, range, "status")
}

function getLabelWidth() {
  return window.matchMedia && window.matchMedia("(max-width: 900px)").matches ? 180 : 260
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function getZoomConfig() {
  return ZOOM_LEVELS[zoomPreset] || ZOOM_LEVELS.month
}

function updateZoomPresetUI() {
  const input = document.getElementById("zoom-preset")
  if (!input) return
  input.value = zoomPreset
}

function updateGroupButtons() {
  if (!ROADMAP_GROUP_MODES.includes(roadmapGroupMode)) roadmapGroupMode = "epic"
  const epic = document.getElementById("btn-group-epic")
  if (epic) epic.classList.toggle("active", roadmapGroupMode === "epic")
  const status = document.getElementById("btn-group-status")
  if (status) status.classList.toggle("active", roadmapGroupMode === "status")
  const milestone = document.getElementById("btn-group-milestone")
  if (milestone) milestone.classList.toggle("active", roadmapGroupMode === "milestone")
}

function toggleGroupBy(key) {
  if (!ROADMAP_GROUP_MODES.includes(key)) return
  roadmapGroupMode = key
  updateGroupButtons()
  if (activeView === "roadmap") renderRoadmap()
}

function toggleEpicCollapse(id) {
  const epicId = normalizeTaskId(id)
  if (!epicId) return
  if (collapsedEpicIds.has(epicId)) {
    collapsedEpicIds.delete(epicId)
  } else {
    collapsedEpicIds.add(epicId)
  }
  persistCollapsedEpics()
  if (activeView === "roadmap") renderRoadmap()
}

function setZoomPreset(value) {
  if (!ZOOM_LEVELS[value]) return
  zoomPreset = value
  roadmapAutoCentered = false
  updateZoomPresetUI()
  if (activeView === "roadmap") renderRoadmap()
}

function bindRoadmapSurface(surface) {
  if (surface.dataset.bound === "1") return
  surface.dataset.bound = "1"
  surface.addEventListener(
    "wheel",
    (event) => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest(".task-label, .milestone-label, .timeline-label")) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      surface.scrollLeft += event.deltaY
      event.preventDefault()
    },
    { passive: false },
  )
}

function centerToday(smooth = true) {
  const surface = document.querySelector("#roadmap-view .roadmap-surface")
  if (!surface || !roadmapRange || !roadmapLayout) return
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  if (today < roadmapRange.start || today > roadmapRange.end) return
  const span = roadmapRange.end.getTime() - roadmapRange.start.getTime()
  if (span <= 0) return
  const gridWidth = Math.max(0, roadmapLayout.totalWidth - roadmapLayout.labelWidthPx)
  const progress = (today.getTime() - roadmapRange.start.getTime()) / span
  const px = roadmapLayout.labelWidthPx + progress * gridWidth
  const target = Math.max(0, px - surface.clientWidth / 2)
  surface.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" })
}

function scrollRoadmap(direction) {
  const surface = document.querySelector("#roadmap-view .roadmap-surface")
  if (!surface) return
  const step = Math.max(220, Math.round(surface.clientWidth * 0.55))
  surface.scrollBy({ left: step * direction, behavior: "smooth" })
}

function computeTimelineLayout(range) {
  const surface = document.querySelector("#roadmap-view .roadmap-surface")
  const labelWidthPx = getLabelWidth()
  const surfaceWidth = Math.max(320, surface ? surface.clientWidth : window.innerWidth)
  const availableWidth = Math.max(320, surfaceWidth - labelWidthPx - 16)
  const totalDays = Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / ONE_DAY_MS))
  const config = getZoomConfig()
  const monthWindowDays = config.months * 31
  const visibleDays = Math.min(totalDays, monthWindowDays)
  const baseDayWidth = clamp(availableWidth / visibleDays, MIN_DAY_WIDTH_PX, MAX_DAY_WIDTH_PX)
  const dayWidth = baseDayWidth * config.scale
  const totalWidth = Math.max(surfaceWidth, labelWidthPx + totalDays * dayWidth)
  return { labelWidthPx, totalWidth }
}

function addTodayMarker(timeline, range, layout) {
  if (!timeline) return
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const start = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate(), 0, 0, 0, 0)
  const end = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate(), 0, 0, 0, 0)
  if (today < start || today > end) return
  const span = end.getTime() - start.getTime()
  const gridWidthPx = Math.max(0, layout.totalWidth - layout.labelWidthPx)
  const progress = span > 0 ? (today.getTime() - start.getTime()) / span : 0
  const leftPx = layout.labelWidthPx + progress * gridWidthPx
  timeline.insertAdjacentHTML(
    "beforeend",
    `<div class="today-line" style="left:${leftPx}px"></div><div class="today-badge" style="left:${leftPx}px">Today</div>`,
  )
}

function findTask(id) {
  const key = normalizeTaskId(id)
  if (!key) return
  const task = taskById.get(key)
  if (task) return task
  for (const col of board.columns || []) {
    const match = (col.tasks || []).find((item) => normalizeTaskId(item.id) === key)
    if (match) return match
  }
}

function normalizePath(path) {
  if (!path) return ""
  return String(path).trim().replaceAll("\\", "/")
}

function dirname(path) {
  const value = normalizePath(path)
  const parts = value.split("/")
  parts.pop()
  return parts.join("/")
}

function joinPath(base, child) {
  const root = normalizePath(base)
  const leaf = normalizePath(child)
  if (!leaf.startsWith(".")) return leaf
  const parts = root.split("/").filter(Boolean)
  for (const piece of leaf.split("/")) {
    if (!piece || piece === ".") continue
    if (piece === "..") {
      parts.pop()
      continue
    }
    parts.push(piece)
  }
  return `${root.startsWith("/") ? "/" : ""}${parts.join("/")}`
}

function resolveDetailPath(detailPath) {
  const leaf = normalizePath(detailPath)
  if (!leaf) return ""
  if (!leaf.startsWith(".")) return leaf
  return joinPath(dirname(source.tasksFile), leaf)
}

function detailPathCandidates(detailPath) {
  const raw = normalizePath(detailPath)
  const resolved = resolveDetailPath(detailPath)
  const candidates = [resolved, raw]
  if (raw.startsWith("./")) {
    candidates.push(raw.slice(2))
  } else if (raw) {
    candidates.push(`./${raw}`)
  }
  return [...new Set(candidates.filter(Boolean))]
}

function supportsLocalApiFallback() {
  return window.location.protocol === "http:" || window.location.protocol === "https:"
}

function extractLooseDescription(lines) {
  const output = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (output.length && output[output.length - 1] !== "") output.push("")
      continue
    }
    if (/^#\s+\S+/.test(trimmed)) continue
    if (/^-\s+[A-Za-z][A-Za-z0-9]*:\s*/.test(trimmed)) continue
    output.push(line.replace(/^\s{2,}/, ""))
  }
  while (output[0] === "") output.shift()
  while (output[output.length - 1] === "") output.pop()
  return output.join("\n")
}

function parseDetail(content) {
  const text = String(content || "")
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const summaryMatch = text.match(/^\s*-\s+summary:\s*(.+)$/m)
  const summary = summaryMatch ? summaryMatch[1].trim() : ""
  let description = ""

  for (let i = 0; i < lines.length; i += 1) {
    const marker = lines[i].match(/^(\s*)-\s+description:\s*\|\s*$/)
    if (!marker) continue
    const baseIndent = marker[1].length
    const blockLines = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextLine = lines[j]
      const nextLineIndent = (nextLine.match(/^\s*/) || [""])[0].length
      if (/^\s*-\s+[A-Za-z][A-Za-z0-9]*:\s*/.test(nextLine) && nextLineIndent <= baseIndent) {
        i = j - 1
        break
      }
      if (nextLine.trim() === "") {
        blockLines.push("")
        i = j
        continue
      }
      const minimumIndent = baseIndent + 2
      blockLines.push(nextLine.slice(nextLineIndent >= minimumIndent ? minimumIndent : 0))
      i = j
    }
    description = blockLines.join("\n").replace(/\s+$/, "")
    break
  }

  if (!description) {
    description = extractLooseDescription(lines)
  }

  const steps = description
    .split("\n")
    .map((line) => line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/))
    .filter(Boolean)
    .map((match) => ({ done: match[1].toLowerCase() === "x", text: match[2].trim() }))

  return {
    steps,
    summary,
    description,
    html: description ? renderMarkdown(description) : "",
    raw: text,
  }
}

function renderInline(text) {
  if (window.KanbanCore && typeof window.KanbanCore.renderInlineMarkdown === "function") {
    return window.KanbanCore.renderInlineMarkdown(text)
  }
  const escaped = escapeHtml(text)
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

function renderMarkdown(source) {
  if (window.KanbanCore && typeof window.KanbanCore.renderMarkdownToHtml === "function") {
    return window.KanbanCore.renderMarkdownToHtml(source)
  }
  const lines = String(source || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const html = []
  let paragraph = []
  let inCode = false
  let codeLang = ""
  let codeLines = []
  let inUl = false
  let inOl = false
  let inQuote = false

  const flushParagraph = () => {
    if (!paragraph.length) return
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`)
    paragraph = []
  }
  const closeUl = () => {
    if (!inUl) return
    html.push("</ul>")
    inUl = false
  }
  const closeOl = () => {
    if (!inOl) return
    html.push("</ol>")
    inOl = false
  }
  const closeQuote = () => {
    if (!inQuote) return
    flushParagraph()
    closeUl()
    closeOl()
    html.push("</blockquote>")
    inQuote = false
  }

  for (const rawLine of lines) {
    const line = rawLine ?? ""
    const trimmed = line.trim()

    if (trimmed.startsWith("```")) {
      flushParagraph()
      closeUl()
      closeOl()
      closeQuote()
      if (!inCode) {
        inCode = true
        codeLang = trimmed.slice(3).trim()
        codeLines = []
        continue
      }
      html.push(`<pre><code class="lang-${escapeHtml(codeLang || "plain")}">${escapeHtml(codeLines.join("\n"))}</code></pre>`)
      inCode = false
      codeLang = ""
      codeLines = []
      continue
    }

    if (inCode) {
      codeLines.push(line)
      continue
    }

    if (!trimmed) {
      flushParagraph()
      closeUl()
      closeOl()
      closeQuote()
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeUl()
      closeOl()
      closeQuote()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph()
      closeUl()
      closeOl()
      closeQuote()
      html.push("<hr />")
      continue
    }

    if (trimmed.startsWith(">")) {
      flushParagraph()
      closeUl()
      closeOl()
      if (!inQuote) {
        html.push("<blockquote>")
        inQuote = true
      }
      const quoteLine = trimmed.replace(/^>\s?/, "")
      paragraph.push(quoteLine)
      continue
    }

    const checklist = trimmed.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/)
    if (checklist) {
      flushParagraph()
      closeOl()
      closeQuote()
      if (!inUl) {
        html.push('<ul class="md-checklist">')
        inUl = true
      }
      const mark = checklist[1].toLowerCase() === "x" ? " checked" : ""
      html.push(`<li class="check${mark}">${renderInline(checklist[2])}</li>`)
      continue
    }

    const ul = trimmed.match(/^[-*+]\s+(.+)$/)
    if (ul) {
      flushParagraph()
      closeOl()
      closeQuote()
      if (!inUl) {
        html.push("<ul>")
        inUl = true
      }
      html.push(`<li>${renderInline(ul[1])}</li>`)
      continue
    }

    const ol = trimmed.match(/^\d+\.\s+(.+)$/)
    if (ol) {
      flushParagraph()
      closeUl()
      closeQuote()
      if (!inOl) {
        html.push("<ol>")
        inOl = true
      }
      html.push(`<li>${renderInline(ol[1])}</li>`)
      continue
    }

    paragraph.push(trimmed)
  }

  if (inCode) html.push(`<pre><code class="lang-${escapeHtml(codeLang || "plain")}">${escapeHtml(codeLines.join("\n"))}</code></pre>`)
  flushParagraph()
  closeUl()
  closeOl()
  closeQuote()
  return html.join("")
}

async function loadTaskDetail(task) {
  const key = `${source.tasksFile}:${task.id}`
  if (detailCache.has(key)) return detailCache.get(key)
  if (!task.detailPath) return
  const candidates = detailPathCandidates(task.detailPath)
  let bridgeError = null
  for (const candidatePath of candidates) {
    try {
      const payload = await requestBridge("file.read", {
        path: candidatePath,
      })
      if (payload?.content) {
        const result = { path: payload.path || candidatePath, ...parseDetail(payload.content) }
        detailCache.set(key, result)
        return result
      }
    } catch (error) {
      bridgeError = error
    }
  }

  if (!supportsLocalApiFallback()) {
    if (bridgeError instanceof Error) throw bridgeError
    throw new Error("Unable to load detail file via bridge")
  }

  const preferredPath = candidates[0] || resolveDetailPath(task.detailPath)
  const query = new URLSearchParams({
    directory: source.directory,
    tasksFile: source.tasksFile,
    detailPath: preferredPath,
  })
  let response
  try {
    response = await fetch(`/api/task-detail?${query.toString()}`)
  } catch (error) {
    if (bridgeError instanceof Error) {
      throw new Error(`${bridgeError.message} (fallback failed: ${error instanceof Error ? error.message : String(error)})`)
    }
    throw error
  }
  if (!response.ok) throw new Error((await response.text()) || "Failed to load detail")
  const payload = await response.json()
  const result = { path: payload.path || task.detailPath, ...parseDetail(payload.content || "") }
  detailCache.set(key, result)
  return result
}

function closeModal() {
  const modal = document.getElementById("detail-modal")
  modal.classList.remove("open")
  modal.setAttribute("aria-hidden", "true")
}

function setModalContent(html) {
  document.getElementById("detail-modal-content").innerHTML = html
}

function renderModalRows(rows) {
  return rows
    .filter((row) => row && row.value)
    .map((row) => `<div class="modal-row"><span>${escapeHtml(row.label)}</span><strong${row.links ? ' class="modal-links"' : ""}>${row.links ? row.value : escapeHtml(String(row.value))}</strong></div>`)
    .join("")
}

function renderTaskIdLinks(ids) {
  const values = (ids || []).map((id) => normalizeTaskId(id)).filter(Boolean)
  if (!values.length) return ""
  return values
    .map((id) => {
      const match = findTask(id)
      return match ? renderTaskLink(match) : `<span class="task-ref-chip">${escapeHtml(id)}</span>`
    })
    .join("")
}

async function openTaskDetail(taskId) {
  const task = findTask(taskId)
  if (!task) return
  const modal = document.getElementById("detail-modal")
  const modalTitle = document.getElementById("detail-modal-title")
  if (modalTitle) modalTitle.textContent = `Task details - ${task.title || task.id}`
  modal.classList.add("open")
  modal.setAttribute("aria-hidden", "false")
  setModalContent('<p class="modal-empty">Loading details...</p>')

  const parentTask = findTask(task.parent)
  const subtasks = (subtasksByParent.get(task.id) || []).filter((child) => child.id !== task.id)
  const basicRows = renderModalRows([
    ["Task", `[${task.id}] ${task.title}`],
    ["Status", task.status],
    ["Type", task.type],
    ["Priority", task.priority],
    ["Workload", task.workload],
    ["Sub-issue", task.subIssueProgress],
  ].map(([label, value]) => ({ label, value })))
  const dateRows = renderModalRows([
    ["Start", task.startDate],
    ["Due", task.dueDate],
    ["Updated", task.updated],
    ["Completed", task.completed],
  ].map(([label, value]) => ({ label, value })))
  const relationRows = renderModalRows([
    {
      label: "Parent",
      value: task.parent ? (parentTask ? renderTaskLink(parentTask) : escapeHtml(String(task.parent))) : "",
      links: true,
    },
    {
      label: "Subtasks",
      value: subtasks.length ? subtasks.map((child) => renderTaskLink(child)).join("") : "",
      links: true,
    },
    {
      label: "Depends",
      value: renderTaskIdLinks(task.dependsOn),
      links: true,
    },
  ])
  const contextRows = renderModalRows([
    { label: "Domains", value: task.domains?.join(", ") },
    { label: "External", value: task.externalId },
  ])
  const infoGroups = [
    `<div class="modal-group"><h4>Overview</h4>${basicRows || '<p class="modal-empty">No overview data.</p>'}</div>`,
    dateRows ? `<div class="modal-group"><h4>Dates</h4>${dateRows}</div>` : "",
    relationRows ? `<div class="modal-group"><h4>Relations</h4>${relationRows}</div>` : "",
    contextRows ? `<div class="modal-group"><h4>Context</h4>${contextRows}</div>` : "",
  ]
    .filter(Boolean)
    .join("")
  const infoSection = `<section class="modal-section"><h3>Task info</h3><div class="modal-info-grid">${infoGroups}</div></section>`

  if (!task.detailPath) {
    setModalContent(`${infoSection}<section class="modal-section"><h3>Detail file</h3><p class="modal-empty">No detail file linked.</p></section>`)
    return
  }

  try {
    const detail = await loadTaskDetail(task)
    const summary = detail?.summary ? `<div class="modal-row"><span>Summary</span><strong>${escapeHtml(detail.summary)}</strong></div>` : ""
    const description = detail?.html
      ? `<div class="modal-description"><h4>Description</h4><div class="modal-markdown">${detail.html}</div></div>`
      : '<p class="modal-empty">No description found.</p>'
    const raw = detail?.raw
      ? `<details class="modal-debug"><summary>Debug: raw detail markdown</summary><pre class="modal-pre">${escapeHtml(detail.raw)}</pre></details>`
      : ""
    setModalContent(`${infoSection}<section class="modal-section"><h3>Detail file</h3><div class="modal-row"><span>Path</span><strong>${escapeHtml(detail?.path || task.detailPath)}</strong></div>${summary}${description}${raw}</section>`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setModalContent(`${infoSection}<section class="modal-section"><h3>Detail file</h3><p class="modal-error">${escapeHtml(message)}</p></section>`)
  }
}

async function loadBoard() {
  try {
    const payload = await requestBridge("file.read", { path: source.tasksFile })
    if (payload?.content) {
      board = parseTasksV2(payload.content)
      renderAll()
      return
    }
  } catch {
    // fall through to local API mode
  }

  const query = new URLSearchParams(source)
  const response = await fetch(`/api/workspace-v2?${query.toString()}`)
  if (!response.ok) throw new Error((await response.text()) || `Failed to load (${response.status})`)
  board = await response.json()
  renderAll()
}

async function runSync(action) {
  try {
    const payload = await requestBridge(`sync.${action}`, { tasksFile: source.tasksFile })
    log(payload?.output || `${action} ok`, payload?.ok === false ? "error" : "ok")
    return
  } catch {
    // fall back to local API server in standalone mode
  }

  const response = await fetch(`/api/kanban/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(source),
  })
  const data = await response.json().catch(() => ({ ok: false, output: "invalid response" }))
  if (!response.ok || !data.ok) {
    log(data.output || `Failed ${action}`, "error")
    return
  }
  log(data.output || `${action} ok`, "ok")
}

document.getElementById("tab-kanban").addEventListener("click", () => setView("kanban"))
document.getElementById("tab-roadmap").addEventListener("click", () => setView("roadmap"))
document.getElementById("zoom-preset").addEventListener("change", (event) => {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  setZoomPreset(target.value)
})
document.getElementById("btn-group-epic").addEventListener("click", () => toggleGroupBy("epic"))
document.getElementById("btn-group-status").addEventListener("click", () => toggleGroupBy("status"))
document.getElementById("btn-group-milestone").addEventListener("click", () => toggleGroupBy("milestone"))
document.getElementById("btn-today").addEventListener("click", () => centerToday(true))
document.getElementById("btn-scroll-left").addEventListener("click", () => scrollRoadmap(-1))
document.getElementById("btn-scroll-right").addEventListener("click", () => scrollRoadmap(1))
window.addEventListener("click", (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const epicToggle = target.closest("[data-toggle-epic]")
  const epicId = epicToggle ? epicToggle.getAttribute("data-toggle-epic") : null
  if (epicId) {
    toggleEpicCollapse(epicId)
    return
  }
  const trigger = target.closest("[data-expand-task]")
  const id = trigger ? trigger.getAttribute("data-expand-task") : null
  if (id) toggleTask(id)
  const detailTrigger = target.closest("[data-open-detail]")
  const detailId = detailTrigger ? detailTrigger.getAttribute("data-open-detail") : null
  if (detailId) {
    openTaskDetail(detailId).catch((error) => log(error.message, "error"))
  }
  const closeTrigger = target.closest("[data-close-modal='detail']")
  if (closeTrigger) closeModal()
})
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal()
})
window.addEventListener("resize", () => {
  if (activeView === "roadmap") {
    roadmapAutoCentered = false
    renderRoadmap()
  }
})

setView(activeView)
loadBoard().catch((error) => log(error.message, "error"))
