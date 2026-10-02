export { escapeAttribute, escapeHtml } from "../html-escape.ts"

export function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function asRecordText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
