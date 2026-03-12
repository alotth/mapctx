export type TaskStep = {
  text: string
  completed: boolean
}

export type TaskDetail = {
  summary?: string
  steps?: TaskStep[]
  description?: string
}

function extractChecklistSteps(markdown: string): TaskStep[] {
  return String(markdown || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ text: match[2].trim(), completed: match[1].toLowerCase() === "x" }))
}

export function parseTaskDetailMarkdown(content: string): TaskDetail {
  const lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  let summary: string | undefined
  let description: string | undefined

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const summaryMatch = line.match(/^\s*-\s*summary:\s*(.*)$/)
    if (summaryMatch) {
      const value = summaryMatch[1].trim()
      if (value !== "" && value !== "null") {
        summary = value
      }
      continue
    }

    const descriptionMatch = line.match(/^(\s*)-\s*description:\s*\|\s*$/)
    if (!descriptionMatch) continue

    const baseIndent = descriptionMatch[1].length
    const blockLines: string[] = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextLine = lines[j]
      const nextLineIndent = nextLine.match(/^\s*/)?.[0].length ?? 0
      if (/^\s*-\s*[A-Za-z][A-Za-z0-9]*:\s*/.test(nextLine) && nextLineIndent <= baseIndent) {
        i = j - 1
        break
      }

      if (nextLine.trim() === "") {
        blockLines.push("")
        i = j
        continue
      }

      const minimumIndent = baseIndent + 2
      const stripIndent = nextLineIndent >= minimumIndent ? minimumIndent : 0
      blockLines.push(nextLine.slice(stripIndent))
      i = j
    }

    const raw = blockLines.join("\n").replace(/\s+$/, "")
    if (raw.trim() !== "") {
      description = raw
    }
  }

  const detail: TaskDetail = {}
  if (summary) detail.summary = summary
  if (description) {
    detail.description = description
    const steps = extractChecklistSteps(description)
    if (steps.length > 0) detail.steps = steps
  }
  return detail
}

export function generateTaskDetailMarkdown(task: { id?: string; summary?: string; steps?: TaskStep[]; description?: string }): string {
  const headerId = task.id ? task.id : "Task"
  let markdown = `# ${headerId}\n\n`

  if (task.summary && task.summary.trim() !== "") {
    markdown += `  - summary: ${task.summary.trim()}\n`
  }

  let description = task.description?.trim() ?? ""
  if (!description && task.steps && task.steps.length > 0) {
    const generatedSteps = task.steps
      .map((step) => `- ${step.completed ? "[x]" : "[ ]"} ${step.text}`)
      .join("\n")
    description = `## Steps\n\n${generatedSteps}`
  }

  markdown += "  - description: |\n"
  if (description) {
    const descriptionLines = description.split("\n")
    for (const descriptionLine of descriptionLines) {
      markdown += `      ${descriptionLine}\n`
    }
  }

  return markdown.trimEnd() + "\n"
}
