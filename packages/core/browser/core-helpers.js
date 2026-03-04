(function attachKanbanCore(globalObject) {
  function normalizeStatus(value) {
    var status = String(value || "").trim().toLowerCase()
    if (status === "backlog" || status === "doing" || status === "review" || status === "done" || status === "paused") {
      return status
    }
    return "unknown"
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
  }

  function renderInlineMarkdown(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  }

  function renderMarkdownToHtml(source) {
    var lines = String(source || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
    var html = []
    var paragraph = []
    var inCode = false
    var codeLang = ""
    var codeLines = []
    var inUl = false
    var inOl = false
    var inQuote = false

    function flushParagraph() {
      if (!paragraph.length) return
      html.push("<p>" + renderInlineMarkdown(paragraph.join(" ")) + "</p>")
      paragraph = []
    }

    function closeUl() {
      if (!inUl) return
      html.push("</ul>")
      inUl = false
    }

    function closeOl() {
      if (!inOl) return
      html.push("</ol>")
      inOl = false
    }

    function closeQuote() {
      if (!inQuote) return
      flushParagraph()
      closeUl()
      closeOl()
      html.push("</blockquote>")
      inQuote = false
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i] || ""
      var trimmed = line.trim()

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
        html.push("<pre><code class=\"lang-" + escapeHtml(codeLang || "plain") + "\">" + escapeHtml(codeLines.join("\n")) + "</code></pre>")
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

      var heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        flushParagraph()
        closeUl()
        closeOl()
        closeQuote()
        var level = heading[1].length
        html.push("<h" + level + ">" + renderInlineMarkdown(heading[2]) + "</h" + level + ">")
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

      var checklist = trimmed.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/)
      if (checklist) {
        flushParagraph()
        closeOl()
        closeQuote()
        if (!inUl) {
          html.push('<ul class="md-checklist">')
          inUl = true
        }
        var checked = checklist[1].toLowerCase() === "x" ? " checked" : ""
        html.push("<li class=\"check" + checked + "\">" + renderInlineMarkdown(checklist[2]) + "</li>")
        continue
      }

      var ul = trimmed.match(/^[-*+]\s+(.+)$/)
      if (ul) {
        flushParagraph()
        closeOl()
        closeQuote()
        if (!inUl) {
          html.push("<ul>")
          inUl = true
        }
        html.push("<li>" + renderInlineMarkdown(ul[1]) + "</li>")
        continue
      }

      var ol = trimmed.match(/^\d+\.\s+(.+)$/)
      if (ol) {
        flushParagraph()
        closeUl()
        closeQuote()
        if (!inOl) {
          html.push("<ol>")
          inOl = true
        }
        html.push("<li>" + renderInlineMarkdown(ol[1]) + "</li>")
        continue
      }

      paragraph.push(trimmed)
    }

    if (inCode) {
      html.push("<pre><code class=\"lang-" + escapeHtml(codeLang || "plain") + "\">" + escapeHtml(codeLines.join("\n")) + "</code></pre>")
    }
    flushParagraph()
    closeUl()
    closeOl()
    closeQuote()
    return html.join("")
  }

  function parseArray(value) {
    var text = String(value || "").trim()
    var match = text.match(/^\[(.*)\]$/)
    if (!match) return []
    var inner = match[1].trim()
    if (!inner) return []
    return inner
      .split(",")
      .map(function (item) {
        return item.trim()
      })
      .filter(Boolean)
  }

  function parseTasksV2(content) {
    var lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
    var title = (lines.find(function (line) { return line.startsWith("# ") }) || "# Tasks").replace(/^#\s+/, "").trim()
    var marker = lines.findIndex(function (line) { return /^##\s+Tasks\s*$/.test(line.trim()) })
    var start = marker >= 0 ? marker + 1 : 0
    var tasks = []
    var i = start

    while (i < lines.length) {
      var line = lines[i] || ""
      var trimmed = line.trim()
      if (/^##\s+/.test(trimmed) && !/^##\s+Tasks\s*$/.test(trimmed)) break
      if (!/^###\s+/.test(trimmed)) {
        i += 1
        continue
      }

      var heading = trimmed.replace(/^###\s+/, "")
      var match = heading.match(/^\[([^\]]+)\]\s*(.*)$/)
      var task = {
        id: (match && match[1].trim()) || "T-" + String(tasks.length + 1).padStart(3, "0"),
        title: (match && match[2].trim()) || heading,
        status: "unknown",
        touch: [],
        dependsOn: [],
        completed: "",
      }

      i += 1
      while (i < lines.length) {
        var row = (lines[i] || "").trim()
        if (/^###\s+/.test(row)) break
        if (/^##\s+/.test(row) && !/^##\s+Tasks\s*$/.test(row)) break
        var prop = row.match(/^-\s+([A-Za-z0-9_]+):\s*(.*)$/)
        if (prop) {
          var key = prop[1]
          var value = (prop[2] || "").trim()
          if (key === "id" && value) task.id = value
          if (key === "status") task.status = normalizeStatus(value)
          if (key === "type") task.type = value
          if (key === "parent" && value !== "null") task.parent = value
          if (key === "subIssueProgress" && value !== "null") task.subIssueProgress = value
          if (key === "priority") task.priority = value
          if (key === "workload") task.workload = value
          if (key === "touch") task.touch = parseArray(value)
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

    var order = ["backlog", "doing", "review", "done", "paused", "unknown"]
    var grouped = new Map(order.map(function (status) { return [status, []] }))
    tasks.forEach(function (task) {
      var list = grouped.get(task.status)
      if (list) list.push(task)
    })

    var columns = order
      .map(function (status) {
        return {
          id: "status:" + status,
          title: status.charAt(0).toUpperCase() + status.slice(1),
          tasks: grouped.get(status) || [],
        }
      })
      .filter(function (col) {
        return col.tasks.length > 0
      })

    return { title: title, mode: "v2-status", tasks: tasks, columns: columns }
  }

  globalObject.KanbanCore = {
    normalizeStatus: normalizeStatus,
    escapeHtml: escapeHtml,
    renderInlineMarkdown: renderInlineMarkdown,
    renderMarkdownToHtml: renderMarkdownToHtml,
    parseArray: parseArray,
    parseTasksV2: parseTasksV2,
  }
})(window)
