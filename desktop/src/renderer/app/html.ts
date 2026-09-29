



export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

export function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}

export function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function asRecordText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
