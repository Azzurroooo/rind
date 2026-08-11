export function renderMarkdown(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n")
  const blocks: string[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`)
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(/^```([^`]*)\s*$/)
    if (fence) {
      flushParagraph()
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      blocks.push(renderCodeBlock(fence[1].trim(), code.join("\n")))
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      flushParagraph()
      blocks.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`)
      continue
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushParagraph()
      blocks.push("<hr>")
      continue
    }
    if (/^>\s?/.test(line)) {
      flushParagraph()
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""))
        index += 1
      }
      index -= 1
      blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`)
      continue
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/)
    if (unordered) {
      flushParagraph()
      const items = [unordered[1]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\s*[-+*]\s+(.+)$/)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`)
      continue
    }
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
    if (ordered) {
      flushParagraph()
      const start = Number(ordered[1])
      const items = [ordered[2]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\s*\d+[.)]\s+(.+)$/)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      const startAttribute = start === 1 ? "" : ` start=\"${start}\"`
      blocks.push(`<ol${startAttribute}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks.join("")
}

function renderCodeBlock(language: string, code: string) {
  return `<pre><div class=\"code-head\"><span>${escapeHtml(language || "code")}</span><button class=\"copy-code\" type=\"button\" data-copy=\"${escapeAttribute(code)}\">Copy</button></div><code>${escapeHtml(code)}</code></pre>`
}

function renderInline(value: string) {
  const tokens: string[] = []
  const token = (html: string) => {
    const key = `\u0000${tokens.length}\u0000`
    tokens.push(html)
    return key
  }
  const rendered = escapeHtml(value)
    .replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, href: string) => token(`<a href=\"${href}\" target=\"_blank\" rel=\"noreferrer\">${label}</a>`))
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^\w])([*_])(?=\S)([^\n]*?\S)\2/g, "$1<em>$3</em>")
    .replace(/\n/g, "<br>")
  return rendered.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || "")
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '\"': "&quot;",
  })[character] ?? character)
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}
