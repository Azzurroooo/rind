// Real diff view support (audit #12): unified diff text extracted from the
// tool RESULT (edit_file / write_file meta.files[].diff), ported from
// frontend-web/src/lib/toolDisplay.js extractDiffText. Requests without a
// result diff keep the argument-synthesized fallback in timeline-model.

export type DiffLineKind = "added" | "removed" | "context"
export type DiffLine = { kind: DiffLineKind; text: string }

const maxDiffLines = 120

export function extractDiffText(toolName: string, result?: { ok: boolean | null; meta: Record<string, unknown> }): string {
  if (toolName !== "edit_file" && toolName !== "write_file") return ""
  if (!result || result.ok !== true) return ""
  const files = result.meta && Array.isArray(result.meta.files) ? result.meta.files : []
  const parts = files.map((file) => {
    const record = file && typeof file === "object" && !Array.isArray(file) ? file as Record<string, unknown> : {}
    return typeof record.diff === "string" ? record.diff : ""
  }).filter(Boolean)
  return parts.join("\n")
}

// Parse unified diff text (+/- lines; +++/--- headers skipped) into bounded rows.
export function parseDiffLines(diffText: string): DiffLine[] {
  const lines: DiffLine[] = []
  let chars = 0
  let capped = false
  for (const line of diffText.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.length && lines.length && lines[lines.length - 1].text === "") continue
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("@@")) {
      lines.push({ kind: "context", text: line })
      continue
    }
    const kind: DiffLineKind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context"
    const text = kind === "context" ? line.replace(/^ /, "") : line.slice(1)
    if (lines.length >= maxDiffLines || chars + text.length > 12_000) {
      capped = true
      break
    }
    lines.push({ kind, text })
    chars += text.length
  }
  return capped ? [...lines, { kind: "context", text: "…" }] : lines
}

export function diffLineCounts(lines: DiffLine[]) {
  const added = lines.filter((line) => line.kind === "added").length
  const removed = lines.filter((line) => line.kind === "removed").length
  const capped = lines.some((line) => line.text === "…")
  return { added, removed, capped }
}
