// Parses the streamed argument text of a tool call (tool_input_delta) so a
// row can show its target before the arguments finish arriving (spec 5.3).
import { partialJsonStrings } from "../../../runtime/dist/protocol/tool-semantics.js"

export const maxInputChars = 60_000

/** Best-effort parse of a possibly truncated JSON object of arguments. */
export function partialArguments(text: string): Record<string, unknown> {
  const source = text.trim()
  if (!source) return {}
  try {
    const parsed: unknown = JSON.parse(source)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { /* Fall through to field extraction for an unfinished object. */ }
  return partialJsonStrings(source)
}

/** Appends a streamed chunk, keeping the buffer bounded. */
export function appendInput(current: string, delta: string, limit = maxInputChars): string {
  const next = current + delta
  return next.length > limit ? next.slice(0, limit) : next
}
