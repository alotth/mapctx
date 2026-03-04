export type TaskStatus = "backlog" | "doing" | "review" | "done" | "paused" | "unknown"

export { parseTaskDetailMarkdown, generateTaskDetailMarkdown, type TaskDetail, type TaskStep } from "./detail"

export function normalizeStatus(value: string | undefined | null): TaskStatus {
  const status = String(value || "").trim().toLowerCase()
  if (status === "backlog" || status === "doing" || status === "review" || status === "done" || status === "paused") {
    return status
  }
  return "unknown"
}

export function normalizeStatusLoose(value: string | undefined | null): string {
  return String(value || "").trim().toLowerCase()
}

export function parseArray(value: string): string[] {
  const match = value.trim().match(/^\[(.*)\]$/)
  if (!match) return []
  const inner = match[1].trim()
  if (!inner) return []
  return inner.split(",").map((item) => item.trim()).filter(Boolean)
}

export function toArrayString(items?: string[]): string {
  if (!items || items.length === 0) return "[]"
  return `[${items.join(", ")}]`
}

export function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

export function renderMarkdownToHtml(source: string): string {
  const lines = String(source || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const html: string[] = []
  let paragraph: string[] = []
  let inCode = false
  let codeLang = ""
  let codeLines: string[] = []
  let inUl = false
  let inOl = false
  let inQuote = false

  const flushParagraph = () => {
    if (!paragraph.length) return
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`)
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
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
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
      paragraph.push(trimmed.replace(/^>\s?/, ""))
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
      const checked = checklist[1].toLowerCase() === "x" ? " checked" : ""
      html.push(`<li class="check${checked}">${renderInlineMarkdown(checklist[2])}</li>`)
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
      html.push(`<li>${renderInlineMarkdown(ul[1])}</li>`)
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
      html.push(`<li>${renderInlineMarkdown(ol[1])}</li>`)
      continue
    }

    paragraph.push(trimmed)
  }

  if (inCode) {
    html.push(`<pre><code class="lang-${escapeHtml(codeLang || "plain")}">${escapeHtml(codeLines.join("\n"))}</code></pre>`)
  }
  flushParagraph()
  closeUl()
  closeOl()
  closeQuote()
  return html.join("")
}
