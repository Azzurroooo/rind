// Parses the streamed argument text of a tool call (tool_input_delta) so a
// row can show its target before the arguments finish arriving (spec 5.3).

export const maxInputChars = 60_000

const stringField = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)/g

/** Best-effort parse of a possibly truncated JSON object of arguments. */
export function partialArguments(text: string): Record<string, unknown> {
  const source = text.trim()
  if (!source) return {}
  try {
    const parsed: unknown = JSON.parse(source)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { /* Fall through to field extraction for an unfinished object. */ }
  const fields: Record<string, unknown> = {}
  for (const match of source.matchAll(stringField)) {
    const value = decodeJsonString(match[2])
    if (value !== undefined && !(match[1] in fields)) fields[match[1]] = value
  }
  return fields
}

function decodeJsonString(body: string): string | undefined {
  const safe = body.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/(^|[^\\])(\\\\)*\\$/, "$1$2")
  try {
    const value: unknown = JSON.parse(`"${safe}"`)
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

/** Appends a streamed chunk, keeping the buffer bounded. */
export function appendInput(current: string, delta: string, limit = maxInputChars): string {
  const next = current + delta
  return next.length > limit ? next.slice(0, limit) : next
}
