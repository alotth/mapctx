export type TaskStep = {
  text: string
  completed: boolean
}

export type TaskDetail = {
  steps?: TaskStep[]
  description?: string
}

export function parseTaskDetailMarkdown(content: string): TaskDetail {
  const lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const steps: TaskStep[] = []
  const descriptionLines: string[] = []
  let inSteps = false
  let inDescription = false
  let inCodeBlock = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (inCodeBlock && inDescription) {
      if (trimmedLine === "```") {
        inCodeBlock = false
        inDescription = false
        continue
      }
      descriptionLines.push(line.replace(/^\s{4,}/, ""))
      continue
    }

    if (/^\s+- steps:\s*$/.test(line)) {
      inSteps = true
      continue
    }

    if (inSteps) {
      const stepMatch = line.match(/^\s{6,}- \[([ x])\]\s*(.*)$/)
      if (stepMatch) {
        const checkmark = stepMatch[1]
        const text = stepMatch[2]
        steps.push({ text: text.trim(), completed: checkmark === "x" })
        continue
      }
      if (trimmedLine === "") {
        continue
      }
      inSteps = false
    }

    if (/^\s+```md/.test(line) || /^\s+```/.test(line)) {
      inDescription = true
      inCodeBlock = true
      continue
    }
  }

  const detail: TaskDetail = {}
  if (steps.length > 0) detail.steps = steps
  if (descriptionLines.length > 0) detail.description = descriptionLines.join("\n").trim()
  return detail
}

export function generateTaskDetailMarkdown(task: { id?: string; steps?: TaskStep[]; description?: string }): string {
  const headerId = task.id ? task.id : "Task"
  let markdown = `# ${headerId}\n\n`

  if (task.steps && task.steps.length > 0) {
    markdown += "  - steps:\n"
    for (const step of task.steps) {
      const checkbox = step.completed ? "[x]" : "[ ]"
      markdown += `      - ${checkbox} ${step.text}\n`
    }
  }

  if (task.description && task.description.trim() !== "") {
    markdown += "    ```md\n"
    const descriptionLines = task.description.trim().split("\n")
    for (const descLine of descriptionLines) {
      markdown += `    ${descLine}\n`
    }
    markdown += "    ```\n"
  }

  return markdown.trimEnd() + "\n"
}
