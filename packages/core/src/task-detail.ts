import * as fs from "fs"

export type TaskDetailFile = {
  id: string
  role: string
  impact: string
  estimatedEffort: string
  prerequisites: string[]
  blocking: string[]
  filesAffected: string[]
  testsRequired: string[]
  summary: string
  description: string
}

const TOP_LEVEL_FIELD_RE = /^  - ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/
const DESCRIPTION_INDENT = "      "

function parseArray(value: string): string[] {
  const match = value.trim().match(/^\[(.*)\]$/)
  if (!match) return []
  const inner = match[1].trim()
  if (!inner) return []
  return inner.split(",").map(item => item.trim()).filter(Boolean)
}

function toArrayString(items: string[]): string {
  if (!items || items.length === 0) return "[]"
  return `[${items.join(", ")}]`
}

function stripDescriptionIndent(line: string): string {
  if (line.startsWith(DESCRIPTION_INDENT)) return line.slice(DESCRIPTION_INDENT.length)
  if (line.trim() === "") return ""
  return line
}

export function parseTaskDetailFile(content: string): TaskDetailFile {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")

  let id = ""
  let role = ""
  let impact = ""
  let estimatedEffort = ""
  let prerequisites: string[] = []
  let blocking: string[] = []
  let filesAffected: string[] = []
  let testsRequired: string[] = []
  let summary = ""
  const descriptionLines: string[] = []

  let inDescription = false
  let seenHeading = false

  for (const line of lines) {
    if (!seenHeading) {
      const trimmed = line.trim()
      if (trimmed.startsWith("# ")) {
        id = trimmed.slice(2).trim()
        seenHeading = true
      }
      continue
    }

    if (inDescription) {
      if (TOP_LEVEL_FIELD_RE.test(line)) {
        inDescription = false
      } else {
        descriptionLines.push(stripDescriptionIndent(line))
        continue
      }
    }

    const m = line.match(TOP_LEVEL_FIELD_RE)
    if (!m) continue
    const key = m[1]
    const value = m[2]

    switch (key) {
      case "role":
        role = value.trim()
        break
      case "impact":
        impact = value.trim()
        break
      case "estimatedEffort":
        estimatedEffort = value.trim()
        break
      case "prerequisites":
        prerequisites = parseArray(value)
        break
      case "blocking":
        blocking = parseArray(value)
        break
      case "filesAffected":
        filesAffected = parseArray(value)
        break
      case "testsRequired":
        testsRequired = parseArray(value)
        break
      case "summary":
        summary = value.trim()
        break
      case "description":
        inDescription = true
        break
      default:
        break
    }
  }

  while (descriptionLines.length > 0 && descriptionLines[descriptionLines.length - 1] === "") {
    descriptionLines.pop()
  }

  return {
    id,
    role,
    impact,
    estimatedEffort,
    prerequisites,
    blocking,
    filesAffected,
    testsRequired,
    summary,
    description: descriptionLines.join("\n")
  }
}

export function generateTaskDetailFile(detail: TaskDetailFile): string {
  const out: string[] = []
  out.push(`# ${detail.id}`)
  out.push("")
  out.push(`  - role: ${detail.role}`)
  out.push(`  - impact: ${detail.impact}`)
  out.push(`  - estimatedEffort: ${detail.estimatedEffort}`)
  out.push(`  - prerequisites: ${toArrayString(detail.prerequisites)}`)
  out.push(`  - blocking: ${toArrayString(detail.blocking)}`)
  out.push(`  - filesAffected: ${toArrayString(detail.filesAffected)}`)
  out.push(`  - testsRequired: ${toArrayString(detail.testsRequired)}`)
  out.push(`  - summary: ${detail.summary}`)
  out.push("  - description: |")
  const descriptionLines = detail.description.split("\n")
  for (const line of descriptionLines) {
    out.push(line === "" ? "" : `${DESCRIPTION_INDENT}${line}`)
  }

  return `${out.join("\n")}\n`
}

export function readTaskDetailFile(filePath: string): TaskDetailFile {
  return parseTaskDetailFile(fs.readFileSync(filePath, "utf8"))
}
